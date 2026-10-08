import type { Bar, MarketEvent, Signal, Stats, Trade } from "./types.ts";

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export interface Health {
  status: string;
  version: string;
  mode: string;
  tf?: number | null;
}

export function loadAll(): Promise<[Bar[], Trade[], Stats, Signal[], Health]> {
  return Promise.all([
    getJSON<Bar[]>("/api/v1/bars"),
    getJSON<Trade[]>("/api/v1/trades"),
    getJSON<Stats>("/api/v1/stats"),
    getJSON<Signal[]>("/api/v1/signals").catch(() => []),
    getJSON<Health>("/api/v1/health").catch(() => ({ status: "ok", version: "unknown", mode: "offline" })),
  ]);
}

export type EventStreamCallback = (event: MarketEvent) => void;

export function connectEventStream(onEvent: EventStreamCallback): () => void {
  if (typeof window === "undefined" || !window.location) {
    return () => {};
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${window.location.host}/ws/stream`;
  let ws: WebSocket | null = null;
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    if (closed) return;
    try {
      ws = new WebSocket(url);
    } catch {
      scheduleRetry();
      return;
    }

    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data as string) as MarketEvent;
        onEvent(parsed);
      } catch (err) {
        console.warn("failed to parse market event:", err);
      }
    };

    ws.onclose = () => {
      if (!closed) scheduleRetry();
    };

    ws.onerror = () => {
      ws?.close();
    };
  }

  function scheduleRetry() {
    if (closed || retryTimer !== null) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, 2000);
  }

  connect();

  return () => {
    closed = true;
    if (retryTimer !== null) clearTimeout(retryTimer);
    ws?.close();
  };
}

