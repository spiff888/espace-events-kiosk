// Campus Board: pulls today's eSPACE bookings and serves a lobby display per campus.
// No runtime dependencies. Node 18+ (Windows, macOS, Linux) or Docker.
//
//   npm start          start the server
//   npm run pull       pull every campus once, print a summary, exit
//
// TVs open  http://<server>:8080/board/<campus>   e.g. /board/main

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ----------------------------------------------------------------- types ----
interface CampusConfig {
  label?: string;
  locationId?: string | number;
  timezone?: string;
  hideRooms?: string[];
  hidePastAfterMinutes?: number | null;
}

interface EspaceConfig {
  token: string;
  baseUrl: string;
  eventsPath: string;
  query: Record<string, string>;
  onlyApproved: boolean;
  onlyPublic: boolean;
}

interface Config {
  org?: string;
  port: number;
  timezone: string;
  dailyPullAt: string;
  refreshMinutes: number;
  /** Minutes after an event ends before it drops off the board. null keeps the whole day. */
  hidePastAfterMinutes: number | null;
  espace: EspaceConfig;
  campuses: Record<string, CampusConfig>;
}

/** One booking as the TV page receives it. */
export interface BoardEvent {
  title: string;
  start: string; // ISO 8601
  end: string;
  rooms: string[];
}

interface MappedEvent extends BoardEvent {
  approved: boolean;
  public: boolean;
}

interface CampusState {
  date: string | null;
  events: BoardEvent[];
  updated: string | null;
  ok: boolean;
  error: string | null;
  lastAttempt?: string;
  demo?: boolean;
}

/** Raw eSPACE record. Field names are unconfirmed, so every one is optional. */
type EspaceOccurrence = Record<string, unknown>;

// Compiled output lives in dist/, so the project root is one level up.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Docker Compose passes .env in as environment variables. When run directly with Node,
// read .env ourselves so the token lives in the same place either way.
loadDotEnv(path.join(ROOT, ".env"));
function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!m || line.trimStart().startsWith("#")) continue;
    const value = m[2].replace(/^(["'])(.*)\1$/, "$2");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(ROOT, "config.json");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const PUBLIC_DIR = path.join(ROOT, "public");

// ---------------------------------------------------------------- config ----
function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`No config found at ${CONFIG_PATH}. Copy config.example.json to config.json and edit it.`);
    process.exit(1);
  }
  type RawConfig = Partial<Omit<Config, "espace">> & { espace?: Partial<EspaceConfig> };
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as RawConfig;
  const e = raw.espace ?? {};
  if (!raw.campuses || !Object.keys(raw.campuses).length) {
    console.error('config.json needs at least one entry under "campuses".');
    process.exit(1);
  }
  return {
    org: raw.org,
    port: Number(process.env.PORT || raw.port || 8080),
    timezone: raw.timezone || "America/Los_Angeles",
    dailyPullAt: raw.dailyPullAt || "04:00",
    refreshMinutes: raw.refreshMinutes ?? 15,
    hidePastAfterMinutes: raw.hidePastAfterMinutes === undefined ? 15 : raw.hidePastAfterMinutes,
    campuses: raw.campuses,
    espace: {
      token: process.env.ESPACE_TOKEN || e.token || "",
      baseUrl: (e.baseUrl || "https://api.espace.cool/api/v2").replace(/\/$/, ""),
      eventsPath: e.eventsPath || "/event/occurrences",
      query: e.query || { startDate: "{date}", endDate: "{date}", locationId: "{locationId}" },
      onlyApproved: e.onlyApproved ?? true,
      onlyPublic: e.onlyPublic ?? false,
    },
  };
}
const cfg = loadConfig();
const DEMO = !cfg.espace.token;
if (!DEMO && fs.existsSync(CONFIG_PATH) && /"token"\s*:/.test(fs.readFileSync(CONFIG_PATH, "utf8")) && !process.env.ESPACE_TOKEN) {
  console.warn("Warning: the eSPACE token is in config.json. Move it to .env (ESPACE_TOKEN=...) so it can't be shared by accident.");
}
fs.mkdirSync(DATA_DIR, { recursive: true });

// ----------------------------------------------------------------- time -----
const tzOf = (key: string): string => cfg.campuses[key].timezone || cfg.timezone;
const todayIn = (tz: string): string => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date()); // YYYY-MM-DD
const hhmmIn = (tz: string): string => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());

// ---------------------------------------------------------------- state -----
// state[campus] = { date, events, updated, ok, error, lastAttempt }
const state: Record<string, CampusState> = {};
for (const key of Object.keys(cfg.campuses)) {
  state[key] = readCache(key) || { date: null, events: [], updated: null, ok: false, error: null };
}
function cacheFile(key: string): string { return path.join(DATA_DIR, `${key}.json`); }
function readCache(key: string): CampusState | null {
  try { return JSON.parse(fs.readFileSync(cacheFile(key), "utf8")) as CampusState; } catch { return null; }
}
function writeCache(key: string, s: CampusState): void {
  try { fs.writeFileSync(cacheFile(key), JSON.stringify(s, null, 2)); } catch (e) { log(key, `cache write failed: ${errMsg(e)}`); }
}
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
function log(key: string, msg: string): void { console.log(`${new Date().toISOString()} [${key}] ${msg}`); }

// ---------------------------------------------------------------- eSPACE ----
async function pull(key: string): Promise<CampusState> {
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
    q.set(k, String(v).replace("{date}", date).replace("{locationId}", String(campus.locationId ?? "")));
  }
  const url = `${cfg.espace.baseUrl}${cfg.espace.eventsPath}?${q}`;
  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${cfg.espace.token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30000),
    });
    if (r.status === 401) throw new Error("eSPACE rejected the token (401). Request a new one and update ESPACE_TOKEN in .env.");
    if (!r.ok) throw new Error(`eSPACE returned HTTP ${r.status}`);
    const raw = (await r.json()) as unknown;
    const list: EspaceOccurrence[] = Array.isArray(raw)
      ? raw
      : ((raw as Record<string, unknown>)?.Data ?? (raw as Record<string, unknown>)?.data ??
         (raw as Record<string, unknown>)?.Items ?? (raw as Record<string, unknown>)?.items ?? []) as EspaceOccurrence[];
    const events = list
      .map(mapOccurrence)
      .filter((e): e is MappedEvent => e !== null)
      .filter(e => !cfg.espace.onlyApproved || e.approved)
      .filter(e => !cfg.espace.onlyPublic || e.public)
      .filter(e => !(campus.hideRooms || []).some(h => e.rooms.includes(h)))
      .map(({ title, start, end, rooms }): BoardEvent => ({ title, start, end, rooms }))
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    state[key] = { date, events, updated: new Date().toISOString(), ok: true, error: null, lastAttempt: state[key].lastAttempt };
    writeCache(key, state[key]);
    log(key, `pulled ${events.length} events for ${date}`);
  } catch (e) {
    // Keep showing the last good pull for today; flag it as stale.
    state[key].ok = false;
    state[key].error = errMsg(e);
    log(key, `pull failed: ${errMsg(e)}`);
  }
  return state[key];
}

// The one place that knows eSPACE's field names.
// Check one real response in Swagger (https://api.espace.cool/swagger/ui/index) and adjust.
// Once confirmed, replace EspaceOccurrence with a real interface and the compiler
// will flag every field name that doesn't match.
const pick = (o: EspaceOccurrence, ...keys: string[]): unknown => {
  for (const k of keys) if (o[k] != null && o[k] !== "") return o[k];
  return undefined;
};

function mapOccurrence(o: EspaceOccurrence): MappedEvent | null {
  const title = pick(o, "EventName", "Name", "Title", "name", "title");
  const start = pick(o, "EventStart", "StartDate", "Start", "startDate", "start"); // event time, not setup-inclusive
  const end = pick(o, "EventEnd", "EndDate", "End", "endDate", "end");
  if (typeof title !== "string" || typeof start !== "string" || typeof end !== "string") return null;
  const spaces = (pick(o, "Spaces", "spaces", "Items", "items") ?? []) as EspaceOccurrence[];
  const status = String(pick(o, "Status", "OccurrenceStatus", "status") ?? "Approved");
  return {
    title,
    start,
    end,
    rooms: spaces.map(s => pick(s, "Name", "SpaceName", "name")).filter((n): n is string => typeof n === "string"),
    approved: /approved|confirmed/i.test(status),
    public: pick(o, "IsPublic", "isPublic", "Public") !== false,
  };
}

async function pullAll(reason: string): Promise<void> {
  console.log(`${new Date().toISOString()} pulling all campuses (${reason})`);
  await Promise.all(Object.keys(cfg.campuses).map(pull));
}

// -------------------------------------------------------------- schedule ----
// 1. A full pull at dailyPullAt (campus local time).
// 2. Optional refresh every refreshMinutes to catch same-day changes (0 = daily only).
// 3. An automatic pull whenever a campus rolls over to a new date.
function startSchedule(): void {
  const lastDaily: Record<string, string> = {};
  let minutes = 0;
  setInterval(() => {
    minutes++;
    for (const key of Object.keys(cfg.campuses)) {
      const tz = tzOf(key);
      const date = todayIn(tz);
      const due =
        (hhmmIn(tz) === cfg.dailyPullAt && lastDaily[key] !== date) ||
        (state[key].date !== date && Date.now() - new Date(state[key].lastAttempt ?? 0).getTime() > 5 * 60000) ||
        (cfg.refreshMinutes > 0 && minutes % cfg.refreshMinutes === 0);
      if (hhmmIn(tz) === cfg.dailyPullAt) lastDaily[key] = date;
      if (due) pull(key);
    }
  }, 60 * 1000);
}

// ---------------------------------------------------------------- server ----
const send = (
  res: http.ServerResponse,
  status: number,
  body: unknown,
  type = "application/json; charset=utf-8",
  extra: Record<string, string> = {},
): void => {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...extra });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

function boardPayload(key: string) {
  const c = cfg.campuses[key];
  const s = state[key];
  const tz = tzOf(key);
  const today = todayIn(tz);
  return {
    org: cfg.org || "",
    campus: c.label || key,
    timezone: tz,
    hidePastAfterMinutes: c.hidePastAfterMinutes === undefined ? cfg.hidePastAfterMinutes : c.hidePastAfterMinutes,
    demo: DEMO || undefined,
    // Never show yesterday's list on today's board.
    events: s.date === today ? s.events : [],
    updated: s.updated,
    stale: !s.ok || s.date !== today,
    error: s.error || undefined,
  };
}

function indexPage(): string {
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
  const url = new URL(req.url ?? "/", "http://x");
  const p = url.pathname.replace(/\/+$/, "") || "/";

  if (p === "/") return send(res, 200, indexPage(), "text/html; charset=utf-8");

  const board = p.match(/^\/board\/([\w-]+)$/);
  if (board) {
    if (!cfg.campuses[board[1]]) return send(res, 404, `Unknown campus "${board[1]}".`, "text/plain");
    return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, "index.html")), "text/html; charset=utf-8");
  }

  const api = p.match(/^\/api\/today\/([\w-]+)$/);
  if (api || p === "/api/today") {
    const key = api ? api[1] : url.searchParams.get("campus") ?? "";
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
void (async () => {
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
