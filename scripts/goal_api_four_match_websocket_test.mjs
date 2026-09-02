#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE = "https://api.goal-api.com/v1";
const WS = "wss://api.goal-api.com/ws";
const OUT = path.join(DIR, "data", "goal_api_test", "four_match_websocket", new Date().toISOString().replace(/[:.]/g, ""));
const TARGETS = [
  { key: "nordstrand_grei", home: ["nordstrand"], away: ["grei"] },
  { key: "helsingborg_orebro", home: ["helsingborg", "helsingborgs"], away: ["orebro", "örebro"] },
  { key: "wadi_degla_el_qanal", home: ["wadi degla"], away: ["olympic el qanal", "el qanal", "al qanal", "al qanah"] },
  { key: "al_hilal_al_ahli", home: ["al hilal"], away: ["al ahli", "al ahly"] },
];
const MAX_MS = Number(process.env.WS_TEST_MINUTES || 8) * 60_000;

fs.mkdirSync(OUT, { recursive: true });
const frameFile = path.join(OUT, "websocket_frames.jsonl");
const summaryFile = path.join(OUT, "summary.json");
const liveFile = path.join(OUT, "fixtures_live.json");

for (const raw of fs.readFileSync(path.join(DIR, ".env"), "utf8").split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("#") || !line.includes("=")) continue;
  const i = line.indexOf("=");
  const key = line.slice(0, i).trim();
  let value = line.slice(i + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  if (!(key in process.env)) process.env[key] = value;
}
const apiKey = process.env.GOAL_API_KEY;
if (!apiKey) throw new Error(".envにGOAL_API_KEYがありません");
const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
let httpRequests = 0;

const stamp = () => {
  const now = new Date();
  return { utc: now.toISOString(), jst: new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo", dateStyle: "short", timeStyle: "medium", hour12: false }).format(now).replace(" ", "T") + "+09:00" };
};
const normalize = (value) => String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const matchesAny = (name, aliases) => aliases.some((alias) => normalize(name).includes(normalize(alias)) || normalize(alias).includes(normalize(name)));
const append = (file, value) => fs.appendFileSync(file, JSON.stringify(value) + "\n");
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");

async function api(endpoint, options = {}) {
  httpRequests += 1;
  const response = await fetch(BASE + endpoint, { ...options, headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`${endpoint}: HTTP ${response.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

function fixtures(payload) {
  for (const value of [payload?.data, payload?.response, payload?.fixtures, payload]) {
    if (Array.isArray(value)) return value;
    if (Array.isArray(value?.fixtures)) return value.fixtures;
  }
  return [];
}
function info(f) {
  return {
    id: f?.id ?? f?.fixture_id ?? f?.fixtureId,
    home: f?.homeTeamName ?? f?.homeTeam?.name ?? f?.home_team?.name ?? f?.home,
    away: f?.awayTeamName ?? f?.awayTeam?.name ?? f?.away_team?.name ?? f?.away,
    status: f?.matchStatus ?? f?.match_status ?? f?.status,
    score: `${f?.homeTeamScore ?? f?.match_hometeam_score ?? "-"}-${f?.awayTeamScore ?? f?.match_awayteam_score ?? "-"}`,
    league: f?.leagueName ?? f?.league?.name ?? f?.league_name,
  };
}

const livePayload = await api("/fixtures/live");
save(liveFile, { receivedAt: stamp(), raw: livePayload });
const live = fixtures(livePayload).map(info);
const selected = TARGETS.map((target) => ({
  ...target,
  fixture: live.find((f) => f.id && matchesAny(f.home, target.home) && matchesAny(f.away, target.away)) ?? null,
}));

console.log(`ライブ試合件数: ${live.length}`);
for (const target of selected) console.log(`${target.key}: ${target.fixture ? `${target.fixture.home} vs ${target.fixture.away} / ${target.fixture.status} / ${target.fixture.score} / ${target.fixture.id}` : "NOT FOUND"}`);
const found = selected.filter((item) => item.fixture);
if (!found.length) {
  save(summaryFile, { status: "no_targets_found", at: stamp(), httpRequests, selected, outputDirectory: OUT });
  console.log(`対象試合なし。保存先: ${OUT}`);
  process.exit(0);
}

const tokenPayload = await api("/ws/token", { method: "POST" });
const token = tokenPayload?.data?.token ?? tokenPayload?.token;
if (!token) throw new Error("WebSocket tokenなし");

const state = Object.fromEntries(found.map((item) => [item.fixture.id, { key: item.key, fixture: item.fixture, subscribed: false, updates: 0, latest: null }]));
let frames = 0;
let finished = false;
const socket = new WebSocket(`${WS}?wsToken=${encodeURIComponent(token)}`);

function finish(reason) {
  if (finished) return;
  finished = true;
  for (const id of Object.keys(state)) {
    try { socket.send(JSON.stringify({ type: "unsubscribe", resource: "match", matchId: id })); } catch {}
  }
  try { socket.close(1000, reason); } catch {}
  save(summaryFile, { status: "completed", reason, finishedAt: stamp(), httpRequests, websocketFrames: frames, matches: state, outputDirectory: OUT });
  console.log(`\n終了: ${reason}\nHTTP requests: ${httpRequests}\n保存先: ${OUT}`);
  setTimeout(() => process.exit(0), 100);
}

const timer = setTimeout(() => finish("time_limit"), MAX_MS);
socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "auth", token })));
socket.addEventListener("message", (event) => {
  const receivedAt = stamp();
  let message;
  try { message = JSON.parse(String(event.data)); } catch { message = { type: "unparsed", raw: String(event.data) }; }
  frames += 1;
  append(frameFile, { sequence: frames, receivedAt, message });
  if (message.type === "auth_success") {
    for (const id of Object.keys(state)) socket.send(JSON.stringify({ type: "subscribe", resource: "match", matchId: id }));
    return;
  }
  if (message.type === "subscribe_response") {
    const id = message?.data?.matchId;
    if (state[id]) state[id].subscribed = message.success === true;
    console.log(`subscribe ${id}: ${message.success ? "SUCCESS" : "FAILED"}`);
    return;
  }
  if (message.type !== "match_update") return;
  const data = message.data ?? {};
  const id = data.id ?? data.fixture_id ?? data.fixtureId;
  if (!state[id]) return;
  state[id].updates += 1;
  state[id].latest = { receivedAt, minute: data.match_status, score: `${data.match_hometeam_score}-${data.match_awayteam_score}`, statistics: data.statistics ?? [] };
  console.log(`\n${data.match_hometeam_name} ${data.match_hometeam_score}-${data.match_awayteam_score} ${data.match_awayteam_name} ${data.match_status}`);
  console.log(`受信: ${receivedAt.jst} / update #${state[id].updates}`);
  for (const row of data.statistics ?? []) console.log(`${String(row.type).padEnd(28)} ${String(row.home ?? "N/A").padStart(8)} ${String(row.away ?? "N/A").padStart(8)}`);
  if (Object.values(state).every((match) => match.updates >= 2)) {
    clearTimeout(timer);
    finish("all_found_matches_received_two_updates");
  }
});
socket.addEventListener("error", () => finish("websocket_error"));
socket.addEventListener("close", () => { if (!finished) finish("websocket_closed"); });
process.on("SIGINT", () => { clearTimeout(timer); finish("SIGINT"); });
