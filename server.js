#!/usr/bin/env node
// Campus Board — pulls today's eSPACE bookings and serves a lobby display per campus.
// Zero dependencies. Node 18+ (Windows, macOS, Linux) or Docker.
//
//   node server.js                 start the server
//   node server.js --pull-now      pull every campus once, print a summary, exit
//
// TVs open  http://<server>:8080/board/<campus>   e.g. /board/main

"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(ROOT, "config.json");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const PUBLIC_DIR = path.join(ROOT, "public");

// ---------------------------------------------------------------- config ----
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`No config found at ${CONFIG_PATH}. Copy config.example.json to config.json and edit it.`);
    process.exit(1);
  }
  const c = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  c.port = Number(process.env.PORT || c.port || 8080);
  c.timezone = c.timezone || "America/Los_Angeles";
  c.dailyPullAt = c.dailyPullAt || "04:00";
  c.refreshMinutes = c.refreshMinutes ?? 15;
  c.espace = c.espace || {};
  c.espace.token = process.env.ESPACE_TOKEN || c.espace.token || "";
  c.espace.baseUrl = (c.espace.baseUrl || "https://api.espace.cool/api/v2").replace(/\/$/, "");
  c.espace.eventsPath = c.espace.eventsPath || "/event/occurrences";
  c.espace.query = c.espace.query || { startDate: "{date}", endDate: "{date}", locationId: "{locationId}" };
  c.espace.onlyApproved = c.espace.onlyApproved ?? true;
  c.espace.onlyPublic = c.espace.onlyPublic ?? false;
  if (!c.campuses || !Object.keys(c.campuses).length) {
    console.error("config.json needs at least one entry under \"campuses\".");
    process.exit(1);
  }
  return c;
}
const cfg = loadConfig();
const DEMO = !cfg.espace.token || cfg.espace.token.startsWith("PASTE");
fs.mkdirSync(DATA_DIR, { recursive: true });

// ----------------------------------------------------------------- time -----
const tzOf = key => cfg.campuses[key].timezone || cfg.timezone;
const todayIn = tz => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date()); // YYYY-MM-DD
const hhmmIn = tz => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());

// ---------------------------------------------------------------- state -----
// state[campus] = { date, events, updated, ok, error, lastAttempt }
const state = {};
for (const key of Object.keys(cfg.campuses)) {
  state[key] = readCache(key) || { date: null, events: [], updated: null, ok: false, error: null };
}
function cacheFile(key) { return path.join(DATA_DIR, `${key}.json`); }
function readCache(key) {
  try { return JSON.parse(fs.readFileSync(cacheFile(key), "utf8")); } catch { return null; }
}
function writeCache(key, s) {
  try { fs.writeFileSync(cacheFile(key), JSON.stringify(s, null, 2)); } catch (e) { log(key, `cache write failed: ${e.message}`); }
}
function log(key, msg) { console.log(`${new Date().toISOString()} [${key}] ${msg}`); }

// ---------------------------------------------------------------- eSPACE ----
async function pull(key) {
  const campus = cfg.campuses[key];
  const tz = tzOf(key);
  const date = todayIn(tz);
  state[key].lastAttempt = new Date().toISOString();
  if (DEMO) {
    state[key] = { ...state[key], date, events: [], updated: new Date().toISOString(), ok: true, error: null, demo: true };
    return state[key];
  }
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(cfg.espace.query)) {
    q.set(k, String(v).replace("{date}", date).replace("{locationId}", campus.locationId ?? ""));
  }
  const url = `${cfg.espace.baseUrl}${cfg.espace.eventsPath}?${q}`;
  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${cfg.espace.token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30000),
    });
    if (r.status === 401) throw new Error("eSPACE rejected the token (401). Request a new one and update config.json.");
    if (!r.ok) throw new Error(`eSPACE returned HTTP ${r.status}`);
    const raw = await r.json();
    const list = Array.isArray(raw) ? raw : raw.Data || raw.data || raw.Items || raw.items || [];
    const events = list
      .map(mapOccurrence)
      .filter(e => e && e.title && e.start && e.end)
      .filter(e => !cfg.espace.onlyApproved || e.approved)
      .filter(e => !cfg.espace.onlyPublic || e.public)
      .filter(e => !(campus.hideRooms || []).some(h => e.rooms.includes(h)))
      .map(({ title, start, end, rooms }) => ({ title, start, end, rooms }))
      .sort((a, b) => new Date(a.start) - new Date(b.start));
    state[key] = { date, events, updated: new Date().toISOString(), ok: true, error: null, lastAttempt: state[key].lastAttempt };
    writeCache(key, state[key]);
    log(key, `pulled ${events.length} events for ${date}`);
  } catch (e) {
    // Keep showing the last good pull for today; flag it as stale.
    state[key].ok = false;
    state[key].error = e.message;
    log(key, `pull failed: ${e.message}`);
  }
  return state[key];
}

// The one place that knows eSPACE's field names.
// Check one real response in Swagger (https://api.espace.cool/swagger/ui/index) and adjust.
function mapOccurrence(o) {
  const spaces = o.Spaces || o.spaces || o.Items || o.items || [];
  const status = String(o.Status || o.OccurrenceStatus || o.status || "Approved");
  return {
    title: o.EventName || o.Name || o.Title || o.name || o.title,
    start: o.EventStart || o.StartDate || o.Start || o.startDate || o.start,  // event time, not setup-inclusive
    end: o.EventEnd || o.EndDate || o.End || o.endDate || o.end,
    rooms: spaces.map(s => s.Name || s.SpaceName || s.name).filter(Boolean),
    approved: /approved|confirmed/i.test(status),
    public: o.IsPublic ?? o.isPublic ?? o.Public ?? true,
  };
}

async function pullAll(reason) {
  console.log(`${new Date().toISOString()} pulling all campuses (${reason})`);
  await Promise.all(Object.keys(cfg.campuses).map(pull));
}

// -------------------------------------------------------------- schedule ----
// 1. A full pull at dailyPullAt (campus local time).
// 2. Optional refresh every refreshMinutes to catch same-day changes (0 = daily only).
// 3. An automatic pull whenever a campus rolls over to a new date.
function startSchedule() {
  const lastDaily = {};
  let minutes = 0;
  setInterval(() => {
    minutes++;
    for (const key of Object.keys(cfg.campuses)) {
      const tz = tzOf(key);
      const date = todayIn(tz);
      const due =
        (hhmmIn(tz) === cfg.dailyPullAt && lastDaily[key] !== date) ||
        (state[key].date !== date && Date.now() - new Date(state[key].lastAttempt || 0) > 5 * 60000) ||
        (cfg.refreshMinutes > 0 && minutes % cfg.refreshMinutes === 0);
      if (hhmmIn(tz) === cfg.dailyPullAt) lastDaily[key] = date;
      if (due) pull(key);
    }
  }, 60 * 1000);
}

// ---------------------------------------------------------------- server ----
const send = (res, status, body, type = "application/json; charset=utf-8", extra = {}) => {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...extra });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

function boardPayload(key) {
  const c = cfg.campuses[key];
  const s = state[key];
  const tz = tzOf(key);
  const today = todayIn(tz);
  return {
    org: cfg.org || "",
    campus: c.label || key,
    timezone: tz,
    demo: DEMO || undefined,
    // Never show yesterday's list on today's board.
    events: s.date === today ? s.events : [],
    updated: s.updated,
    stale: !s.ok || s.date !== today,
    error: s.error || undefined,
  };
}

function indexPage() {
  const links = Object.entries(cfg.campuses)
    .map(([k, c]) => `<li><a href="/board/${k}">${c.label || k}</a> <code>/board/${k}</code></li>`)
    .join("");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Campus Board</title>
<style>body{font:16px system-ui;background:#0d1520;color:#eef2f6;padding:2rem}a{color:#f3b94d}code{color:#9aabbd;margin-left:.5em}</style>
<h1>Campus Board</h1>${DEMO ? "<p>Demo mode: no eSPACE token configured, boards show sample events.</p>" : ""}
<ul>${links}</ul><p><a href="/health">/health</a></p>`;
}

let lastManual = 0;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname.replace(/\/+$/, "") || "/";

  if (p === "/") return send(res, 200, indexPage(), "text/html; charset=utf-8");

  const board = p.match(/^\/board\/([\w-]+)$/);
  if (board) {
    if (!cfg.campuses[board[1]]) return send(res, 404, `Unknown campus "${board[1]}".`, "text/plain");
    return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, "index.html")), "text/html; charset=utf-8");
  }

  const api = p.match(/^\/api\/today\/([\w-]+)$/);
  if (api || p === "/api/today") {
    const key = api ? api[1] : url.searchParams.get("campus");
    if (!cfg.campuses[key]) return send(res, 404, { error: `Unknown campus "${key}".` });
    return send(res, 200, boardPayload(key), undefined, { "Access-Control-Allow-Origin": "*" });
  }

  if (p === "/api/refresh" && req.method === "POST") {
    // Throttled so a stuck script or a curious visitor can't hammer eSPACE.
    if (Date.now() - lastManual < 60000) return send(res, 429, { error: "Refreshed less than a minute ago." });
    lastManual = Date.now();
    await pullAll("manual refresh");
    return send(res, 200, { ok: true });
  }

  if (p === "/health") {
    const campuses = Object.fromEntries(Object.keys(cfg.campuses).map(k => {
      const b = boardPayload(k);
      return [k, { events: b.events.length, updated: b.updated, stale: b.stale, error: b.error }];
    }));
    const healthy = DEMO || Object.values(campuses).every(c => !c.stale);
    return send(res, healthy ? 200 : 503, { healthy, demo: DEMO, campuses });
  }

  send(res, 404, "Not found", "text/plain");
});

// ------------------------------------------------------------------ main ----
(async () => {
  if (process.argv.includes("--pull-now")) {
    await pullAll("--pull-now");
    for (const k of Object.keys(cfg.campuses)) {
      const s = state[k];
      console.log(`${k}: ${s.ok ? "ok" : "FAILED"} · ${s.events.length} events · ${s.error || ""}`);
      for (const e of s.events) console.log(`   ${e.start}  ${e.title}  [${e.rooms.join(", ")}]`);
    }
    process.exit(Object.values(state).every(s => s.ok) ? 0 : 1);
  }
  if (DEMO) console.log("No eSPACE token configured: running in demo mode with sample events.");
  await pullAll("startup");
  startSchedule();
  server.listen(cfg.port, () => console.log(`Campus Board listening on http://0.0.0.0:${cfg.port}`));
})();
