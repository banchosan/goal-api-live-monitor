#!/usr/bin/env node
/**
 * Isolated GOAL API experiment: determine whether inbound WebSocket frames
 * consume the daily REST request quota.
 *
 * This program deliberately performs no HTTP calls while the socket is open.
 * It also refuses to start when another GOAL API script is running, because
 * another process would make a remaining-quota delta inconclusive.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BASE_URL = "https://api.goal-api.com/v1";
const WS_URL = "wss://api.goal-api.com/ws";
const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(PROJECT_DIR, "data", "goal_api_test", "quota_test");
const SUMMARY_FILE = path.join(OUTPUT_DIR, "experiment_summary.json");
const FRAME_LOG = path.join(OUTPUT_DIR, "websocket_frames.jsonl");
const HTTP_LOG = path.join(OUTPUT_DIR, "http_requests.jsonl");
const RATE_LOG = path.join(OUTPUT_DIR, "rate_limit_measurements.jsonl");
const TARGET_UPDATES = positiveInteger(process.env.QUOTA_TEST_MATCH_UPDATES, 5);
const MAX_OBSERVATION_MS = positiveInteger(process.env.QUOTA_TEST_MAX_MINUTES, 15) * 60_000;
const SCRIPT_NAME = path.basename(fileURLToPath(import.meta.url));

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function append(file, value) {
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

function save(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function timestamps(date = new Date()) {
  return {
    utc: date.toISOString(),
    jst: new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3,
      hour12: false,
    }).format(date).replace(" ", "T").replace(",", ".") + "+09:00",
  };
}

function loadEnv() {
  const envFile = path.join(PROJECT_DIR, ".env");
  if (!fs.existsSync(envFile)) throw new Error(`.envが見つかりません: ${envFile}`);
  for (const raw of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

function findConflictingProcesses() {
  let output;
  try {
    output = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  } catch (error) {
    throw new Error(`プロセス一覧を確認できません。厳密測定を開始しません: ${error.message}`);
  }
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    const match = line.match(/^(\d+)\s+(.+)$/);
    if (!match || Number(match[1]) === process.pid) return [];
    const command = match[2];
    if (!/goal[_-]api/i.test(command) || !/\.(?:mjs|js|py)(?:\s|$)/i.test(command)) return [];
    if (command.includes(SCRIPT_NAME)) return [];
    return [{ pid: Number(match[1]), command }];
  });
}

function rateHeaders(headers) {
  const get = (...names) => names.map((name) => headers.get(name)).find((value) => value !== null) ?? null;
  const integer = (value) => value !== null && /^\d+$/.test(value) ? Number(value) : null;
  return {
    limit: integer(get("x-ratelimit-limit", "ratelimit-limit")),
    remaining: integer(get("x-ratelimit-remaining", "ratelimit-remaining")),
    reset: get("x-ratelimit-reset", "ratelimit-reset"),
    type: get("x-ratelimit-type"),
  };
}

function liveFixtures(payload) {
  const candidates = [payload?.data, payload?.response, payload?.fixtures, payload];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    if (Array.isArray(candidate?.fixtures)) return candidate.fixtures;
  }
  return [];
}

function fixtureId(fixture) {
  return fixture?.fixture_id ?? fixture?.fixtureId ?? fixture?.id ?? fixture?._id ?? null;
}

function fixtureLabel(fixture) {
  const home = fixture?.homeTeam?.name ?? fixture?.home_team?.name ?? fixture?.homeTeamName ?? fixture?.home ?? "HOME";
  const away = fixture?.awayTeam?.name ?? fixture?.away_team?.name ?? fixture?.awayTeamName ?? fixture?.away ?? "AWAY";
  return `${home} vs ${away}`;
}

function statisticsFingerprint(message) {
  const statistics = message?.data?.statistics;
  return statistics === undefined ? null : JSON.stringify(statistics);
}

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    /^(?:token|wsToken|apiKey|authorization)$/i.test(key) ? "[REDACTED]" : redactSecrets(item),
  ]));
}

loadEnv();
const apiKey = process.env.GOAL_API_KEY;
if (!apiKey) throw new Error("GOAL_API_KEYが.envに設定されていません");

const started = timestamps();
const conflicts = findConflictingProcesses();
if (conflicts.length) {
  const blocked = {
    status: "blocked_by_other_goal_api_process",
    conclusion: "C",
    conclusionText: "他プロセスのAPI利用があるため厳密測定不能",
    startedAt: started,
    conflictingProcesses: conflicts,
    actualHttpRequests: 0,
    websocketFrames: 0,
    matchUpdates: 0,
    statisticsChanges: 0,
    outputFiles: { summary: SUMMARY_FILE, frames: FRAME_LOG, http: HTTP_LOG, rateLimits: RATE_LOG },
  };
  save(SUMMARY_FILE, blocked);
  console.error("他のGOAL APIプロセスが稼働中のため、厳密測定を開始しません。APIリクエスト数: 0");
  for (const processInfo of conflicts) console.error(`PID ${processInfo.pid}: ${processInfo.command}`);
  console.error(SUMMARY_FILE);
  process.exitCode = 2;
} else {
  await runExperiment();
}

async function runExperiment() {
  // A rerun must never mix frames or measurements from an earlier experiment.
  for (const file of [FRAME_LOG, HTTP_LOG, RATE_LOG]) fs.writeFileSync(file, "", "utf8");
  const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "User-Agent": "GOAL-API-WebSocket-Quota-Test/1.0" };
  let httpCount = 0;
  let frameCount = 0;
  let matchUpdateCount = 0;
  let statisticsChangeCount = 0;
  let previousStatistics = null;
  const rates = [];
  let socket = null;
  let socketOpened = false;

  async function request(endpoint, options = {}, purpose) {
    httpCount += 1;
    const sentAt = timestamps();
    const response = await fetch(`${BASE_URL}${endpoint}`, { ...options, headers: { ...headers, ...(options.headers ?? {}) } });
    const receivedAt = timestamps();
    const rate = rateHeaders(response.headers);
    const bodyText = await response.text();
    append(HTTP_LOG, { sequence: httpCount, purpose, endpoint, method: options.method ?? "GET", sentAt, receivedAt, status: response.status, rateLimit: rate });
    append(RATE_LOG, { sequence: httpCount, purpose, measuredAt: receivedAt, ...rate });
    rates.push({ sequence: httpCount, purpose, measuredAt: receivedAt, ...rate });
    if (!response.ok) throw new Error(`${endpoint} HTTP ${response.status}: ${bodyText.slice(0, 300)}`);
    return { payload: JSON.parse(bodyText), rate };
  }

  console.log(`想定HTTPリクエスト数: 3（fixtures/live、ws/token、終了後quota確認）`);
  console.log(`目標match_update数: ${TARGET_UPDATES}、最大監視時間: ${MAX_OBSERVATION_MS / 60_000}分`);

  // Measurement 1: the header is the remaining value after this one REST call.
  const initial = await request("/fixtures/live", {}, "initial_quota_and_live_fixture");
  const fixtures = liveFixtures(initial.payload);
  const fixture = fixtures.find((item) => fixtureId(item));
  if (!fixture) throw new Error("現在ライブ試合なし。WebSocket quota検証を継続できません");
  const selectedFixtureId = fixtureId(fixture);
  console.log(`選択試合: ${fixtureLabel(fixture)} (${selectedFixtureId})`);
  console.log(`fixtures/live後 remaining: ${initial.rate.remaining ?? "headerなし"}`);

  const tokenResult = await request("/ws/token", { method: "POST" }, "websocket_token");
  const token = tokenResult.payload?.data?.token ?? tokenResult.payload?.token;
  if (!token) throw new Error("/ws/tokenレスポンスにtokenがありません");
  console.log(`ws/token後 remaining: ${tokenResult.rate.remaining ?? "headerなし"}`);
  console.log("ここからWebSocket終了まではHTTP requestを送信しません。");

  const socketResult = await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finishSocket("observation_timeout"), MAX_OBSERVATION_MS);

    function finishSocket(reason) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.send(JSON.stringify({ type: "unsubscribe", resource: "match", matchId: selectedFixtureId })); } catch {}
      try { socket?.close(1000, "quota test complete"); } catch {}
      resolve({ reason });
    }

    socket = new WebSocket(`${WS_URL}?wsToken=${encodeURIComponent(token)}`);
    socket.addEventListener("open", () => {
      socketOpened = true;
      socket.send(JSON.stringify({ type: "auth", token }));
    });
    socket.addEventListener("message", (event) => {
      const receivedAt = timestamps();
      let message;
      try { message = JSON.parse(String(event.data)); } catch { message = { type: "unparsed", raw: String(event.data) }; }
      frameCount += 1;
      const isMatchUpdate = message?.type === "match_update";
      let statisticsChanged = false;
      if (isMatchUpdate) {
        matchUpdateCount += 1;
        const fingerprint = statisticsFingerprint(message);
        if (fingerprint !== null && previousStatistics !== null && fingerprint !== previousStatistics) {
          statisticsChanged = true;
          statisticsChangeCount += 1;
        }
        if (fingerprint !== null) previousStatistics = fingerprint;
      }
      // Redact defensively even if a server response unexpectedly echoes credentials.
      append(FRAME_LOG, { sequence: frameCount, receivedAt, messageType: message?.type ?? "unknown", matchUpdate: isMatchUpdate, statisticsChanged, message: redactSecrets(message) });
      if (message?.type === "auth_success") socket.send(JSON.stringify({ type: "subscribe", resource: "match", matchId: selectedFixtureId }));
      if (message?.type === "subscribe_response" && message?.success === false) finishSocket("subscribe_failed");
      if (matchUpdateCount >= TARGET_UPDATES) finishSocket("target_match_updates_received");
    });
    socket.addEventListener("error", () => {
      if (!settled) reject(new Error("WebSocket error"));
    });
    socket.addEventListener("close", (event) => {
      if (!settled) reject(new Error(`WebSocket unexpectedly closed: ${event.code} ${event.reason}`));
    });
  });

  // The socket is closed before this final and only quota-checking REST call.
  const final = await request("/fixtures/live", {}, "final_quota_check");
  const initialRemainingAfterRequest = initial.rate.remaining;
  const finalRemainingAfterRequest = final.rate.remaining;
  const observedDecrease = initialRemainingAfterRequest !== null && finalRemainingAfterRequest !== null
    ? initialRemainingAfterRequest - finalRemainingAfterRequest : null;
  // Only requests charged to the same rate-limit bucket are comparable. The
  // token endpoint may expose a separate short-window limit (for example 9000)
  // while fixtures use the FREE plan's DAILY/1000 bucket.
  const sameBucket = (left, right) => left.limit === right.limit && left.type === right.type && left.reset === right.reset;
  const expectedDecreaseBetweenMeasurements = rates.slice(1).filter((measurement) => sameBucket(initial.rate, measurement)).length;
  const resetChanged = initial.rate.reset !== null && final.rate.reset !== null && initial.rate.reset !== final.rate.reset;
  let conclusion = "C";
  let conclusionText = "rate-limit header不足またはquota resetのため判定不能";
  if (!resetChanged && observedDecrease !== null) {
    if (observedDecrease === expectedDecreaseBetweenMeasurements) {
      conclusion = "A";
      conclusionText = "WebSocket受信はquotaを消費しない";
    } else if (observedDecrease > expectedDecreaseBetweenMeasurements && frameCount > 0) {
      conclusion = "B";
      conclusionText = "WebSocket受信またはsubscription中の動作もquotaを消費した可能性を示す実測差分あり";
    } else {
      conclusionText = "観測減少がHTTP request数と整合せず、外部利用またはquota仕様の影響を排除できない";
    }
  }

  const periodicRestRequestsPer90Minutes = Math.floor(90 / 5) * 2;
  const summary = {
    status: "completed",
    conclusion,
    conclusionText,
    startedAt: started,
    finishedAt: timestamps(),
    selectedFixture: { id: selectedFixtureId, label: fixtureLabel(fixture) },
    observationEndReason: socketResult.reason,
    socketOpened,
    startingRemainingBeforeFirstRequestInferred: initialRemainingAfterRequest === null ? null : initialRemainingAfterRequest + 1,
    remainingAfterFixturesLive: initialRemainingAfterRequest,
    remainingAfterWsToken: tokenResult.rate.remaining,
    endingRemainingAfterFinalRequest: finalRemainingAfterRequest,
    observedQuotaDecreaseBetweenFirstAndFinalHeaders: observedDecrease,
    expectedDecreaseBetweenHeadersFromHttpOnly: expectedDecreaseBetweenMeasurements,
    dailyQuotaDecreaseFromInferredPreExperimentStart: initialRemainingAfterRequest !== null && finalRemainingAfterRequest !== null
      ? initialRemainingAfterRequest + 1 - finalRemainingAfterRequest : null,
    actualHttpRequests: httpCount,
    websocketFrames: frameCount,
    matchUpdates: matchUpdateCount,
    statisticsChanges: statisticsChangeCount,
    rateLimitResetChanged: resetChanged,
    periodicRestCalculation: {
      intervalMinutes: 5,
      requestsPerIntervalPerMatch: 2,
      intervalsIn90Minutes: Math.floor(90 / 5),
      requestsPer90MinutesPerMatch: periodicRestRequestsPer90Minutes,
      approximateMatchesPer1000RequestsIgnoringSetupAndOtherTraffic: Math.floor(1000 / periodicRestRequestsPer90Minutes),
      websocketOnlyPeriodicRestRequestsPer90Minutes: 0,
    },
    outputFiles: { summary: SUMMARY_FILE, frames: FRAME_LOG, http: HTTP_LOG, rateLimits: RATE_LOG },
  };
  save(SUMMARY_FILE, summary);
  console.log(JSON.stringify(summary, null, 2));
}
