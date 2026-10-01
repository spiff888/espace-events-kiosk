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
/** Brand colors and fonts for the TV page. Every key is optional; unset keys keep the default look. */
interface ThemeConfig {
  background?: string;   // page background
  surface?: string;      // column header band and the "Now" row
  rule?: string;         // lines between rows and columns
  text?: string;         // main text
  textMuted?: string;    // dates, rooms, "until" times
  textFaint?: string;    // footer
  accent?: string;       // campus name, "Now" tag and stripe
  accentText?: string;   // text on the "Now" tag
  next?: string;         // "Next" tag
  fontDisplay?: string;  // CSS font-family for headings and times
  fontBody?: string;     // CSS font-family for everything else
  displayWeight?: number;      // use 400 for single-weight faces like Bebas Neue
  displayWeightLight?: number;
  fontsUrl?: string;     // stylesheet URL that loads the fonts, e.g. Google Fonts
}

interface CampusConfig {
  label?: string;
  theme?: ThemeConfig;
  locationId?: string | number;
  timezone?: string;
  hideRooms?: string[];       // events in these rooms are left off this campus's board entirely
  stripRooms?: string[];      // regex patterns; matching text is removed from room names (Room column only)
  hidePastAfterMinutes?: number | null;
}

interface EspaceConfig {
  /** API key (a UUID) generated in eSPACE. The server trades it for a JWT itself. */
  apiKey: string;
  /** A JWT pasted directly. Optional; apiKey is simpler. */
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
  /** "both": event name, schedule name underneath when different (default). "event": event name only. "schedule": schedule name, falling back to event name. */
  eventTitle: "both" | "event" | "schedule";
  /** Regex patterns for text to remove from room names on every campus (e.g. ",\\s*Room \\d+$"). Names left empty are dropped. */
  stripRooms: string[];
  theme: ThemeConfig;
  espace: EspaceConfig;
  campuses: Record<string, CampusConfig>;
}

/** One booking as the TV page receives it. */
export interface BoardEvent {
  title: string;
  subtitle?: string;     // eSPACE schedule name, when it adds something
  start: string; // ISO 8601
  end: string;
  rooms: string[];
  allDay?: boolean;
  /** eSPACE occurrence id. Used by /api/v1/events, left off the TV payload. */
  id?: string;
  /** Room names exactly as eSPACE sends them, before stripRooms. Used by /api/v1/events. */
  roomsRaw?: string[];
}

interface MappedEvent extends BoardEvent {
  approved: boolean;
  public: boolean;
  cancelled: boolean;
  status: string;
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

/**
 * One record from GET /api/v2/event/occurrences, per eSPACE's published Swagger spec
 * (https://api.espace.cool/v2/swagger). Only the fields this app reads are listed.
 * Contacts are deliberately left out so names and emails never reach a public screen.
 */
interface EspaceOccurrence {
  OccurrenceId?: number;
  EventId?: number;
  EventName?: string;
  ScheduleId?: number;
  ScheduleName?: string;   // e.g. event "Weekend Services", schedule "Content Check"
  EventStart?: string;     // occurrence start (excludes setup)
  EventEnd?: string;       // occurrence end (excludes teardown)
  IsAllDay?: boolean;
  OccurrenceStatus?: string;
  EventStatus?: string;
  IsFinalApproved?: boolean;
  IsPublic?: boolean;
  Items?: EspaceOccurrenceItem[];
}

interface EspaceOccurrenceItem {
  ItemId?: number;
  ItemType?: string;       // "Space" | "Resource" | "Service"
  Name?: string;
}

/** GET /api/v2/ministry/locations */
export interface EspaceLocation {
  Id: number;
  Name: string;
  LocationCode?: string;
}

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
    eventTitle: raw.eventTitle === "event" || raw.eventTitle === "schedule" ? raw.eventTitle : "both",
    stripRooms: raw.stripRooms ?? [],
    campuses: raw.campuses,
    theme: raw.theme ?? {},
    espace: {
      apiKey: process.env.ESPACE_API_KEY || e.apiKey || "",
      token: process.env.ESPACE_TOKEN || e.token || "",
      baseUrl: (e.baseUrl || "https://api.espace.cool/api/v2").replace(/\/$/, ""),
      eventsPath: e.eventsPath || "/event/occurrences",
      // endDate is "ends on/before", so ask through tomorrow and keep only events touching today.
      query: e.query || { startDate: "{date}", endDate: "{nextDate}", locationIds: "{locationId}", topX: "2000" },
      onlyApproved: e.onlyApproved ?? true,
      onlyPublic: e.onlyPublic ?? false,
    },
  };
}
const cfg = loadConfig();
const DEMO = !cfg.espace.token && !cfg.espace.apiKey;
if (!DEMO && fs.existsSync(CONFIG_PATH) && /"(token|apiKey)"\s*:/.test(fs.readFileSync(CONFIG_PATH, "utf8")) && !process.env.ESPACE_TOKEN) {
  console.warn("Warning: an eSPACE key or token is in config.json. Move it to .env (ESPACE_API_KEY=...) so it can't be shared by accident.");
}
fs.mkdirSync(DATA_DIR, { recursive: true });

// ----------------------------------------------------------------- time -----
const tzOf = (key: string): string => cfg.campuses[key].timezone || cfg.timezone;
const todayIn = (tz: string): string => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date()); // YYYY-MM-DD
const hhmmIn = (tz: string): string => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());

// ---------------------------------------------------------------- state -----
// state[campus] = { date, events, updated, ok, error, lastAttempt }
const state: Record<string, CampusState> = {};
interface SkippedEvent { title: string; start: string; reason: string }
/** Events left off each campus's board on the last pull, and why (shown by --pull-now). */
const lastSkipped: Record<string, SkippedEvent[]> = {};
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
  const nextDate = addDays(date, 1);
  for (const [k, v] of Object.entries(cfg.espace.query)) {
    q.set(k, String(v).replace("{date}", date).replace("{nextDate}", nextDate).replace("{locationId}", String(campus.locationId ?? "")));
  }
  const url = `${cfg.espace.baseUrl}${cfg.espace.eventsPath}?${q}`;
  try {
    const raw = await espaceGet(url);
    if (!Array.isArray(raw)) throw new Error("eSPACE sent an unexpected reply for events (not a list).");
    const list = raw as EspaceOccurrence[];
    const stripPatterns = [...cfg.stripRooms, ...(campus.stripRooms ?? [])].map(p => new RegExp(p, "gi"));
    const skipped: SkippedEvent[] = [];
    const keep = (e: MappedEvent, ok: boolean, reason: string): boolean => {
      if (!ok) skipped.push({ title: e.title, start: e.start, reason });
      return ok;
    };
    const events = list
      .map(mapOccurrence)
      .filter((e): e is MappedEvent => e !== null)
      .filter(e => e.start.slice(0, 10) <= date && e.end.slice(0, 10) >= date) // touches today
      .filter(e => keep(e, !e.cancelled, `cancelled (${e.status})`))
      .filter(e => keep(e, !cfg.espace.onlyApproved || e.approved, `not approved (${e.status || "no status"})`))
      .filter(e => keep(e, !cfg.espace.onlyPublic || e.public, "not public"))
      .filter(e => keep(e, !(campus.hideRooms || []).some(h => e.rooms.includes(h)), "in a hidden room"))
      .map(({ id, title, subtitle, start, end, rooms, allDay }): BoardEvent => ({
        title,
        ...(subtitle ? { subtitle } : {}),
        start,
        end,
        rooms: stripRoomNames(rooms, stripPatterns),
        ...(allDay ? { allDay } : {}),
        ...(id ? { id } : {}),
        roomsRaw: [...new Set(rooms)],
      }))
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    lastSkipped[key] = skipped;
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
const CANCELLED = /cancel|denied|declin|reject|delet/i;
const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

function mapOccurrence(o: EspaceOccurrence): MappedEvent | null {
  if (!o.EventName || !o.EventStart || !o.EventEnd) return null;
  const event = o.EventName.trim();
  const schedule = (o.ScheduleName ?? "").trim();
  const distinct = schedule !== "" && !same(schedule, event);
  const title = cfg.eventTitle === "schedule" && schedule ? schedule : event;
  const subtitle = cfg.eventTitle === "both" && distinct ? schedule : undefined;
  const status = [o.OccurrenceStatus, o.EventStatus].filter(Boolean).join(" / ");
  return {
    id: o.OccurrenceId != null ? String(o.OccurrenceId) : undefined,
    title,
    subtitle,
    start: o.EventStart,
    end: o.EventEnd,
    allDay: o.IsAllDay === true,
    // Items mixes rooms with equipment and services; only rooms belong on the board.
    rooms: (o.Items ?? [])
      .filter(i => (i.ItemType ?? "Space").toLowerCase() === "space")
      .map(i => i.Name?.trim())
      .filter((n): n is string => typeof n === "string" && n !== ""),
    // A cancelled occurrence can still carry IsFinalApproved: true, so check status separately.
    cancelled: CANCELLED.test(o.OccurrenceStatus ?? "") || CANCELLED.test(o.EventStatus ?? ""),
    approved: o.IsFinalApproved ?? /approved|confirmed/i.test(status),
    public: o.IsPublic !== false,
    status,
  };
}

/** Remove duplicate and pattern-matched room names, but never strip a room list down to nothing. */
/**
 * Remove text matching the stripRooms patterns from each room name, then drop names left
 * empty and duplicates. eSPACE often sends a name and number as one string
 * ("AN Meeting Room A, Room 1018"), so a pattern like ",\s*Room \d+$" trims the number,
 * while "^Room \d+$" removes a room that is only a number. Never empties the list.
 */
function stripRoomNames(rooms: string[], patterns: RegExp[]): string[] {
  const unique = [...new Set(rooms)];
  const cleaned = unique
    .map(r => patterns.reduce((name, p) => name.replace(p, ""), r).replace(/^[\s,;\-–]+|[\s,;\-–]+$/g, ""))
    .filter(r => r !== "");
  const result = [...new Set(cleaned)];
  return result.length ? result : unique;
}

const addDays = (ymd: string, n: number): string => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// ------------------------------------------------------------ eSPACE auth ----
// eSPACE issues a JWT (valid about a year) in exchange for an API key. We request it
// on first use, keep it in memory only, and request a new one if eSPACE ever answers 401.
let jwt: string | null = null;

async function getToken(forceNew = false): Promise<string> {
  if (cfg.espace.token && !cfg.espace.apiKey) return cfg.espace.token;
  if (jwt && !forceNew) return jwt;
  const r = await fetch(`${cfg.espace.baseUrl}/requesttoken`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ apiKey: cfg.espace.apiKey }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`eSPACE didn't accept the API key (HTTP ${r.status}). Check ESPACE_API_KEY in .env.`);
  const text = (await r.text()).trim();
  let token = text;
  if (text.startsWith('"')) token = JSON.parse(text) as string;           // plain JSON string (what eSPACE sends today)
  else if (text.startsWith("{")) token = String(unwrap(JSON.parse(text)) ?? ""); // enveloped, just in case
  if (!token) throw new Error("eSPACE returned an empty token.");
  jwt = token;
  return jwt;
}

async function espaceGet(url: string): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(attempt > 0);
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30000),
    });
    if (r.status === 401 && attempt === 0 && cfg.espace.apiKey) continue; // token expired: get a new one once
    if (r.status === 401) throw new Error("eSPACE rejected the credentials (401). Check ESPACE_API_KEY in .env.");
    if (!r.ok) throw new Error(`eSPACE returned HTTP ${r.status}`);
    return unwrap(await r.json());
  }
  throw new Error("unreachable");
}

/**
 * eSPACE wraps replies in an envelope: { IsSuccessStatusCode, Message, Data }.
 * (Its Swagger spec doesn't show this; confirmed against a live account.)
 * Returns Data, or throws eSPACE's own message when it reports a failure.
 */
function unwrap(body: unknown): unknown {
  if (body && typeof body === "object" && !Array.isArray(body) && "Data" in body) {
    const env = body as { IsSuccessStatusCode?: boolean; Message?: string | null; Data: unknown };
    if (env.IsSuccessStatusCode === false) throw new Error(`eSPACE reported an error: ${env.Message ?? "no details"}`);
    return env.Data;
  }
  return body;
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
    events: (s.date === today ? s.events : []).map(({ id: _id, roomsRaw: _raw, ...e }) => e),
    updated: s.updated,
    stale: !s.ok || s.date !== today,
    error: s.error || undefined,
  };
}

/**
 * Machine-readable feed for integrations (e.g. a camera/VMS sync), versioned so the TV
 * payload can change freely. Same events as the board (same approval, cancellation,
 * public and hidden-room rules), but with eSPACE's original room names, the occurrence
 * id, and start/end as ISO 8601 with the campus's UTC offset.
 */
function feedPayload(key: string) {
  const s = state[key];
  const tz = tzOf(key);
  const today = todayIn(tz);
  return {
    version: 1,
    campus: key,
    timezone: tz,
    date: today,
    updated: s.updated,
    stale: !s.ok || s.date !== today,
    events: (s.date === today ? s.events : []).map(e => ({
      id: e.id ?? `${e.start}|${e.title}`,
      title: e.title,
      rooms: e.roomsRaw ?? e.rooms,
      start: withOffset(e.start, tz),
      end: withOffset(e.end, tz),
      ...(e.allDay ? { allDay: true } : {}),
    })),
  };
}

/** Minutes the zone is ahead of UTC at a given instant. */
function tzOffsetMinutes(ms: number, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(ms).map(p => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - ms) / 60000);
}

/** "2026-10-04T10:00:00" (campus wall time) -> "2026-10-04T10:00:00-07:00". Leaves times that already have an offset alone. */
function withOffset(local: string, tz: string): string {
  if (/(Z|[+-]\d\d:?\d\d)$/i.test(local)) return local;
  const m = local.match(/^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d))?/);
  if (!m) return local;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
  let off = tzOffsetMinutes(wall, tz);
  off = tzOffsetMinutes(wall - off * 60000, tz); // second pass settles DST edges
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}${sign}${hh}:${mm}`;
}

// ----------------------------------------------------------------- theme ----
const THEME_VARS: Record<keyof ThemeConfig, string | null> = {
  background: "--ground", surface: "--band", rule: "--row-rule",
  text: "--ink", textMuted: "--ink-soft", textFaint: "--ink-faint",
  accent: "--now", accentText: "--now-ink", next: "--next",
  fontDisplay: "--display", fontBody: "--body",
  displayWeight: "--display-weight", displayWeightLight: "--display-weight-light",
  fontsUrl: null,
};
const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FONT_RE = /^[\w\s"',.-]+$/;

/** Builds the <style>/<link> tags for a campus. Values are validated so config can't inject markup. */
function themeTags(key: string): string {
  const t: ThemeConfig = { ...cfg.theme, ...(cfg.campuses[key].theme ?? {}) };
  const decls: string[] = [];
  for (const [k, v] of Object.entries(t) as [keyof ThemeConfig, unknown][]) {
    const cssVar = THEME_VARS[k];
    if (!cssVar || v == null) continue;
    const ok =
      k.startsWith("font") ? typeof v === "string" && FONT_RE.test(v)
      : k.startsWith("displayWeight") ? typeof v === "number" && v >= 100 && v <= 900
      : typeof v === "string" && COLOR_RE.test(v);
    if (ok) decls.push(`${cssVar}: ${v};`);
    else console.warn(`[${key}] ignoring theme.${k}: ${JSON.stringify(v)} is not valid`);
  }
  let out = "";
  if (typeof t.fontsUrl === "string" && /^https:\/\/[^"<>\s]+$/.test(t.fontsUrl)) {
    out += `<link rel="stylesheet" href="${t.fontsUrl}">\n`;
  }
  if (decls.length) out += `<style>:root { ${decls.join(" ")} }</style>\n`;
  return out;
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
    const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8").replace("<!--theme-->", themeTags(board[1]));
    return send(res, 200, html, "text/html; charset=utf-8");
  }

  const api = p.match(/^\/api\/today\/([\w-]+)$/);
  if (api || p === "/api/today") {
    const key = api ? api[1] : url.searchParams.get("campus") ?? "";
    if (!cfg.campuses[key]) return send(res, 404, { error: `Unknown campus "${key}".` });
    return send(res, 200, boardPayload(key), undefined, { "Access-Control-Allow-Origin": "*" });
  }

  const feed = p.match(/^\/api\/v1\/events\/([\w-]+)$/);
  if (feed) {
    if (!cfg.campuses[feed[1]]) return send(res, 404, { error: `Unknown campus "${feed[1]}".` });
    return send(res, 200, feedPayload(feed[1]));
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
  if (process.argv.includes("--locations")) {
    if (DEMO) { console.error("Set ESPACE_API_KEY in .env first."); process.exit(1); }
    try {
      const raw = await espaceGet(`${cfg.espace.baseUrl}/ministry/locations`);
      if (!Array.isArray(raw)) throw new Error("eSPACE sent an unexpected reply for locations (not a list).");
      const list = raw as EspaceLocation[];
      console.log("eSPACE locations (use the Id as locationId in config.json):\n");
      for (const l of list) console.log(`  ${String(l.Id).padEnd(8)} ${l.Name}${l.LocationCode ? `  (${l.LocationCode})` : ""}`);
      process.exit(0);
    } catch (e) { console.error(errMsg(e)); process.exit(1); }
  }
  if (process.argv.includes("--pull-now")) {
    await pullAll("--pull-now");
    for (const k of Object.keys(cfg.campuses)) {
      const s = state[k];
      console.log(`${k}: ${s.ok ? "ok" : "FAILED"} · ${s.events.length} events · ${s.error || ""}`);
      for (const e of s.events) console.log(`   ${e.start}  ${e.title}${e.subtitle ? ` · ${e.subtitle}` : ""}  [${e.rooms.join(", ")}]`);
      for (const x of lastSkipped[k] ?? []) console.log(`   (skipped) ${x.start}  ${x.title}: ${x.reason}`);
    }
    process.exit(Object.values(state).every(s => s.ok) ? 0 : 1);
  }
  if (DEMO) console.log("No eSPACE token configured: running in demo mode with sample events.");
  await pullAll("startup");
  startSchedule();
  server.listen(cfg.port, () => console.log(`Campus Board listening on http://0.0.0.0:${cfg.port}`));
})();
