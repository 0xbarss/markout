use std::{net::SocketAddr, sync::Arc};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use rust_embed::RustEmbed;
use serde_json::json;
use tokio::sync::broadcast::{self, error::RecvError};
use tower_http::{cors::CorsLayer, trace::TraceLayer};

use crate::{
    config::Config,
    event_bus::{EventBus, MarketEvent},
    ingestion::Dataset,
    models::{Bar, Signal, Trade},
    stats::{self, Stats},
};

/// Frontend assets baked into the binary at compile time.
#[derive(RustEmbed)]
#[folder = "web/dist/"]
struct Assets;

#[derive(Clone)]
pub struct AppState {
    pub bus: EventBus,
    pub mode: &'static str,
    pub data: Arc<Dataset>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/bars", get(get_bars))
        .route("/api/v1/trades", get(get_trades))
        .route("/api/v1/signals", get(get_signals))
        .route("/api/v1/stats", get(get_stats))
        .route("/ws/stream", get(ws_stream))
        .fallback(static_handler)
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
        .with_state(state)
}

pub async fn run(config: Config, bus: EventBus, data: Dataset) -> anyhow::Result<()> {
    let state = AppState {
        bus,
        mode: config.mode.name(),
        data: Arc::new(data),
    };
    let addr: SocketAddr = format!("{}:{}", config.host, config.port).parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(
        "markout ({}) listening on http://{}",
        state.mode,
        listener.local_addr()?
    );

    axum::serve(listener, router(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

async fn health(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION"), "mode": state.mode }))
}

async fn get_bars(State(state): State<AppState>) -> Json<Vec<Bar>> {
    Json(state.data.bars.clone())
}

async fn get_trades(State(state): State<AppState>) -> Json<Vec<Trade>> {
    Json(state.data.trades.clone())
}

async fn get_signals(State(state): State<AppState>) -> Json<Vec<Signal>> {
    Json(state.data.signals.clone())
}

async fn get_stats(State(state): State<AppState>) -> Json<Stats> {
    Json(stats::compute(&state.data.trades))
}

async fn ws_stream(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    let rx = state.bus.subscribe();
    let bus = state.bus.clone();
    ws.on_upgrade(move |socket| client_loop(socket, rx, bus))
}

async fn client_loop(
    mut socket: WebSocket,
    mut rx: broadcast::Receiver<MarketEvent>,
    bus: EventBus,
) {
    loop {
        tokio::select! {
            ev = rx.recv() => match ev {
                Ok(ev) => {
                    let Ok(json) = serde_json::to_string(&ev) else { continue };
                    if socket.send(Message::Text(json)).await.is_err() {
                        break;
                    }
                }
                Err(RecvError::Lagged(n)) => tracing::warn!("ws client lagged, skipped {n} events"),
                Err(RecvError::Closed) => break,
            },
            msg = socket.recv() => match msg {
                Some(Ok(Message::Text(text))) => {
                    if let Ok(ev) = serde_json::from_str::<MarketEvent>(&text) {
                        bus.publish(ev);
                    }
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                _ => {}
            },
        }
    }
}

async fn static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if path.starts_with("api/") || path.starts_with("ws/") {
        return StatusCode::NOT_FOUND.into_response();
    }
    let path = if path.is_empty() { "index.html" } else { path };

    if let Some(file) = Assets::get(path) {
        let mime = mime_guess::from_path(path).first_or_octet_stream();
        return ([(header::CONTENT_TYPE, mime.as_ref())], file.data).into_response();
    }
    // SPA fallback
    match Assets::get("index.html") {
        Some(file) => ([(header::CONTENT_TYPE, "text/html")], file.data).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    fn app_with(data: Dataset) -> Router {
        router(AppState {
            bus: EventBus::default(),
            mode: "offline",
            data: Arc::new(data),
        })
    }

    fn app() -> Router {
        app_with(Dataset::default())
    }

    async fn status(uri: &str) -> StatusCode {
        app()
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap()
            .status()
    }

    #[tokio::test]
    async fn health_ok() {
        assert_eq!(status("/api/v1/health").await, StatusCode::OK);
    }

    #[tokio::test]
    async fn root_serves_embedded_index() {
        assert_eq!(status("/").await, StatusCode::OK);
    }

    #[tokio::test]
    async fn bars_endpoint_serves_loaded_data() {
        let bar = Bar {
            time: 1_700_000_000,
            open: 1.0,
            high: 2.0,
            low: 0.5,
            close: 1.5,
            volume: 3.0,
        };
        let res = app_with(Dataset {
            bars: vec![bar],
            trades: vec![],
            signals: vec![],
        })
        .oneshot(
            Request::builder()
                .uri("/api/v1/bars")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let bars: Vec<Bar> = serde_json::from_slice(&body).unwrap();
        assert_eq!(bars, vec![bar]);
    }

    #[tokio::test]
    async fn signals_endpoint_serves_loaded_data() {
        use crate::models::Direction;
        let sig = Signal {
            id: "sig_1".into(),
            time: 1_700_000_000,
            symbol: Some("BTCUSDT".into()),
            direction: Direction::Buy,
            entry_price: 50000.0,
            stop_loss: 49000.0,
            take_profit: 52000.0,
            strategy: Some("Cayenne".into()),
            comment: None,
        };
        let res = app_with(Dataset {
            bars: vec![],
            trades: vec![],
            signals: vec![sig.clone()],
        })
        .oneshot(
            Request::builder()
                .uri("/api/v1/signals")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let signals: Vec<Signal> = serde_json::from_slice(&body).unwrap();
        assert_eq!(signals, vec![sig]);
    }

    #[tokio::test]
    async fn unknown_api_path_is_404() {
        assert_eq!(status("/api/v1/nope").await, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn ws_stream_endpoint_is_present() {
        let res = app()
            .oneshot(
                Request::builder()
                    .uri("/ws/stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(
            res.status() == StatusCode::BAD_REQUEST || res.status() == StatusCode::UPGRADE_REQUIRED
        );
    }
}
