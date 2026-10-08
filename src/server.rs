use std::{collections::HashSet, net::SocketAddr, sync::Arc};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Request, State,
    },
    http::{
        header::{self, HeaderName},
        HeaderMap, HeaderValue, StatusCode, Uri,
    },
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use rust_embed::RustEmbed;
use serde_json::json;
use tokio::sync::broadcast::{self, error::RecvError};
use tower_http::{set_header::SetResponseHeaderLayer, trace::TraceLayer};

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
    pub host: String,
    pub allowed_hosts: Arc<HashSet<String>>,
    pub allowed_origins: Arc<Vec<String>>,
    pub allow_ws_publish: bool,
}

pub fn router(state: AppState) -> Router {
    const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
                       img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:; \
                       object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

    Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/bars", get(get_bars))
        .route("/api/v1/trades", get(get_trades))
        .route("/api/v1/signals", get(get_signals))
        .route("/api/v1/stats", get(get_stats))
        .route("/ws/stream", get(ws_stream))
        .fallback(static_handler)
        .layer(TraceLayer::new_for_http())
        .layer(middleware::from_fn_with_state(
            state.clone(),
            require_allowed_host,
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("content-security-policy"),
            HeaderValue::from_static(CSP),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ))
        .with_state(state)
}

async fn require_allowed_host(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let host_ok = req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .map(|h| {
            let name = if let Some(stripped) = h.strip_prefix('[') {
                stripped.split_once(']').map(|(n, _)| n).unwrap_or(h)
            } else {
                h.rsplit_once(':').map(|(n, _)| n).unwrap_or(h)
            };
            let name = name.trim_matches(|c| c == '[' || c == ']');
            matches!(name, "127.0.0.1" | "localhost" | "::1") || state.allowed_hosts.contains(name)
        })
        .unwrap_or(false);

    if !host_ok {
        return StatusCode::FORBIDDEN.into_response();
    }

    if req.uri().path().starts_with("/ws") && !origin_allowed(req.headers(), &state.allowed_origins)
    {
        return StatusCode::FORBIDDEN.into_response();
    }

    next.run(req).await
}

pub async fn run(config: Config, bus: EventBus, data: Dataset) -> anyhow::Result<()> {
    let host_is_loopback = matches!(config.host.as_str(), "127.0.0.1" | "localhost" | "::1");
    if !host_is_loopback {
        tracing::warn!(
            "listening on non-loopback address {}; no authentication is configured",
            config.host
        );
    }

    let mut allowed_hosts = HashSet::new();
    for h in &config.allow_hosts {
        allowed_hosts.insert(h.clone());
    }
    if !matches!(config.host.as_str(), "0.0.0.0" | "::") {
        allowed_hosts.insert(config.host.clone());
    }

    let state = AppState {
        bus,
        mode: config.mode.name(),
        data: Arc::new(data),
        host: config.host.clone(),
        allowed_hosts: Arc::new(allowed_hosts),
        allowed_origins: Arc::new(config.allow_origins),
        allow_ws_publish: config.allow_ws_publish,
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

fn origin_allowed(h: &HeaderMap, extra: &[String]) -> bool {
    let Some(origin) = h.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return true;
    };
    if extra.iter().any(|o| o == origin) {
        return true;
    }
    let host = h.get(header::HOST).and_then(|v| v.to_str().ok());
    let origin_host = origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"));
    host.is_some() && origin_host == host
}

async fn ws_stream(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    State(state): State<AppState>,
) -> Response {
    if !origin_allowed(&headers, &state.allowed_origins) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let rx = state.bus.subscribe();
    let bus = state.bus.clone();
    let publish = state.allow_ws_publish;
    ws.max_message_size(64 * 1024)
        .on_upgrade(move |socket| client_loop(socket, rx, bus, publish))
}

async fn client_loop(
    mut socket: WebSocket,
    mut rx: broadcast::Receiver<MarketEvent>,
    bus: EventBus,
    publish: bool,
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
                    handle_inbound_text(&text, &bus, publish);
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                _ => {}
            },
        }
    }
}

fn handle_inbound_text(text: &str, bus: &EventBus, publish: bool) {
    if !publish {
        return;
    }
    match serde_json::from_str::<MarketEvent>(text) {
        Ok(ev) if ev.is_valid() => {
            bus.publish(ev);
        }
        Ok(_) => tracing::warn!("rejected invalid inbound event"),
        Err(e) => tracing::warn!("bad inbound frame: {e}"),
    }
}

async fn static_handler(uri: Uri) -> Response {
    let raw_path = uri.path().trim_start_matches('/');
    if raw_path == "api"
        || raw_path.starts_with("api/")
        || raw_path == "ws"
        || raw_path.starts_with("ws/")
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    let is_index = raw_path.is_empty() || raw_path == "index.html";
    let lookup_path = if is_index { "index.html" } else { raw_path };

    if let Some(file) = Assets::get(lookup_path) {
        let mime = mime_guess::from_path(lookup_path).first_or_octet_stream();
        let cache_control = if lookup_path.starts_with("assets/") {
            "public, max-age=31536000, immutable"
        } else if is_index {
            "no-cache"
        } else {
            ""
        };

        let mut res = ([(header::CONTENT_TYPE, mime.as_ref())], file.data).into_response();
        if !cache_control.is_empty() {
            res.headers_mut().insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static(cache_control),
            );
        }
        return res;
    }

    let has_extension = std::path::Path::new(lookup_path).extension().is_some();
    if lookup_path.starts_with("assets/") || has_extension {
        return StatusCode::NOT_FOUND.into_response();
    }

    // SPA fallback
    match Assets::get("index.html") {
        Some(file) => {
            let mut res = ([(header::CONTENT_TYPE, "text/html")], file.data).into_response();
            res.headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
            res
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use tower::ServiceExt;

    fn app_with(data: Dataset) -> Router {
        app_with_options(data, &[], &[], false).0
    }

    fn app_with_options(
        data: Dataset,
        allowed_hosts: &[&str],
        allowed_origins: &[&str],
        allow_ws_publish: bool,
    ) -> (Router, EventBus) {
        let bus = EventBus::default();
        let state = AppState {
            bus: bus.clone(),
            mode: "offline",
            data: Arc::new(data),
            host: "127.0.0.1".into(),
            allowed_hosts: Arc::new(allowed_hosts.iter().map(|s| s.to_string()).collect()),
            allowed_origins: Arc::new(allowed_origins.iter().map(|s| s.to_string()).collect()),
            allow_ws_publish,
        };
        (router(state), bus)
    }

    fn app() -> Router {
        app_with(Dataset::default())
    }

    async fn status(uri: &str) -> StatusCode {
        app()
            .oneshot(
                Request::builder()
                    .uri(uri)
                    .header(header::HOST, "127.0.0.1")
                    .body(Body::empty())
                    .unwrap(),
            )
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
                .header(header::HOST, "127.0.0.1")
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
                .header(header::HOST, "127.0.0.1")
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
                    .header(header::HOST, "127.0.0.1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(
            res.status() == StatusCode::BAD_REQUEST || res.status() == StatusCode::UPGRADE_REQUIRED
        );
    }

    #[tokio::test]
    async fn host_check_blocks_foreign_host() {
        let res = app()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/trades")
                    .header(header::HOST, "evil.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn host_check_allows_whitelisted_host() {
        let (app, _) = app_with_options(Dataset::default(), &["myhost.lan"], &[], false);
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/v1/health")
                    .header(header::HOST, "myhost.lan:8080")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn cors_headers_are_absent() {
        let res = app()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/trades")
                    .header(header::HOST, "127.0.0.1")
                    .header(header::ORIGIN, "https://evil.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert!(!res
            .headers()
            .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
    }

    #[tokio::test]
    async fn ws_foreign_origin_is_forbidden() {
        let res = app()
            .oneshot(
                Request::builder()
                    .uri("/ws/stream")
                    .header(header::HOST, "127.0.0.1")
                    .header(header::ORIGIN, "https://evil.example")
                    .header(header::CONNECTION, "Upgrade")
                    .header(header::UPGRADE, "websocket")
                    .header(header::SEC_WEBSOCKET_VERSION, "13")
                    .header(header::SEC_WEBSOCKET_KEY, "dGhlIHNhbXBsZSBub25jZQ==")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn ws_same_origin_and_whitelisted_origin_pass() {
        // Same origin: Origin matches Host
        let res_same = app()
            .oneshot(
                Request::builder()
                    .uri("/ws/stream")
                    .header(header::HOST, "localhost:8080")
                    .header(header::ORIGIN, "http://localhost:8080")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_ne!(res_same.status(), StatusCode::FORBIDDEN);

        // Whitelisted origin
        let (app_whitelist, _) =
            app_with_options(Dataset::default(), &[], &["https://allowed.example"], false);
        let res_white = app_whitelist
            .oneshot(
                Request::builder()
                    .uri("/ws/stream")
                    .header(header::HOST, "127.0.0.1")
                    .header(header::ORIGIN, "https://allowed.example")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_ne!(res_white.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn inbound_ws_publishing_validation() {
        let bus = EventBus::new(8);
        let mut rx = bus.subscribe();

        let valid_json = serde_json::json!({
            "type": "bar",
            "data": {
                "time": 1700000000,
                "open": 10.0,
                "high": 12.0,
                "low": 9.0,
                "close": 11.0,
                "volume": 100.0
            }
        })
        .to_string();

        let invalid_json = serde_json::json!({
            "type": "bar",
            "data": {
                "time": 1700000000,
                "open": 10.0,
                "high": 8.0,
                "low": 12.0,
                "close": 11.0,
                "volume": 100.0
            }
        })
        .to_string();

        // 1. When publishing is disabled: valid event is dropped
        handle_inbound_text(&valid_json, &bus, false);
        assert!(rx.try_recv().is_err());

        // 2. When publishing is enabled: invalid event (low > high) is dropped
        handle_inbound_text(&invalid_json, &bus, true);
        assert!(rx.try_recv().is_err());

        // 3. When publishing is enabled: valid event is published
        handle_inbound_text(&valid_json, &bus, true);
        let received = rx.try_recv().expect("event should be received");
        match received {
            MarketEvent::Bar(b) => {
                assert_eq!(b.time, 1700000000);
                assert_eq!(b.close, 11.0);
            }
            _ => panic!("unexpected event variant"),
        }
    }

    #[tokio::test]
    async fn security_headers_present_on_endpoints() {
        let res = app()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/health")
                    .header(header::HOST, "127.0.0.1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            res.headers().get(header::X_CONTENT_TYPE_OPTIONS).unwrap(),
            "nosniff"
        );
        assert_eq!(
            res.headers().get(header::REFERRER_POLICY).unwrap(),
            "no-referrer"
        );
        let csp = res
            .headers()
            .get("content-security-policy")
            .unwrap()
            .to_str()
            .unwrap();
        assert!(csp.contains("default-src 'self'"));
        assert!(csp.contains("frame-ancestors 'none'"));
    }

    #[tokio::test]
    async fn api_and_ws_prefixes_without_slash_return_404() {
        assert_eq!(status("/api").await, StatusCode::NOT_FOUND);
        assert_eq!(status("/api/").await, StatusCode::NOT_FOUND);
        assert_eq!(status("/ws").await, StatusCode::NOT_FOUND);
        assert_eq!(status("/ws/").await, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn missing_assets_with_extensions_return_404() {
        assert_eq!(status("/assets/missing.js").await, StatusCode::NOT_FOUND);
        assert_eq!(status("/fonts/missing.woff2").await, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn cache_control_and_spa_fallback() {
        // Root / index gets no-cache
        let res_root = app()
            .oneshot(
                Request::builder()
                    .uri("/")
                    .header(header::HOST, "127.0.0.1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res_root.status(), StatusCode::OK);
        assert_eq!(
            res_root.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-cache"
        );

        // SPA route fallback (extensionless) gets 200 with no-cache
        let res_spa = app()
            .oneshot(
                Request::builder()
                    .uri("/replay")
                    .header(header::HOST, "127.0.0.1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res_spa.status(), StatusCode::OK);
        assert_eq!(
            res_spa.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-cache"
        );
        assert_eq!(
            res_spa.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/html"
        );

        // Hashed asset in assets/ (find existing asset from embed)
        let asset_name = Assets::iter()
            .find(|p| p.starts_with("assets/"))
            .expect("should have at least one asset in assets/");
        let res_asset = app()
            .oneshot(
                Request::builder()
                    .uri(format!("/{}", asset_name))
                    .header(header::HOST, "127.0.0.1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res_asset.status(), StatusCode::OK);
        assert_eq!(
            res_asset.headers().get(header::CACHE_CONTROL).unwrap(),
            "public, max-age=31536000, immutable"
        );
    }
}
