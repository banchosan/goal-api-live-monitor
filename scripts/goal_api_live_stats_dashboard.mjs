#!/usr/bin/env node
/** Sofascore-like terminal dashboard for one GOAL API live fixture. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_ID = "cmt1fhw1l77a6pd078djgps37";
const BASE_URL = "https://api.goal-api.com/v1";
const WS_URL = "wss://api.goal-api.com/ws";
const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(PROJECT_DIR, "data", "goal_api_test", "platense_dashboard");
const RAW_LOG = path.join(OUTPUT_DIR, "raw_messages.jsonl");
const DIFF_LOG = path.join(OUTPUT_DIR, "stat_changes.jsonl");
const CONNECTION_LOG = path.join(OUTPUT_DIR, "connections.jsonl");
const REST_LOG = path.join(OUTPUT_DIR, "rest_supplements.jsonl");
const LATEST_FILE = path.join(OUTPUT_DIR, "latest.json");
const SESSION_FILE = path.join(OUTPUT_DIR, "session.json");
const FINAL_FILE = path.join(OUTPUT_DIR, "final.json");
const REST_INTERVAL_MS = 5 * 60_000;
const WINDOW_MS = 5 * 60_000;
const METRICS = [
  ["Attacks", "Attacks"],
  ["Dangerous Attacks", "Dangerous Attacks"],
  ["Shots Total", "Shots Total"],
  ["Shots On Goal", "Shots On Goal"],
  ["Shots Off Goal", "Shots Off Goal"],
  ["Shots Blocked", "Shots Blocked"],
  ["Shots Inside Box", "Shots Inside Box"],
  ["Shots Outside Box", "Shots Outside Box"],
  ["Corners", "Corners"],
  ["Ball Possession", "Possession"],
  ["Passes Total", "Passes Total"],
  ["Passes Accurate", "Passes Accurate"],
  ["Saves", "Saves"],
  ["Fouls", "Fouls"],
  ["Offsides", "Offsides"],
  ["Yellow Cards", "Yellow Cards"],
];
const ROLLING_METRICS = new Set(["Dangerous Attacks", "Attacks", "Shots Total", "Shots On Goal", "Shots Off Goal", "Shots Blocked", "Shots Inside Box", "Shots Outside Box", "Corners"]);

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
for (const raw of fs.readFileSync(path.join(PROJECT_DIR, ".env"), "utf8").split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("#") || !line.includes("=")) continue;
  const index = line.indexOf("=");
  const key = line.slice(0, index).trim();
  let value = line.slice(index + 1).trim();
  if ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'")) value = value.slice(1, -1);
  if (!(key in process.env)) process.env[key] = value;
}
const apiKey = process.env.GOAL_API_KEY;
if (!apiKey) throw new Error("GOAL_API_KEYが.envにありません");
const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "User-Agent": "GOAL-API-Live-Stats-Dashboard/1.0" };
const startedAt = new Date().toISOString();

let socket;
let stopped = false;
let reconnectAttempt = 0;
let requestCount = 0;
let restTimer;
let current = { home: "Defensa y Justicia", away: "Platense", homeScore: "-", awayScore: "-", status: "N/A", stats: {}, selections: {} };
let history = [];
let alternateScreenActive = false;

const append = (file, value) => fs.appendFileSync(file, JSON.stringify(value) + "\n", "utf8");
function save(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
  fs.renameSync(temp, file);
}
const jst = (date = new Date()) => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
const num = (value) => {
  if (typeof value === "number") return value;
  const match = String(value ?? "").match(/^-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
};
const terminal = (status) => ["FT", "FINISHED", "AFTER_ET", "AFTER_PEN", "CANCELLED", "ABANDONED", "AWARDED"].includes(String(status ?? "").toUpperCase());

function enterDashboardScreen() {
  if (!process.stdout.isTTY || alternateScreenActive) return;
  // Alternate buffer prevents every redraw from accumulating in scrollback.
  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J");
  alternateScreenActive = true;
}

function leaveDashboardScreen() {
  if (!process.stdout.isTTY || !alternateScreenActive) return;
  process.stdout.write("\x1b[?25h\x1b[?1049l");
  alternateScreenActive = false;
}

function extractStats(rows) {
  const stats = {};
  const selections = {};
  for (const [type] of METRICS) {
    const found = rows.map((row, index) => ({ row, position: index + 1 })).filter(({ row }) => row?.type === type);
    if (!found.length) {
      stats[type] = { home: null, away: null };
      selections[type] = { selected: null, occurrences: [] };
      continue;
    }
    // Detailed provider block occurs later in the array; keep every occurrence in logs.
    const selected = found.at(-1);
    stats[type] = { home: selected.row.home ?? null, away: selected.row.away ?? null };
    selections[type] = {
      selected: { type, position: selected.position, home: selected.row.home ?? null, away: selected.row.away ?? null },
      occurrences: found.map(({ row, position }, occurrence) => ({ occurrence: occurrence + 1, type, position, home: row.home ?? null, away: row.away ?? null })),
    };
  }
  return { stats, selections };
}

function recordChanges(previous, next, receivedAt, source) {
  const changes = [];
  for (const [type] of METRICS) {
    for (const side of ["home", "away"]) {
      const before = previous[type]?.[side] ?? null;
      const after = next[type]?.[side] ?? null;
      if (before !== after) {
        const beforeNumber = num(before), afterNumber = num(after);
        changes.push({ type, side, previous: before, next: after, delta: beforeNumber !== null && afterNumber !== null ? afterNumber - beforeNumber : null });
      }
    }
  }
  if (changes.length) append(DIFF_LOG, { receivedAt, receivedAtJst: jst(new Date(receivedAt)), source, changes });
  return changes;
}

function snapshotHistory(receivedAt) {
  history.push({ at: Date.parse(receivedAt), stats: structuredClone(current.stats) });
  const cutoff = Date.now() - WINDOW_MS - 60_000;
  history = history.filter((item) => item.at >= cutoff);
}

function rollingDelta(type, side) {
  const nowValue = num(current.stats[type]?.[side]);
  if (nowValue === null || !history.length) return null;
  const boundary = Date.now() - WINDOW_MS;
  const eligible = history.filter((item) => item.at <= boundary);
  const baseline = eligible.at(-1) ?? history[0];
  const baseValue = num(baseline.stats[type]?.[side]);
  return baseValue === null ? null : nowValue - baseValue;
}

function cell(value, width = 10) { return String(value ?? "N/A").padStart(width); }
function render(receivedAt, changes = []) {
  const status = /^\d+(?:\+\d+)?$/.test(String(current.status)) ? `${current.status}'` : current.status;
  const lines = [
    `${current.home} ${current.homeScore} - ${current.awayScore} ${current.away} ${status}`,
    `Updated: ${jst(new Date(receivedAt))} JST`,
    "",
    `${"STATISTIC".padEnd(24)}${"HOME".padStart(10)}${"AWAY".padStart(10)}`,
    "-".repeat(44),
  ];
  for (const [type, label] of METRICS) lines.push(`${label.padEnd(24)}${cell(current.stats[type]?.home)}${cell(current.stats[type]?.away)}`);
  const terminalRows = process.stdout.rows || 24;
  if (terminalRows >= 36) {
    lines.push("", "LAST 5 MINUTES", `${"STATISTIC".padEnd(24)}${"HOME".padStart(10)}${"AWAY".padStart(10)}`, "-".repeat(44));
    for (const [type, label] of METRICS.filter(([type]) => ROLLING_METRICS.has(type))) {
      const home = rollingDelta(type, "home"), away = rollingDelta(type, "away");
      lines.push(`${label.padEnd(24)}${cell(home === null ? "N/A" : `${home >= 0 ? "+" : ""}${home}`)}${cell(away === null ? "N/A" : `${away >= 0 ? "+" : ""}${away}`)}`);
    }
    lines.push("", `Changed in last update: ${changes.length ? changes.map((item) => `${item.type} ${item.side.toUpperCase()}`).join(", ") : "none"}`);
  } else {
    // Keep all primary statistics visible in common 24-row terminals.
    const compactTypes = ["Dangerous Attacks", "Attacks", "Shots Total", "Shots On Goal", "Corners"];
    const compact = compactTypes.map((type) => {
      const home = rollingDelta(type, "home"), away = rollingDelta(type, "away");
      const value = (number) => number === null ? "N/A" : `${number >= 0 ? "+" : ""}${number}`;
      return `${type} ${value(home)}/${value(away)}`;
    });
    lines.push("", `LAST 5M (H/A): ${compact.join(" | ")}`);
  }
  if (process.stdout.isTTY) {
    enterDashboardScreen();
    // Rewind and erase only the alternate screen; no new scrollback entry.
    process.stdout.write("\x1b[H\x1b[J");
  }
  process.stdout.write(lines.join("\n") + "\n");
}

function applyUpdate(data, receivedAt, source) {
  const rows = Array.isArray(data.statistics) ? data.statistics : [];
  const { stats, selections } = extractStats(rows);
  const changes = recordChanges(current.stats, stats, receivedAt, source);
  current = {
    home: data.match_hometeam_name ?? current.home,
    away: data.match_awayteam_name ?? current.away,
    homeScore: data.match_hometeam_score ?? current.homeScore,
    awayScore: data.match_awayteam_score ?? current.awayScore,
    status: data.match_status ?? current.status,
    stats,
    selections,
  };
  snapshotHistory(receivedAt);
  save(LATEST_FILE, { receivedAt, receivedAtJst: jst(new Date(receivedAt)), source, current, changes });
  append(RAW_LOG, { receivedAt, source, raw: data, selectedStatistics: selections, previousAndNew: changes });
  render(receivedAt, changes);
}

async function api(endpoint, options = {}) {
  requestCount += 1;
  const response = await fetch(`${BASE_URL}${endpoint}`, { ...options, headers: { ...headers, ...(options.headers ?? {}) } });
  const text = await response.text();
  if (!response.ok) throw new Error(`${endpoint} HTTP ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function rowsFromStatisticsPayload(payload) {
  return payload?.data?.match?.fullTime ?? payload?.data?.fullTime ?? payload?.fullTime ?? [];
}

async function restSupplement(reason) {
  const receivedAt = new Date().toISOString();
  try {
    const [fixturePayload, statisticsPayload] = await Promise.all([api(`/fixtures/${FIXTURE_ID}`), api(`/fixtures/${FIXTURE_ID}/statistics`)]);
    const fixture = fixturePayload?.data ?? fixturePayload?.response ?? fixturePayload;
    const rows = rowsFromStatisticsPayload(statisticsPayload);
    const record = { receivedAt, receivedAtJst: jst(new Date(receivedAt)), reason, fixture: fixturePayload, statistics: statisticsPayload };
    append(REST_LOG, record);
    const synthetic = {
      match_hometeam_name: fixture?.homeTeamName ?? fixture?.homeTeam?.name ?? current.home,
      match_awayteam_name: fixture?.awayTeamName ?? fixture?.awayTeam?.name ?? current.away,
      match_hometeam_score: fixture?.homeTeamScore ?? current.homeScore,
      match_awayteam_score: fixture?.awayTeamScore ?? current.awayScore,
      match_status: fixture?.matchStatus ?? current.status,
      statistics: rows.map((row) => row.raw ?? { type: row.type, home: row.home, away: row.away }),
    };
    if (rows.length) applyUpdate(synthetic, receivedAt, `REST:${reason}`);
    if (terminal(synthetic.match_status)) await finish("REST terminal status");
  } catch (error) {
    append(REST_LOG, { receivedAt, reason, error: String(error) });
  }
}

async function finish(reason) {
  if (stopped) return;
  stopped = true;
  clearInterval(restTimer);
  try { socket?.send(JSON.stringify({ type: "unsubscribe", resource: "match", matchId: FIXTURE_ID })); } catch {}
  try { socket?.close(1000, "finished"); } catch {}
  save(FINAL_FILE, { fixtureId: FIXTURE_ID, startedAt, finishedAt: new Date().toISOString(), reason, requestCount, current });
  leaveDashboardScreen();
  console.log(`\n監視終了: ${reason}\n${FINAL_FILE}`);
  setTimeout(() => process.exit(0), 100);
}

function reconnect(reason) {
  if (stopped) return;
  reconnectAttempt += 1;
  const delay = Math.min(1000 * 2 ** Math.min(reconnectAttempt - 1, 5), 30_000) + Math.floor(Math.random() * 500);
  append(CONNECTION_LOG, { type: "reconnect_scheduled", at: new Date().toISOString(), reason, attempt: reconnectAttempt, delayMs: delay });
  setTimeout(connect, delay);
}

async function connect() {
  if (stopped) return;
  try {
    await restSupplement(reconnectAttempt ? "reconnect_gap_fill" : "startup");
    if (stopped) return;
    const tokenPayload = await api("/ws/token", { method: "POST" });
    const token = tokenPayload?.data?.token;
    if (!token) throw new Error("ws/tokenにtokenなし");
    socket = new WebSocket(`${WS_URL}?wsToken=${encodeURIComponent(token)}`);
    socket.addEventListener("open", () => {
      append(CONNECTION_LOG, { type: "socket_open", at: new Date().toISOString() });
      socket.send(JSON.stringify({ type: "auth", token }));
    });
    socket.addEventListener("message", (event) => {
      const receivedAt = new Date().toISOString();
      let message;
      try { message = JSON.parse(String(event.data)); } catch { message = { type: "unparsed", raw: String(event.data) }; }
      append(RAW_LOG, { receivedAt, source: "WebSocket frame", message });
      if (message.type === "auth_success") {
        reconnectAttempt = 0;
        append(CONNECTION_LOG, { type: "auth_success", at: receivedAt, data: message.data });
        socket.send(JSON.stringify({ type: "subscribe", resource: "match", matchId: FIXTURE_ID }));
      } else if (message.type === "subscribe_response" || message.type === "unsubscribe_response") {
        append(CONNECTION_LOG, { type: message.type, at: receivedAt, response: message });
        if (message.type === "subscribe_response" && !message.success) reconnect("subscribe failed");
      } else if (message.type === "match_update") {
        applyUpdate(message.data ?? {}, receivedAt, "WebSocket match_update");
        if (terminal(message.data?.match_status) || String(message.data?.match_live) === "0") void finish("WebSocket terminal status");
      } else if (message.type === "error") {
        append(CONNECTION_LOG, { type: "server_error", at: receivedAt, error: message.error });
      }
    });
    socket.addEventListener("close", (event) => {
      append(CONNECTION_LOG, { type: "socket_close", at: new Date().toISOString(), code: event.code, reason: event.reason });
      reconnect(`socket close ${event.code}`);
    });
    socket.addEventListener("error", () => append(CONNECTION_LOG, { type: "socket_error", at: new Date().toISOString() }));
  } catch (error) {
    append(CONNECTION_LOG, { type: "connect_error", at: new Date().toISOString(), error: String(error) });
    reconnect(String(error));
  }
}

save(SESSION_FILE, { fixtureId: FIXTURE_ID, match: "Defensa y Justicia vs Platense", startedAt, restIntervalSeconds: 300, outputFiles: { raw: RAW_LOG, diffs: DIFF_LOG, connections: CONNECTION_LOG, rest: REST_LOG, latest: LATEST_FILE, final: FINAL_FILE } });
enterDashboardScreen();
process.on("SIGINT", () => void finish("SIGINT"));
process.on("SIGTERM", () => void finish("SIGTERM"));
process.on("exit", leaveDashboardScreen);
restTimer = setInterval(() => void restSupplement("periodic_5m"), REST_INTERVAL_MS);
await connect();
