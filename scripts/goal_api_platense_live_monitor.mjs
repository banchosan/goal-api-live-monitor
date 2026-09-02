#!/usr/bin/env node
/** Persistent GOAL API WebSocket monitor for Defensa y Justicia vs Platense. */

import fs from "node:fs";
import path from "node:path";

const FIXTURE_ID = "cmt1fhw1l77a6pd078djgps37";
const BASE_URL = "https://api.goal-api.com/v1";
const WS_URL = "wss://api.goal-api.com/ws";
const PROJECT_DIR = path.dirname(new URL(import.meta.url).pathname);
const ENV_FILE = path.join(PROJECT_DIR, ".env");
const OUTPUT_DIR = path.join(PROJECT_DIR, "data", "goal_api_test", "platense_monitor");
const SESSION_FILE = path.join(OUTPUT_DIR, "session.json");
const EVENTS_FILE = path.join(OUTPUT_DIR, "events.jsonl");
const RECONNECTS_FILE = path.join(OUTPUT_DIR, "reconnects.jsonl");
const LATEST_FILE = path.join(OUTPUT_DIR, "latest.json");
const FINAL_FILE = path.join(OUTPUT_DIR, "final.json");
const REST_INTERVAL_MS = 5 * 60 * 1000;
const MAX_BACKOFF_MS = 30_000;

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function loadEnv(filename) {
  if (!fs.existsSync(filename)) return;
  for (const raw of fs.readFileSync(filename, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnv(ENV_FILE);
const apiKey = process.env.GOAL_API_KEY;
if (!apiKey) throw new Error("GOAL_API_KEYが.envにありません");

const headers = {
  Authorization: `Bearer ${apiKey}`,
  Accept: "application/json",
  "User-Agent": "GOAL-API-Platense-Live-Monitor/1.0",
};
const startedAt = new Date().toISOString();
let stopped = false;
let socket = null;
let reconnectAttempt = 0;
let requestCount = 0;
let subscriptionConfirmed = false;
let lastUpdate = null;
let restTimer = null;

function appendJsonl(filename, value) {
  fs.appendFileSync(filename, JSON.stringify(value) + "\n", "utf8");
}

function saveJson(filename, value) {
  const temporary = `${filename}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(temporary, filename);
}

function terminalStatus(value) {
  const status = String(value ?? "").toUpperCase();
  return ["FT", "FINISHED", "AFTER_ET", "AFTER_PEN", "CANCELLED", "ABANDONED", "AWARDED"].includes(status);
}

async function apiRequest(endpoint, options = {}) {
  requestCount += 1;
  const response = await fetch(`${BASE_URL}${endpoint}`, { ...options, headers: { ...headers, ...(options.headers ?? {}) } });
  const text = await response.text();
  if (!response.ok) throw new Error(`${endpoint} HTTP ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function restSnapshot(reason) {
  try {
    const payload = await apiRequest(`/fixtures/${FIXTURE_ID}`);
    const record = { type: "rest_snapshot", reason, receivedAt: new Date().toISOString(), payload };
    appendJsonl(EVENTS_FILE, record);
    saveJson(LATEST_FILE, record);
    const fixture = payload?.data ?? payload?.response ?? payload;
    const status = fixture?.matchStatus ?? fixture?.status?.short ?? fixture?.status;
    if (terminalStatus(status)) await finish("REST terminal status", record);
    return record;
  } catch (error) {
    appendJsonl(EVENTS_FILE, { type: "rest_error", reason, receivedAt: new Date().toISOString(), error: String(error) });
    return null;
  }
}

async function mintToken() {
  const payload = await apiRequest("/ws/token", { method: "POST" });
  if (!payload?.data?.token) throw new Error("ws/tokenレスポンスにtokenがありません");
  return payload.data.token;
}

async function finish(reason, finalRecord = lastUpdate) {
  if (stopped) return;
  stopped = true;
  if (restTimer) clearInterval(restTimer);
  try { socket?.close(1000, "monitor finished"); } catch {}
  const result = {
    fixtureId: FIXTURE_ID,
    match: "Defensa y Justicia vs Platense",
    startedAt,
    finishedAt: new Date().toISOString(),
    reason,
    requestCount,
    lastUpdate: finalRecord,
  };
  saveJson(FINAL_FILE, result);
  console.log(`監視終了: ${reason}`);
  console.log(`最終保存: ${FINAL_FILE}`);
  setTimeout(() => process.exit(0), 100);
}

function scheduleReconnect(reason) {
  if (stopped) return;
  reconnectAttempt += 1;
  const base = Math.min(1000 * 2 ** Math.min(reconnectAttempt - 1, 5), MAX_BACKOFF_MS);
  const delay = base + Math.floor(Math.random() * 500);
  const record = { type: "reconnect_scheduled", at: new Date().toISOString(), reason, attempt: reconnectAttempt, delayMs: delay };
  appendJsonl(RECONNECTS_FILE, record);
  console.log(`再接続を${delay}ms後に実行: ${reason}`);
  setTimeout(connect, delay);
}

async function connect() {
  if (stopped) return;
  subscriptionConfirmed = false;
  try {
    await restSnapshot(reconnectAttempt === 0 ? "startup" : "reconnect_gap_fill");
    if (stopped) return;
    const token = await mintToken();
    socket = new WebSocket(`${WS_URL}?wsToken=${encodeURIComponent(token)}`);
    let authenticated = false;
    socket.addEventListener("open", () => {
      appendJsonl(RECONNECTS_FILE, { type: "socket_open", at: new Date().toISOString(), attempt: reconnectAttempt });
      socket.send(JSON.stringify({ type: "auth", token }));
    });
    socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { message = { type: "unparsed", raw: String(event.data) }; }
      const record = { type: "websocket_message", receivedAt: new Date().toISOString(), message };
      appendJsonl(EVENTS_FILE, record);
      lastUpdate = record;
      saveJson(LATEST_FILE, record);
      if (message.type === "auth_success") {
        authenticated = true;
        reconnectAttempt = 0;
        socket.send(JSON.stringify({ type: "subscribe", resource: "match", matchId: FIXTURE_ID }));
        console.log(`認証成功: plan=${message.data?.plan} maxConnections=${message.data?.maxConnections} maxSubscriptions=${message.data?.maxSubscriptions}`);
      } else if (message.type === "subscribe_response") {
        subscriptionConfirmed = message.success === true;
        console.log(`subscribe: ${message.success ? "成功" : "失敗"} fixture=${FIXTURE_ID}`);
        if (!message.success) scheduleReconnect(`subscribe failed: ${JSON.stringify(message.error ?? message.data ?? {})}`);
      } else if (message.type === "match_update") {
        const data = message.data ?? {};
        console.log(`${record.receivedAt} | ${data.match_status ?? "?"}' | ${data.match_hometeam_name} ${data.match_hometeam_score}-${data.match_awayteam_score} ${data.match_awayteam_name}`);
        if (terminalStatus(data.match_status) || String(data.match_live) === "0") void finish("WebSocket terminal status", record);
      } else if (message.type === "error") {
        console.error(`WebSocket server error: ${JSON.stringify(message.error ?? message)}`);
      }
    });
    socket.addEventListener("close", (event) => {
      appendJsonl(RECONNECTS_FILE, { type: "socket_close", at: new Date().toISOString(), code: event.code, reason: event.reason, authenticated, subscriptionConfirmed });
      scheduleReconnect(`socket closed code=${event.code}`);
    });
    socket.addEventListener("error", () => {
      appendJsonl(RECONNECTS_FILE, { type: "socket_error", at: new Date().toISOString() });
    });
  } catch (error) {
    appendJsonl(RECONNECTS_FILE, { type: "connect_error", at: new Date().toISOString(), error: String(error) });
    scheduleReconnect(String(error));
  }
}

saveJson(SESSION_FILE, {
  fixtureId: FIXTURE_ID,
  match: "Defensa y Justicia vs Platense",
  startedAt,
  restIntervalSeconds: REST_INTERVAL_MS / 1000,
  outputFiles: { events: EVENTS_FILE, reconnects: RECONNECTS_FILE, latest: LATEST_FILE, final: FINAL_FILE },
});

process.on("SIGINT", () => void finish("SIGINT"));
process.on("SIGTERM", () => void finish("SIGTERM"));
restTimer = setInterval(() => void restSnapshot("periodic_gap_fill"), REST_INTERVAL_MS);
await connect();
console.log(`監視中: Defensa y Justicia vs Platense (${FIXTURE_ID})`);
console.log(`保存先: ${OUTPUT_DIR}`);
