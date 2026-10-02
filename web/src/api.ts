import type { Bar, Stats, Trade } from "./types";

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function loadAll(): Promise<[Bar[], Trade[], Stats]> {
  return Promise.all([
    getJSON<Bar[]>("/api/v1/bars"),
    getJSON<Trade[]>("/api/v1/trades"),
    getJSON<Stats>("/api/v1/stats"),
  ]);
}
