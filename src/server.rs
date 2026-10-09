use std::{
    collections::{HashMap, HashSet, VecDeque},
    net::SocketAddr,
    sync::Arc,
};

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
use tower_http::{
    compression::CompressionLayer, set_header::SetResponseHeaderLayer, trace::TraceLayer,
};

use crate::{
    config::{Config, Mode},
    event_bus::{EventBus, MarketEvent},
    ingestion::Dataset,
    models::{Bar, Signal, StopPoint, Trade},
    stats::{self, Stats},
};

/// Frontend assets baked into the binary at compile time.
#[derive(RustEmbed)]
#[folder = "web/dist/"]
struct Assets;

/// In-memory snapshot for live mode to serve late joiners and page refreshes.
#[derive(Debug, Clone)]
pub struct LiveSnapshot {
    pub bars: VecDeque<Bar>,
    pub trades: HashMap<u64, Trade>,
    pub signals: Vec<Signal>,
    pub symbol: Option<String>,
    pub cap: usize,
}

impl LiveSnapshot {
    pub fn new(cap: usize) -> Self {
        Self {
            bars: VecDeque::new(),
            trades: HashMap::new(),
            signals: Vec::new(),
            symbol: None,
            cap: cap.max(1),
        }
    }

    pub fn apply(&mut self, ev: MarketEvent) {
        match ev {
            MarketEvent::Bar(b) => {
                if let Some(last) = self.bars.back_mut() {
                    if last.time == b.time {
                        *last = b;
                    } else if b.time > last.time {
                        self.bars.push_back(b);
                    } else if let Some(existing) = self.bars.iter_mut().find(|x| x.time == b.time) {
                        *existing = b;
                    } else {
                        let idx = self
                            .bars
                            .iter()
                            .position(|x| x.time > b.time)
                            .unwrap_or(self.bars.len());
                        self.bars.insert(idx, b);
                    }
                } else {
                    self.bars.push_back(b);
                }
                while self.bars.len() > self.cap {
                    self.bars.pop_front();
                }
            }
            MarketEvent::Trade(u) => {
                if self.symbol.is_none() && !u.trade.symbol.is_empty() {
                    self.symbol = Some(u.trade.symbol.clone());
                }
                self.trades.insert(u.trade.id, u.trade);
            }
            MarketEvent::RiskBracket {
                trade_id,
                stop_loss,
                take_profit,
                timestamp,
            } => {
                if let Some(trade) = self.trades.get_mut(&trade_id) {
                    if take_profit.is_some() {
                        trade.take_profit = take_profit;
                    }
                    if let Some(sl) = stop_loss {
                        if let Some(last) = trade.sl_history.last_mut() {
                            if last.time == timestamp {
                                last.price = sl;
                            } else {
                                trade.sl_history.push(StopPoint {
                                    time: timestamp,
                                    price: sl,
                                });
                            }
                        } else {
                            trade.sl_history.push(StopPoint {
                                time: timestamp,
                                price: sl,
                            });
                        }
                    }
                }
            }
            MarketEvent::Signal(s) => {
                if self.symbol.is_none() {
                    if let Some(sym) = &s.symbol {
                        if !sym.is_empty() {
                            self.symbol = Some(sym.clone());
                        }
                    }
                }
                if let Some(existing) = self.signals.iter_mut().find(|x| x.id == s.id) {
                    *existing = s;
                } else {
                    self.signals.push(s);
                }
            }
            MarketEvent::Tick(t) => {
                if self.symbol.is_none() && !t.symbol.is_empty() {
                    self.symbol = Some(t.symbol);
                }
            }
            MarketEvent::Account(_) => {}
        }
    }

    pub fn bars(&self) -> Vec<Bar> {
        self.bars.iter().cloned().collect()
    }

    pub fn trades(&self) -> Vec<Trade> {
        let mut res: Vec<Trade> = self.trades.values().cloned().collect();
        res.sort_by_key(|t| (t.entry_time, t.id));
        res
    }

    pub fn signals(&self) -> Vec<Signal> {
        self.signals.clone()
    }

    pub fn stats(&self) -> Stats {
        stats::compute(&self.trades())
    }
}

#[derive(Clone)]
pub struct AppState {
    pub bus: EventBus,
    pub mode: &'static str,
    pub tf: Option<u64>,
    pub data: Arc<Dataset>,
    pub bars_json: bytes::Bytes,
    pub trades_json: bytes::Bytes,
    pub signals_json: bytes::Bytes,
    pub stats_json: bytes::Bytes,
    pub live_store: Option<Arc<tokio::sync::RwLock<LiveSnapshot>>>,
    pub host: String,
    pub allowed_hosts: Arc<HashSet<String>>,
    pub allowed_origins: Arc<Vec<String>>,
    pub allow_ws_publish: bool,
}

impl AppState {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        bus: EventBus,
        mode: &'static str,
        tf: Option<u64>,
        data: Arc<Dataset>,
        live_store: Option<Arc<tokio::sync::RwLock<LiveSnapshot>>>,
        host: String,
        allowed_hosts: Arc<HashSet<String>>,
        allowed_origins: Arc<Vec<String>>,
        allow_ws_publish: bool,
    ) -> Self {
        let bars_json = bytes::Bytes::from(serde_json::to_vec(&data.bars).unwrap_or_default());
        let trades_json = bytes::Bytes::from(serde_json::to_vec(&data.trades).unwrap_or_default());
        let signals_json =
            bytes::Bytes::from(serde_json::to_vec(&data.signals).unwrap_or_default());
        let stats_json = bytes::Bytes::from(
            serde_json::to_vec(&stats::compute(&data.trades)).unwrap_or_default(),
        );
        Self {
            bus,
            mode,
            tf,
            data,
            bars_json,
            trades_json,
            signals_json,
            stats_json,
            live_store,
            host,
            allowed_hosts,
            allowed_origins,
            allow_ws_publish,
        }
    }
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
        .layer(CompressionLayer::new())
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

pub async fn resolve_host(host: &str, port: u16) -> anyhow::Result<SocketAddr> {
    let clean_host = host.trim_matches(|c| c == '[' || c == ']');
    let addrs = tokio::net::lookup_host((clean_host, port)).await?;
    let mut chosen = None;
    for addr in addrs {
        if chosen.is_none() {
            chosen = Some(addr);
        }
        if addr.ip().is_loopback() && addr.is_ipv4() {
            chosen = Some(addr);
            break;
        }
    }
    chosen.ok_or_else(|| anyhow::anyhow!("cannot resolve host `{host}`"))
}

async fn default_shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(_) => {
                std::future::pending::<()>().await;
            }
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

pub async fn run(config: Config, bus: EventBus, data: Dataset) -> anyhow::Result<()> {
    run_with_shutdown(config, bus, data, default_shutdown_signal()).await
}

pub async fn run_with_shutdown<F>(
    config: Config,
    bus: EventBus,
    data: Dataset,
    shutdown: F,
) -> anyhow::Result<()>
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    let addr = resolve_host(&config.host, config.port).await?;
    let host_is_loopback = addr.ip().is_loopback();
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
        let clean = config
            .host
            .trim_matches(|c| c == '[' || c == ']')
            .to_string();
        allowed_hosts.insert(clean);
    }

    let tf = match &config.mode {
        Mode::Live { tf, .. } => tf.as_deref().and_then(crate::config::parse_timeframe_sec),
        Mode::Replay { tf, .. } => tf.as_deref().and_then(crate::config::parse_timeframe_sec),
        _ => None,
    };

    let live_store = match &config.mode {
        Mode::Live { feed, symbol, .. } => {
            if let Some(f) = feed {
                tracing::warn!(
                    "--feed `{}` is not implemented; events must be published to WebSocket or bus",
                    f
                );
            }
            let mut snapshot = LiveSnapshot::new(50_000);
            if let Some(s) = symbol {
                snapshot.symbol = Some(s.clone());
            }
            for b in &data.bars {
                snapshot.apply(MarketEvent::Bar(*b));
            }
            for t in &data.trades {
                snapshot.apply(MarketEvent::Trade(crate::models::TradeUpdate {
                    kind: crate::models::TradeUpdateKind::Entry,
                    trade: t.clone(),
                }));
            }
            for s in &data.signals {
                snapshot.apply(MarketEvent::Signal(s.clone()));
            }
            let store = Arc::new(tokio::sync::RwLock::new(snapshot));
            let store_clone = store.clone();
            let mut rx = bus.subscribe();
            tokio::spawn(async move {
                loop {
                    match rx.recv().await {
                        Ok(ev) => {
                            store_clone.write().await.apply(ev);
                        }
                        Err(RecvError::Lagged(n)) => {
                            tracing::warn!("live snapshot lagged, skipped {n} events");
                        }
                        Err(RecvError::Closed) => break,
                    }
                }
            });
            Some(store)
        }
        Mode::Replay { speed, .. } => {
            let mut engine = crate::replay::ReplayEngine::new(data.bars.clone());
            let _ = engine.set_speed(*speed);
            let mut snapshot = LiveSnapshot::new(50_000);
            if let Some(first) = data.bars.first() {
                snapshot.apply(MarketEvent::Bar(*first));
                bus.publish(MarketEvent::Bar(*first));
            }
            let store = Arc::new(tokio::sync::RwLock::new(snapshot));
            let store_clone = store.clone();
            let bus_replay = bus.clone();
            let spd = *speed;
            tokio::spawn(async move {
                let interval_ms = (1000 / spd.max(1)).max(10) as u64;
                let mut ticker =
                    tokio::time::interval(std::time::Duration::from_millis(interval_ms));
                while let Some(ev) = engine.publish_next(&bus_replay) {
                    ticker.tick().await;
                    store_clone.write().await.apply(ev);
                }
            });
            Some(store)
        }
        _ => None,
    };

    let state = AppState::new(
        bus,
        config.mode.name(),
        tf,
        Arc::new(data),
        live_store,
        config.host.clone(),
        Arc::new(allowed_hosts),
        Arc::new(config.allow_origins),
        config.allow_ws_publish,
    );
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(
        "markout ({}) listening on http://{}",
        state.mode,
        listener.local_addr()?
    );

    axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown)
        .await?;
    Ok(())
}

async fn health(State(state): State<AppState>) -> Json<serde_json::Value> {
    let mut payload =
        json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION"), "mode": state.mode });
    if let Some(tf) = state.tf {
        payload["tf"] = json!(tf);
    }
    if let Some(store) = &state.live_store {
        if let Some(sym) = &store.read().await.symbol {
            payload["symbol"] = json!(sym);
        }
    }
    Json(payload)
}

async fn get_bars(State(state): State<AppState>) -> Response {
    if let Some(store) = &state.live_store {
        Json(store.read().await.bars()).into_response()
    } else {
        (
            [(header::CONTENT_TYPE, "application/json")],
            state.bars_json.clone(),
        )
            .into_response()
    }
}

async fn get_trades(State(state): State<AppState>) -> Response {
    if let Some(store) = &state.live_store {
        Json(store.read().await.trades()).into_response()
    } else {
        (
            [(header::CONTENT_TYPE, "application/json")],
            state.trades_json.clone(),
        )
            .into_response()
    }
}

async fn get_signals(State(state): State<AppState>) -> Response {
    if let Some(store) = &state.live_store {
        Json(store.read().await.signals()).into_response()
    } else {
        (
            [(header::CONTENT_TYPE, "application/json")],
            state.signals_json.clone(),
        )
            .into_response()
    }
}

async fn get_stats(State(state): State<AppState>) -> Response {
    if let Some(store) = &state.live_store {
        Json(store.read().await.stats()).into_response()
    } else {
        (
            [(header::CONTENT_TYPE, "application/json")],
            state.stats_json.clone(),
        )
            .into_response()
    }
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
        let state = AppState::new(
            bus.clone(),
            "offline",
            None,
            Arc::new(data),
            None,
            "127.0.0.1".into(),
            Arc::new(allowed_hosts.iter().map(|s| s.to_string()).collect()),
            Arc::new(allowed_origins.iter().map(|s| s.to_string()).collect()),
            allow_ws_publish,
        );
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
    async fn health_live_with_timeframe_returns_tf() {
        let bus = EventBus::default();
        let state = AppState::new(
            bus,
            "live",
            Some(900),
            Arc::new(Dataset::default()),
            None,
            "127.0.0.1".into(),
            Arc::new(HashSet::new()),
            Arc::new(Vec::new()),
            false,
        );
        let res = router(state)
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
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["mode"], "live");
        assert_eq!(body["tf"], 900);
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

    #[tokio::test]
    async fn resolve_host_supports_hostnames_and_ipv6() {
        let addr_v4 = resolve_host("127.0.0.1", 8080).await.unwrap();
        assert_eq!(addr_v4, "127.0.0.1:8080".parse::<SocketAddr>().unwrap());

        let addr_localhost = resolve_host("localhost", 8080).await.unwrap();
        assert!(addr_localhost.ip().is_loopback());
        assert_eq!(addr_localhost.port(), 8080);

        let addr_v6 = resolve_host("::1", 8080).await.unwrap();
        assert_eq!(addr_v6, "[::1]:8080".parse::<SocketAddr>().unwrap());

        let addr_v6_bracketed = resolve_host("[::1]", 8080).await.unwrap();
        assert_eq!(
            addr_v6_bracketed,
            "[::1]:8080".parse::<SocketAddr>().unwrap()
        );

        let err = resolve_host("invalid-host-name-markout-does-not-exist.test", 8080).await;
        assert!(err.is_err());
    }

    #[test]
    fn live_snapshot_bars_replace_and_evict() {
        let mut snapshot = LiveSnapshot::new(2);
        let b1 = Bar {
            time: 100,
            open: 1.0,
            high: 2.0,
            low: 0.5,
            close: 1.5,
            volume: 10.0,
        };
        let b2 = Bar {
            time: 200,
            open: 1.5,
            high: 2.5,
            low: 1.0,
            close: 2.0,
            volume: 20.0,
        };
        snapshot.apply(MarketEvent::Bar(b1));
        snapshot.apply(MarketEvent::Bar(b2));
        assert_eq!(snapshot.bars().len(), 2);
        assert_eq!(snapshot.bars()[0].time, 100);

        // Replace bar with same timestamp
        let b2_updated = Bar {
            time: 200,
            open: 1.5,
            high: 3.0,
            low: 1.0,
            close: 2.8,
            volume: 25.0,
        };
        snapshot.apply(MarketEvent::Bar(b2_updated));
        assert_eq!(snapshot.bars().len(), 2);
        assert_eq!(snapshot.bars()[1].close, 2.8);

        // Capacity eviction: adding 3rd bar drops the 1st bar (time 100)
        let b3 = Bar {
            time: 300,
            open: 2.8,
            high: 3.5,
            low: 2.5,
            close: 3.0,
            volume: 15.0,
        };
        snapshot.apply(MarketEvent::Bar(b3));
        let bars = snapshot.bars();
        assert_eq!(bars.len(), 2);
        assert_eq!(bars[0].time, 200);
        assert_eq!(bars[1].time, 300);
    }

    #[test]
    fn live_snapshot_trades_and_risk_bracket() {
        use crate::models::{TradeSide, TradeUpdate, TradeUpdateKind};
        let mut snapshot = LiveSnapshot::new(100);
        let trade = Trade {
            id: 42,
            symbol: "BTCUSDT".into(),
            direction: TradeSide::Buy,
            size: 1.0,
            entry_time: 1_700_000_000,
            entry_price: 50_000.0,
            exit_time: None,
            exit_price: None,
            exit_reason: None,
            initial_sl: 49_000.0,
            take_profit: Some(52_000.0),
            sl_history: vec![],
            pnl: 0.0,
            r_multiple: 0.0,
            fee: 1.5,
            mae_pct: None,
            mfe_pct: None,
        };
        snapshot.apply(MarketEvent::Trade(TradeUpdate {
            kind: TradeUpdateKind::Entry,
            trade,
        }));
        assert_eq!(snapshot.trades().len(), 1);
        assert_eq!(snapshot.symbol.as_deref(), Some("BTCUSDT"));

        // Apply risk bracket update
        snapshot.apply(MarketEvent::RiskBracket {
            trade_id: 42,
            stop_loss: Some(49_500.0),
            take_profit: Some(53_000.0),
            timestamp: 1_700_000_100,
        });
        let trades = snapshot.trades();
        assert_eq!(trades[0].take_profit, Some(53_000.0));
        assert_eq!(trades[0].sl_history.len(), 1);
        assert_eq!(trades[0].sl_history[0].price, 49_500.0);

        // Same timestamp update modifies price instead of appending
        snapshot.apply(MarketEvent::RiskBracket {
            trade_id: 42,
            stop_loss: Some(49_600.0),
            take_profit: None,
            timestamp: 1_700_000_100,
        });
        let trades = snapshot.trades();
        assert_eq!(trades[0].sl_history.len(), 1);
        assert_eq!(trades[0].sl_history[0].price, 49_600.0);

        // Different timestamp appends to history
        snapshot.apply(MarketEvent::RiskBracket {
            trade_id: 42,
            stop_loss: Some(49_800.0),
            take_profit: None,
            timestamp: 1_700_000_200,
        });
        let trades = snapshot.trades();
        assert_eq!(trades[0].sl_history.len(), 2);
        assert_eq!(trades[0].sl_history[1].price, 49_800.0);
    }

    #[tokio::test]
    async fn live_endpoints_serve_late_joiners_from_snapshot() {
        use crate::models::{Direction, TradeSide, TradeUpdate, TradeUpdateKind};

        let bus = EventBus::default();
        let snapshot = LiveSnapshot::new(50_000);
        let store = Arc::new(tokio::sync::RwLock::new(snapshot));
        let store_clone = store.clone();
        let mut rx = bus.subscribe();

        tokio::spawn(async move {
            while let Ok(ev) = rx.recv().await {
                store_clone.write().await.apply(ev);
            }
        });

        let state = AppState::new(
            bus.clone(),
            "live",
            Some(60),
            Arc::new(Dataset::default()),
            Some(store),
            "127.0.0.1".into(),
            Arc::new(HashSet::new()),
            Arc::new(Vec::new()),
            false,
        );
        let app = router(state);

        // Publish 3 bars
        for i in 1..=3 {
            bus.publish(MarketEvent::Bar(Bar {
                time: i * 60,
                open: 100.0 + i as f64,
                high: 105.0 + i as f64,
                low: 99.0 + i as f64,
                close: 103.0 + i as f64,
                volume: 50.0,
            }));
        }

        // Publish 1 trade
        bus.publish(MarketEvent::Trade(TradeUpdate {
            kind: TradeUpdateKind::Entry,
            trade: Trade {
                id: 10,
                symbol: "ETHUSDT".into(),
                direction: TradeSide::Buy,
                size: 2.0,
                entry_time: 60,
                entry_price: 3000.0,
                exit_time: None,
                exit_price: None,
                exit_reason: None,
                initial_sl: 2900.0,
                take_profit: Some(3200.0),
                sl_history: vec![],
                pnl: 0.0,
                r_multiple: 0.0,
                fee: 2.0,
                mae_pct: None,
                mfe_pct: None,
            },
        }));

        // Publish 1 signal
        bus.publish(MarketEvent::Signal(Signal {
            id: "sig_live_1".into(),
            time: 60,
            symbol: Some("ETHUSDT".into()),
            direction: Direction::Buy,
            entry_price: 3000.0,
            stop_loss: 2900.0,
            take_profit: 3200.0,
            strategy: Some("TrendFollower".into()),
            comment: None,
        }));

        // Yield to allow background task to process events
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // Verify GET /api/v1/bars
        let res_bars = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/bars")
                    .header(header::HOST, "127.0.0.1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res_bars.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res_bars.into_body(), usize::MAX)
            .await
            .unwrap();
        let bars: Vec<Bar> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(bars.len(), 3);
        assert_eq!(bars[0].time, 60);
        assert_eq!(bars[2].time, 180);

        // Verify GET /api/v1/trades
        let res_trades = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/trades")
                    .header(header::HOST, "127.0.0.1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res_trades.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res_trades.into_body(), usize::MAX)
            .await
            .unwrap();
        let trades: Vec<Trade> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(trades.len(), 1);
        assert_eq!(trades[0].id, 10);

        // Verify GET /api/v1/signals
        let res_signals = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/signals")
                    .header(header::HOST, "127.0.0.1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res_signals.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res_signals.into_body(), usize::MAX)
            .await
            .unwrap();
        let signals: Vec<Signal> = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(signals.len(), 1);
        assert_eq!(signals[0].id, "sig_live_1");

        // Verify GET /api/v1/health has symbol and mode
        let res_health = app
            .oneshot(
                Request::builder()
                    .uri("/api/v1/health")
                    .header(header::HOST, "127.0.0.1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res_health.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res_health.into_body(), usize::MAX)
            .await
            .unwrap();
        let health: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(health["mode"], "live");
        assert_eq!(health["symbol"], "ETHUSDT");
    }

    #[tokio::test]
    async fn replay_mode_drives_engine_and_bus() {
        let bus = EventBus::default();
        let mut rx = bus.subscribe();

        let bars = vec![
            Bar {
                time: 100,
                open: 1.0,
                high: 2.0,
                low: 0.5,
                close: 1.5,
                volume: 10.0,
            },
            Bar {
                time: 200,
                open: 1.5,
                high: 2.5,
                low: 1.0,
                close: 2.0,
                volume: 20.0,
            },
            Bar {
                time: 300,
                open: 2.0,
                high: 3.0,
                low: 1.8,
                close: 2.5,
                volume: 30.0,
            },
        ];

        let mut engine = crate::replay::ReplayEngine::new(bars.clone());
        let _ = engine.set_speed(100);
        let mut snapshot = LiveSnapshot::new(50_000);
        if let Some(first) = bars.first() {
            snapshot.apply(MarketEvent::Bar(*first));
            bus.publish(MarketEvent::Bar(*first));
        }

        let store = Arc::new(tokio::sync::RwLock::new(snapshot));
        let store_clone = store.clone();
        let bus_replay = bus.clone();

        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_millis(10));
            while let Some(ev) = engine.publish_next(&bus_replay) {
                ticker.tick().await;
                store_clone.write().await.apply(ev);
            }
        });

        // First bar is received immediately
        let ev0 = rx.recv().await.unwrap();
        assert_eq!(ev0, MarketEvent::Bar(bars[0]));

        // Second and third bars are emitted by the replay engine
        let ev1 = rx.recv().await.unwrap();
        assert_eq!(ev1, MarketEvent::Bar(bars[1]));

        let ev2 = rx.recv().await.unwrap();
        assert_eq!(ev2, MarketEvent::Bar(bars[2]));

        // Snapshot retains all 3 bars
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert_eq!(store.read().await.bars().len(), 3);
    }

    #[tokio::test]
    async fn gzip_compression_on_accept_encoding() {
        use std::io::Read;
        let bar = Bar {
            time: 1_700_000_000,
            open: 1.0,
            high: 2.0,
            low: 0.5,
            close: 1.5,
            volume: 3.0,
        };
        let app = app_with(Dataset {
            bars: vec![bar],
            trades: vec![],
            signals: vec![],
        });
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/v1/bars")
                    .header(header::HOST, "127.0.0.1")
                    .header(header::ACCEPT_ENCODING, "gzip")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(
            res.headers()
                .get(header::CONTENT_ENCODING)
                .and_then(|v| v.to_str().ok()),
            Some("gzip")
        );
        let compressed = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        let mut decoder = flate2::read::GzDecoder::new(&compressed[..]);
        let mut decompressed = Vec::new();
        decoder.read_to_end(&mut decompressed).unwrap();
        let bars: Vec<Bar> = serde_json::from_slice(&decompressed).unwrap();
        assert_eq!(bars, vec![bar]);
    }

    #[tokio::test]
    async fn run_with_shutdown_terminates_cleanly() {
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let config = Config {
            host: "127.0.0.1".into(),
            port: 0, // let OS pick an ephemeral port
            allow_hosts: vec![],
            allow_origins: vec![],
            allow_ws_publish: false,
            lenient: false,
            mode: Mode::Offline {
                trades: None,
                bars: None,
                strategy: None,
            },
        };
        let bus = EventBus::default();
        let server_handle = tokio::spawn(async move {
            run_with_shutdown(config, bus, Dataset::default(), async move {
                let _ = rx.await;
            })
            .await
        });

        // Trigger shutdown
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let _ = tx.send(());

        let res = tokio::time::timeout(std::time::Duration::from_secs(2), server_handle).await;
        assert!(res.is_ok(), "server did not shut down within timeout");
        let inner = res.unwrap().unwrap();
        assert!(inner.is_ok(), "server returned error: {inner:?}");
    }
}
