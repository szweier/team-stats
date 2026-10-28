// Team website for Slow Pitch Book.
//
// Players sign in with an emailed link and can be on any number of teams. Each team (teams/{teamId} in
// Firestore) has members, managers and the app's scorers. Members see the schedule, mark whether they can
// make each game, and see the stats the app publishes; managers add games and invite people. The app's
// scorer code links a team made in the app to the website (entering it here makes you its manager).
// Security lives in firestore.rules; this page only shows what the rules let the signed-in person see.

(() => {
  "use strict";

  const cfg = window.STATBOOK_CONFIG || {};
  const params = new URLSearchParams(location.search);
  const DEMO = params.has("demo");
  const clean = s => (s || "").replace(/[^A-Za-z0-9]/g, "");
  const TEAM = DEMO ? "demo" : clean(params.get("t"));
  const JOIN = clean(params.get("join"));
  const CLAIM = clean(params.get("claim")).toUpperCase();
  const SITE = location.origin + location.pathname;
  const REFRESH_MS = 20000;
  const app = document.getElementById("app");

  const storage = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) {
      try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ }
    },
  };

  const state = {
    profile: null,        // { name, email, teams: { teamId: name } }
    key: null,            // open team's id
    team: null,           // { name, members, managers, editors }
    board: null,          // { name } (for the stats views)
    games: [],            // PublishedGame objects, newest first
    schedule: [],         // [{ id, date, time, opponent, location, notes, availability }] (home/away is picked when the game starts)
    members: [],          // [{ uid, name }]
    settings: null,       // { scorerCode, inviteCode } (managers)
    signature: "",
    updated: null,
    books: {},
    editing: null,        // schedule game being edited: id, "new", or null
    editingLineup: null,  // schedule game whose batting order a manager is setting
    tossFor: null,
    fixingScore: null,    // game page: { id, runs } while fixing the other team's runs on an app-scored game        // Schedule: the game whose coin toss is being asked before Keep Score
    themeDraft: null,     // Team tab: colors an admin is previewing (not saved yet)
    linking: null,        // member a manager is linking to scorebook names (Team tab)
    links: [],            // scorebook name → member links (teams/{t}/links)
    names: [],            // scorebook name → name renames and merges (teams/{t}/names)
    otherTeams: null,     // Team tab: your other teams' players to add ("loading", or [{ id, name, people }])
    scored: {},           // game id → { stamp, game }: the full web-scored game for the drawn scorebook
    renaming: null,       // scorebook name an admin is renaming (Team tab)
    statsSort: { col: "avg", dir: -1 },
    statsMode: "leaders", // Stats: "leaders" (top five in each category) or "table" (every player)
    statsTeam: "",
    sprayPlayer: "",
    sprayGame: "",
    event: savedEvent(),  // null = the newest season, "all" = every game, or a season / tournament key
    gamePlayer: {},
    myScope: "",          // My Stats: "" = this team, "all" = every team you're on, or another team's id
    myAll: null,          // those games once loaded (or "loading")
    myYear: "",
    flash: "",            // one-time message shown at the top of a page
  };

  // ---------- Small DOM helper (text always goes in as text, never as HTML) ----------

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "svg") el.innerHTML = v;   // only SVG this file builds from numbers
      else if (k === "value") el.value = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  // ---------- Formatting ----------

  function parseDate(s) {
    const [y, m, d] = String(s || "").split("-").map(Number);
    return y ? new Date(y, (m || 1) - 1, d || 1) : null;
  }
  const fmtDate = s => {
    const d = parseDate(s);
    return d ? d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
  };
  const fmtDay = s => {
    const d = parseDate(s);
    return d ? d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : "";
  };
  const title = g => (g.opponent ? (g.isHome ? "vs " : "@ ") + g.opponent : "Game");

  // ---------- Seasons & tournaments (set per game in the app) ----------

  const eventKey = g => (g.event ? `${g.eventKind || "season"}|${g.event.toLowerCase()}` : "none");
  const eventLabel = e => (e.kind === "tournament" ? `${e.name} (Tournament)` : e.name);

  /// Seasons and tournaments in the order of their most recent game.
  function eventsOf(games) {
    const seen = new Map();
    for (const g of games) {
      if (g.event && !seen.has(eventKey(g))) seen.set(eventKey(g), { key: eventKey(g), name: g.event, kind: g.eventKind || "season" });
    }
    return [...seen.values()];
  }

  /// The newest season (by its most recent game), or "" when no game has one.
  function newestSeason(games = state.games) {
    const sorted = [...games].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    return eventsOf(sorted).find(e => e.kind !== "tournament")?.key || "";
  }

  /// What someone picked last time, unless a newer season has started since (then it's the new one).
  function savedEvent() {
    try {
      const v = JSON.parse(storage.get("statbook.event2") || "null");
      return v && typeof v.pick === "string" ? v : null;
    } catch { return null; }
  }
  function chooseEvent(pick) {
    state.event = { pick, newest: newestSeason() };
    storage.set("statbook.event2", JSON.stringify(state.event));
  }

  /// The season filter in use: the newest season by default; "" means every game.
  function currentEvent() {
    const newest = newestSeason();
    const e = state.event;
    if (!e || e.newest !== newest) return newest;
    if (e.pick === "all") return "";
    if (e.pick === "none") return state.games.some(g => !g.event) ? "none" : newest;
    return state.games.some(g => eventKey(g) === e.pick) ? e.pick : newest;
  }

  const inEvent = g => !currentEvent() || eventKey(g) === currentEvent();

  function currentEventLabel() {
    const key = currentEvent();
    if (!key) return "";
    if (key === "none") return "No season";
    const e = eventsOf(state.games).find(x => x.key === key);
    return e ? eventLabel(e) : "";
  }

  /// The season picker in the header: the record shown, laid over an invisible dropdown so tapping it opens the
  /// phone's own list. The season chosen applies to every page (Games, Stats, My Stats, Spray).
  function seasonPicker(shown) {
    const events = eventsOf(state.games);
    const label = currentEventLabel() || (events.length ? "All seasons" : "Record");
    const short = events.find(e => e.key === currentEvent())?.name || label;   // no "(Tournament)" up here
    const face = [h("b", null, record(shown)), h("span", { class: "sub season" },
      h("span", { class: "season-name" }, short), events.length ? h("span", { class: "caret", "aria-hidden": "true" }, "▾") : null)];
    if (!events.length) return h("div", { class: "record" }, face);
    const key = currentEvent();
    const option = (value, text) => { const o = h("option", { value }, text); if (value === key) o.selected = true; return o; };
    const seasons = events.filter(e => e.kind !== "tournament");
    const tournaments = events.filter(e => e.kind === "tournament");
    const sel = h("select", {
      class: "season-select", "aria-label": `Season: ${label}. Choose a season or tournament`,
      onchange: e => { chooseEvent(e.target.value || "all"); render(); },
    },
      option("", "All seasons"),
      seasons.length ? h("optgroup", { label: "Seasons" }, seasons.map(e => option(e.key, e.name))) : null,
      tournaments.length ? h("optgroup", { label: "Tournaments" }, tournaments.map(e => option(e.key, e.name))) : null,
      state.games.some(g => !g.event) ? option("none", "No season") : null);
    return h("label", { class: "record picker" }, face, sel);
  }
  const us = g => g.team || "Us";
  const them = g => g.opponent || "Them";
  const rate = x => { const s = (x || 0).toFixed(3); return s.startsWith("0.") ? s.slice(1) : s; };
  const ordinal = n => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th"));

  // ---------- Stats ----------

  const FIELDS = ["pa", "ab", "r", "crr", "h", "b1", "b2", "b3", "hr", "rbi", "bb", "sf", "roe", "fc",
                  "kl", "ks", "kf", "hro", "go", "fo", "lo", "po", "dp", "tp"];

  function derive(l) {
    const tb = l.b1 + 2 * l.b2 + 3 * l.b3 + 4 * l.hr;
    const obpDen = l.ab + l.bb + l.sf;
    const avg = l.ab ? l.h / l.ab : 0;
    const obp = obpDen ? (l.h + l.bb) / obpDen : 0;
    const slg = l.ab ? tb / l.ab : 0;
    return { ...l, tb, k: l.kl + l.ks + l.kf, avg, obp, slg, ops: obp + slg };
  }

  /// Season totals by player, like the app's Season screen (a game counts if they batted or scored).
  /// Players the app linked to a teammate's account count as one person whatever name they were scored under.
  function seasonLines(games) {
    const by = new Map();
    for (const g of games) {
      for (const l of g.lines || []) {
        if (!(l.pa > 0 || l.r > 0 || l.crr > 0)) continue;
        const name = String(l.name || "").trim();
        const key = l.member ? `m:${l.member}` : `n:${name.toLowerCase()}`;
        const s = by.get(key) || Object.fromEntries([["name", name], ["g", 0], ...FIELDS.map(f => [f, 0])]);
        s.g += 1;
        for (const f of FIELDS) s[f] += l[f] || 0;
        by.set(key, s);
      }
    }
    return [...by.values()].map(derive);
  }

  /// Each pitcher's totals over `games`, matched like batting lines (by account, else by name).
  function seasonPitching(games) {
    const by = new Map();
    for (const g of games) {
      if (!g.isFinal) continue;
      for (const l of g.pitching || []) {
        const name = String(l.name || "").trim();
        const key = l.member ? `m:${l.member}` : `n:${name.toLowerCase()}`;
        const s = by.get(key) || { name, member: l.member, g: 0, gs: 0, w: 0, l: 0, outs: 0, r: 0 };
        s.g += 1; s.gs += l.gs || 0; s.w += l.w || 0; s.l += l.l || 0; s.outs += l.outs || 0; s.r += l.r || 0;
        by.set(key, s);
      }
    }
    return [...by.values()].map(pitchDerive);
  }
  const inningsText = outs => `${Math.floor(outs / 3)}${outs % 3 ? "." + (outs % 3) : ""}`;   // 13 outs → "4.1"
  const pitchDerive = s => ({ ...s, ip: inningsText(s.outs), era: s.outs ? (s.r * 21) / s.outs : null });
  const PITCHING = [
    { key: "name", label: "Pitcher" },
    { key: "g", label: "G", title: "Games pitched" },
    { key: "gs", label: "GS", title: "Games started" },
    { key: "w", label: "W" }, { key: "l", label: "L" },
    { key: "ip", label: "IP", title: "Innings pitched" },
    { key: "r", label: "R", title: "Runs allowed" },
    { key: "era", label: "ERA", title: "Runs allowed per 7 innings", value: r => (r.era == null ? "–" : r.era.toFixed(2)) },
  ];
  const PITCH_NOTE = "IP = innings pitched (4.1 = four innings and one out). ERA = runs allowed per 7 innings; every run counts, since errors aren't tracked. The win or loss goes to whoever pitched the most that game.";

  /// Linked players show the name on their account now, so a rename never needs the app.
  /// Links a manager made on the Team tab (scorebook name → member), then shows every linked player under the
  /// name on their account now, so stats follow the person whatever name they were scored under.
  // A "/" stays inside the id (the database would read a plain one as a folder).
  const linkKey = name => encodeURIComponent(String(name || "").trim().toLowerCase()).replace(/\./g, "%2E").replace(/%2F/g, "%252F");
  /// A scorebook name after an admin's renames and merges ("Mike C" → "Mike Carter"), following chains.
  function renamed(name, renames) {
    let n = String(name || "").trim();
    for (let i = 0; i < 6; i++) {
      const to = renames.get(linkKey(n));
      if (!to || to.trim().toLowerCase() === n.toLowerCase()) break;
      n = to.trim();
    }
    return n;
  }
  /// { name, member? } → the name to show: the member's own name when linked, else after renames.
  function nameMapper(members, links = [], names = []) {
    const memberNames = new Map(members.map(m => [m.uid, m.name]));
    const linked = new Map(links.filter(l => memberNames.has(l.uid)).map(l => [l.id, l.uid]));
    const renames = new Map(names.map(r => [r.id, r.to]));
    // Like the app: a name that's exactly a teammate's account name is that teammate.
    const byName = new Map(members.filter(m => m.name).map(m => [linkKey(m.name), m.uid]));
    return x => {
      const name = x.member ? x.name : renamed(x.name, renames);
      const member = x.member || linked.get(linkKey(name)) || linked.get(linkKey(x.name)) || byName.get(linkKey(name));
      if (member) return { ...x, member, name: memberNames.get(member) || name, scoredAs: x.name };
      return name !== x.name ? { ...x, name, scoredAs: x.name } : x;
    };
  }
  function withMemberNames(games, members, links = [], names = []) {
    const named = nameMapper(members, links, names);
    return games.map(g => ({ ...g, lines: (g.lines || []).map(named), spray: (g.spray || []).map(named),
      ...(g.pitching ? { pitching: g.pitching.map(named) } : {}) }));
  }
  /// A full scored game with everyone under the names the site shows (for the drawn scorebook).
  function withBookNames(g) {
    const named = nameMapper(state.members || [], state.links || [], state.names || []);
    const fix = ps => (ps || []).map(p => ({ ...named(p), id: p.id }));
    return { ...g, lineup: fix(g.lineup), bench: fix(g.bench), extras: fix(g.extras) };
  }

  function record(games) {
    let w = 0, l = 0, t = 0;
    for (const g of games) {
      if (g.outcome === "W") w++; else if (g.outcome === "L") l++; else if (g.outcome === "T") t++;
    }
    return t ? `${w}-${l}-${t}` : `${w}-${l}`;
  }

  // ---------- Firestore & sign-in (REST, no SDK) ----------

  const configured = () => DEMO || (cfg.projectId && cfg.apiKey && !/^YOUR-/.test(cfg.projectId) && !/^YOUR-/.test(cfg.apiKey));
  const DOCS = `projects/${cfg.projectId}/databases/(default)/documents`;

  class Forbidden extends Error {}

  function enc(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === "boolean") return { booleanValue: v };
    if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (typeof v === "string") return { stringValue: v };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
    return { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
  }
  function dec(v) {
    if (!v) return null;
    if ("stringValue" in v) return v.stringValue;
    if ("integerValue" in v) return Number(v.integerValue);
    if ("doubleValue" in v) return v.doubleValue;
    if ("booleanValue" in v) return v.booleanValue;
    if ("arrayValue" in v) return (v.arrayValue.values || []).map(dec);
    if ("mapValue" in v) return fieldsOf(v.mapValue);
    return null;
  }
  const fieldsOf = d => Object.fromEntries(Object.entries(d?.fields || {}).map(([k, v]) => [k, dec(v)]));
  const idOf = d => d.name.split("/").pop();
  const quote = f => (/^[A-Za-z_][A-Za-z_0-9]*$/.test(f) ? f : "`" + f + "`");

  // Session: { uid, email, idToken, refreshToken, expires }
  let session = null;
  try { session = JSON.parse(storage.get("statbook.session") || "null"); } catch { session = null; }
  const saveSession = s => { session = s; storage.set("statbook.session", s ? JSON.stringify(s) : null); };

  async function idToken() {
    if (!session) return null;
    if (session.expires > Date.now() + 60000) return session.idToken;
    const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${cfg.apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(session.refreshToken)}`,
    });
    if (!res.ok) { saveSession(null); return null; }
    const j = await res.json();
    saveSession({ ...session, idToken: j.id_token, refreshToken: j.refresh_token, expires: Date.now() + Number(j.expires_in || 3600) * 1000 });
    return session.idToken;
  }

  async function authCall(endpoint, body) {
    const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:${endpoint}?key=${cfg.apiKey}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const m = j.error?.message || `error ${res.status}`;
      throw new Error(m.includes("INVALID_OOB_CODE") || m.includes("EXPIRED_OOB_CODE")
        ? "That sign-in link expired or was already used. Send yourself a new one."
        : m.includes("INVALID_EMAIL") ? "That email address doesn't look right."
        : m.includes("OPERATION_NOT_ALLOWED") ? "Email sign-in isn't turned on for this site yet."
        // The site's daily allowance of sign-in emails is used up (shared by everyone), or one person asked too often.
        : m.includes("QUOTA_EXCEEDED") ? "Too many sign-in emails have been sent today. Try again tomorrow, or ask your team's manager."
        : m.includes("TOO_MANY_ATTEMPTS") ? "Too many tries in a row. Wait a few minutes, then send yourself a new link."
        : m.includes("UNAUTHORIZED_DOMAIN") ? "Sign-in isn't set up for this web address yet."
        : `Sign-in didn't work (${m}).`);
    }
    return j;
  }

  /// Where the emailed link brings you back to: this page with its team/invite, minus sign-in leftovers.
  function returnURL() {
    const u = new URL(location.href);
    for (const k of ["apiKey", "oobCode", "mode", "lang", "continueUrl", "tenantId", "handoff"]) u.searchParams.delete(k);
    u.hash = "";
    return u.toString();
  }

  async function sendSignInLink(email) {
    const continueUrl = new URL(returnURL());
    // From the home screen app the link carries a handoff id, so Safari can pass the login back to it.
    if (standalone()) {
      const id = randomCode(32, "abcdefghijklmnopqrstuvwxyz0123456789");
      continueUrl.searchParams.set("handoff", id);
      storage.set("statbook.handoff", JSON.stringify({ id, at: Date.now() }));
    }
    await authCall("sendOobCode", { requestType: "EMAIL_SIGNIN", email, continueUrl: continueUrl.toString(), canHandleCodeInApp: true });
    storage.set("statbook.pendingEmail", email);
  }

  async function finishSignIn(email, oobCode) {
    const j = await authCall("signInWithEmailLink", { email, oobCode });
    saveSession({ uid: j.localId, email: j.email || email, idToken: j.idToken, refreshToken: j.refreshToken,
                  expires: Date.now() + Number(j.expiresIn || 3600) * 1000 });
    storage.set("statbook.pendingEmail", null);
    storage.set("statbook.handoff", null);
    history.replaceState(null, "", returnURL());
  }

  // A web app saved to the iPhone home screen keeps its own login apart from Safari's, and emailed links
  // always open in Safari. So Safari signs in, leaves the login under the link's random handoff id, and the
  // home screen app picks it up from there and deletes it (handoffs in firestore.rules).
  const standalone = () => navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;

  /// The handoff this app is waiting for: links are good for an hour, so older ones are forgotten.
  function handoffId() {
    try {
      const w = JSON.parse(storage.get("statbook.handoff") || "null");
      return w && Date.now() - w.at < 3600000 ? w.id : null;
    } catch { return null; }
  }

  function leaveHandoff(id) {
    return fs("PATCH", `handoffs/${id}`, { query: [["currentDocument.exists", "false"]], body: { fields: {
      uid: enc(session.uid), email: enc(session.email || ""), refreshToken: enc(session.refreshToken),
      expires: { timestampValue: new Date(Date.now() + 10 * 60000).toISOString() },
    } } });
  }

  /// Signs this app in from what Safari left, if it's there yet.
  async function pickUpHandoff() {
    const id = handoffId();
    if (!id) return false;
    let d;
    // Not there yet (or too old) reads as no access.
    try { d = await getDoc(`handoffs/${id}`); } catch (e) { if (e instanceof Forbidden) return false; throw e; }
    if (!d?.refreshToken) return false;
    saveSession({ uid: d.uid, email: d.email, idToken: null, refreshToken: d.refreshToken, expires: 0 });
    if (!(await idToken())) return false;
    storage.set("statbook.handoff", null);
    storage.set("statbook.pendingEmail", null);
    deleteDoc(`handoffs/${id}`).catch(() => { /* it stops being readable in 10 minutes anyway */ });
    return true;
  }

  function signOut() {
    saveSession(null);
    stopRefresh();
    location.href = SITE;
  }

  async function fs(method, path, { query = [], body } = {}) {
    const url = new URL(`https://firestore.googleapis.com/v1/${path.startsWith("projects/") ? path : `${DOCS}/${path}`}`);
    url.searchParams.set("key", cfg.apiKey);
    for (const [k, v] of query) if (v != null) url.searchParams.append(k, v);
    const headers = {};
    const token = await idToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers["Content-Type"] = "application/json";
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
    if (res.status === 404 && method !== "POST") return null;
    if (res.status === 403 || res.status === 401) throw new Forbidden("You don't have access to that.");
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error?.message || `The server answered ${res.status}.`);
    }
    return res.status === 204 ? null : res.json().catch(() => null);
  }

  const getDoc = async path => { const d = await fs("GET", path); return d ? fieldsOf(d) : null; };
  const deleteDoc = path => fs("DELETE", path);

  /// Writes the given fields (dotted paths allowed in `mask`); fields left out of `data` but in the mask are deleted.
  function setDoc(path, data, { mask, exists } = {}) {
    const query = (mask || Object.keys(data)).map(f => ["updateMask.fieldPaths", f]);
    if (exists != null) query.push(["currentDocument.exists", String(exists)]);
    return fs("PATCH", path, { query, body: { fields: fieldsOf_enc(data) } });
  }
  const fieldsOf_enc = data => Object.fromEntries(Object.entries(data).map(([k, v]) => [k, enc(v)]));

  async function listDocs(path, extra = []) {
    const out = [];
    let pageToken;
    do {
      const page = await fs("GET", path, { query: [["pageSize", "300"], ...extra, ["pageToken", pageToken]] });
      for (const d of page?.documents || []) out.push({ id: idOf(d), ...fieldsOf(d) });
      pageToken = page?.nextPageToken;
    } while (pageToken);
    return out;
  }

  /// Adds / removes values in a team's lists on the server, so you don't need to read the team first.
  function changeLists(teamId, { add = {}, remove = {}, set = {} }) {
    const transforms = [
      ...Object.entries(add).map(([f, vals]) => ({ fieldPath: f, appendMissingElements: { values: vals.map(enc) } })),
      ...Object.entries(remove).map(([f, vals]) => ({ fieldPath: f, removeAllFromArray: { values: vals.map(enc) } })),
    ];
    return fs("POST", `${DOCS}:commit`, { body: { writes: [{
      update: { name: `${DOCS}/teams/${teamId}`, fields: fieldsOf_enc(set) },
      updateMask: { fieldPaths: Object.keys(set) },
      updateTransforms: transforms,
      currentDocument: { exists: true },
    }] } });
  }

  function randomCode(length, alphabet) {
    const bytes = crypto.getRandomValues(new Uint32Array(length));
    return [...bytes].map(b => alphabet[b % alphabet.length]).join("");
  }
  const newCode = () => randomCode(12, "ABCDEFGHJKLMNPQRSTUVWXYZ23456789");
  const showCode = c => (c || "").replace(/(.{4})(?=.)/g, "$1-");
  const now = () => Math.floor(Date.now() / 1000);

  // ---------- Data ----------

  let demoData = null;
  async function loadDemo() {
    if (!demoData) {
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "demo.js";
        s.onload = resolve;
        s.onerror = () => reject(new Error("Couldn't load the demo data."));
        document.head.append(s);
      });
      demoData = window.STATBOOK_DEMO;
    }
    return demoData;
  }

  const me = () => (DEMO ? "demo-me" : session?.uid);
  /// Admins: full control (stored as `managers`, so existing teams and the iOS app carry on unchanged).
  const isManager = () => DEMO || (state.team?.managers || []).includes(me());
  const isAdmin = isManager;
  /// Managers (`leads`): the schedule, lineups and keeping score. Admins can do all of that too.
  const isLead = () => isAdmin() || ((state.team?.leads || []).includes(me()) && (state.team?.members || []).includes(me()));
  /// Managers, plus members a manager has let add and edit the schedule.
  const isScorer = () => (state.team?.scorers || []).includes(me()) && (state.team?.members || []).includes(me());
  const canSchedule = () => isLead() || (state.team?.schedulers || []).includes(me());

  async function loadProfile() {
    if (DEMO) { state.profile = { name: "You", teams: {} }; return; }
    state.profile = (await getDoc(`users/${me()}`)) || { teams: {} };
    // Starting teams is only for accounts listed in config/teamCreators (for now, until teams are paid for).
    const creators = await getDoc("config/teamCreators").catch(() => null);
    state.canCreateTeams = (creators?.emails || []).includes(String(session?.email || "").toLowerCase());
    state.profile.teams = state.profile.teams || {};
    // Every team you're on, including ones a manager added you to from the app (no invite involved).
    try {
      const rows = await fs("POST", `${DOCS}:runQuery`, { body: { structuredQuery: {
        from: [{ collectionId: "teams" }],
        where: { fieldFilter: { field: { fieldPath: "members" }, op: "ARRAY_CONTAINS", value: { stringValue: me() } } },
        select: { fields: [{ fieldPath: "name" }] },
      } } });
      const onTeams = new Set();
      for (const row of rows || []) {
        if (!row.document) continue;
        const id = idOf(row.document), name = fieldsOf(row.document).name || "Team";
        onTeams.add(id);
        if (state.profile.teams[id] !== name) {
          state.profile.teams[id] = name;
          addToMyTeams(id, name).catch(() => {});
        }
      }
      // Teams you were removed from (or that were deleted) drop off the list.
      for (const id of Object.keys(state.profile.teams)) {
        if (!onTeams.has(id)) { delete state.profile.teams[id]; dropFromMyTeams(id).catch(() => {}); }
      }
    } catch { /* fall back to the saved list */ }
  }

  async function saveName(name) {
    await setDoc(`users/${me()}`, { name, email: session.email }, { mask: ["name", "email"] });
    state.profile.name = name;
    // Keep your name current on every team you're on.
    for (const teamId of Object.keys(state.profile.teams)) {
      try { await setDoc(`teams/${teamId}/members/${me()}`, { name, joinedAt: now() }, { mask: ["name"] }); } catch { /* left or deleted */ }
    }
  }

  async function addToMyTeams(teamId, name) {
    await setDoc(`users/${me()}`, { teams: { [teamId]: name } }, { mask: [`teams.${quote(teamId)}`] });
    state.profile.teams[teamId] = name;
  }
  async function dropFromMyTeams(teamId) {
    await setDoc(`users/${me()}`, {}, { mask: [`teams.${quote(teamId)}`] });
    delete state.profile.teams[teamId];
  }

  async function becomeMember(teamId, teamName) {
    await setDoc(`teams/${teamId}/members/${me()}`, { name: state.profile.name, joinedAt: now() });
    await addToMyTeams(teamId, teamName);
  }

  async function joinWithInvite(code) {
    const invite = await getDoc(`invites/${code}`);
    if (!invite) throw new Error("That invite link has expired. Ask your manager for a new one.");
    await changeLists(invite.teamId, { add: { members: [me()] }, set: { joinedWith: code } });
    await becomeMember(invite.teamId, invite.teamName);
    return invite.teamId;
  }

  /// The app's scorer code makes you the team's manager (and a member).
  async function claimWithScorerCode(rawCode) {
    const code = clean(rawCode).toUpperCase();
    const link = code.length >= 10 ? await getDoc(`scorerCodes/${code}`) : null;
    if (!link) throw new Error("That scorer code didn't match a team. Check it in the app under Teams → your team → Website & Scoring.");
    await changeLists(link.teamId, { add: { members: [me()], managers: [me()] }, set: { joinedWith: code } });
    const team = await getDoc(`teams/${link.teamId}`);
    let settings = await getDoc(`teams/${link.teamId}/private/settings`);
    if (!settings?.inviteCode) {
      const inviteCode = newCode();
      await setDoc(`invites/${inviteCode}`, { teamId: link.teamId, teamName: team.name, createdAt: now() }, { exists: false });
      await setDoc(`teams/${link.teamId}/private/settings`, { scorerCode: code, inviteCode });
    }
    await becomeMember(link.teamId, team.name);
    return link.teamId;
  }

  /// Loads the open team: its record, members, schedule and published games. False if you're not on it.
  async function load(teamId) {
    let team, games, schedule, members, links = [], names = [], settings = null;
    if (DEMO) {
      const d = await loadDemo();
      team = { name: d.board.name, members: d.members.map(m => m.uid), managers: ["demo-me"], leads: ["demo-alex"],
        scorers: ["demo-blake"], schedulers: ["demo-casey"], editors: [] };
      games = d.games;
      schedule = state.schedule.length ? state.schedule : d.schedule.map(x => ({ ...x }));
      members = d.members;
      links = state.links || [];
      names = state.names || [];
      settings = { scorerCode: "DEMOCODE2026", inviteCode: "DEMOINVITE26" };
    } else {
      try { team = await getDoc(`teams/${teamId}`); } catch (e) { if (e instanceof Forbidden) return false; throw e; }
      if (!team) return false;
      [games, schedule, members, links, names] = await Promise.all([
        listDocs(`teams/${teamId}/games`).then(ds => ds.map(d => { try { return JSON.parse(d.json); } catch { return null; } }).filter(Boolean)),
        listDocs(`teams/${teamId}/schedule`),
        listDocs(`teams/${teamId}/members`).then(ds => ds.map(d => ({ uid: d.id, name: d.name }))),
        // The database keeps these ids decoded ("steve z"), so key them the way they're looked up ("steve%20z").
        listDocs(`teams/${teamId}/links`).then(ds => ds.map(l => ({ ...l, id: l.name ? linkKey(l.name) : l.id }))).catch(() => []),
        listDocs(`teams/${teamId}/names`).then(ds => ds.map(r => ({ ...r, id: r.from ? linkKey(r.from) : r.id }))).catch(() => []),
      ]);
      if ((team.managers || []).includes(me())) settings = await getDoc(`teams/${teamId}/private/settings`).catch(() => null);
      // Keep "My teams" in step with the team's current name.
      if (state.profile.teams[teamId] !== team.name) addToMyTeams(teamId, team.name).catch(() => {});
    }
    state.rawGames = games;
    games = withMemberNames(games, members, links, names);
    games.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    schedule.sort((a, b) => `${a.date} ${a.time || ""}`.localeCompare(`${b.date} ${b.time || ""}`));
    const signature = JSON.stringify([team, games, schedule, members, links, names, settings]);
    const changed = signature !== state.signature;
    Object.assign(state, { key: teamId, team, board: { name: team.name }, games, schedule, members, links, names, settings, signature, updated: new Date() });
    if (!state.themeDraft) showTeamTheme(teamId, team.theme);
    return changed ? "changed" : "same";
  }

  async function loadBook(id) {
    if (state.books[id]) return;
    state.books[id] = "loading";
    try {
      const doc = DEMO ? null : await getDoc(`teams/${state.key}/books/${encodeURIComponent(id)}`);
      state.books[id] = doc?.jpeg ? `data:image/jpeg;base64,${doc.jpeg}` : "none";
    } catch {
      state.books[id] = "none";
    }
    if (route().name === "game" && route().id === id) render();
  }

  /// Games scored on the website keep every play, so their scorebook is drawn here instead of read as an image.
  /// Fetched again when the published game changes (a live game gets new plays).
  async function loadScored(g) {
    const stamp = `${(g.plays || []).length}${g.isFinal ? "F" : ""}`;
    if (state.scored[g.id]?.stamp === stamp) return;
    const had = state.scored[g.id]?.game;
    state.scored[g.id] = { stamp, game: had || "loading" };
    const game = (scorer && window.StatBook && await scorer.scoredGame(state.key, g.id).catch(() => null)) || null;
    state.scored[g.id] = { stamp, game };
    if (!game && g.isFinal) loadBook(g.id);
    if (route().name === "game" && route().id === g.id) render();
  }

  // Schedule & availability

  async function saveGame(id, game) {
    if (DEMO) {
      const i = state.schedule.findIndex(x => x.id === id);
      if (i >= 0) state.schedule[i] = { ...state.schedule[i], ...game };
      else state.schedule.push({ id: newCode(), ...game, availability: {} });
      return;
    }
    const fields = ["date", "time", "opponent", "location", "notes", "lat", "lng", "updatedAt"];
    await setDoc(`teams/${state.key}/schedule/${id || newCode()}`, { ...game, updatedAt: now() }, { mask: fields });
  }

  async function deleteGame(id) {
    if (DEMO) { state.schedule = state.schedule.filter(x => x.id !== id); return; }
    await deleteDoc(`teams/${state.key}/schedule/${id}`);
  }

  async function answer(gameId, status) {
    const name = state.profile.name || "Player";
    if (DEMO) {
      const g = state.schedule.find(x => x.id === gameId);
      g.availability = { ...(g.availability || {}) };
      if (status) g.availability[me()] = { status, name }; else delete g.availability[me()];
      return;
    }
    const path = `availability.${quote(me())}`;
    await setDoc(`teams/${state.key}/schedule/${gameId}`,
      status ? { availability: { [me()]: { status, name, updatedAt: now() } } } : {}, { mask: [path], exists: true });
  }

  // Team management (managers)

  /// Sets everyone's roles: managers = Admins, leads = Managers.
  async function setRoles(members, managers, schedulers = state.team.schedulers || [], scorers = state.team.scorers || [], leads = state.team.leads || []) {
    if (DEMO) throw new Error("That isn't available in the demo.");
    await setDoc(`teams/${state.key}`, { name: state.team.name, members, managers, leads, schedulers, scorers, updatedAt: now() },
      { mask: ["name", "members", "managers", "leads", "schedulers", "scorers", "updatedAt"], exists: true });
  }

  async function removeMember(uid) {
    if (DEMO) throw new Error("That isn't available in the demo.");
    await setRoles((state.team.members || []).filter(x => x !== uid), (state.team.managers || []).filter(x => x !== uid),
      (state.team.schedulers || []).filter(x => x !== uid), (state.team.scorers || []).filter(x => x !== uid),
      (state.team.leads || []).filter(x => x !== uid));
    await deleteDoc(`teams/${state.key}/members/${uid}`).catch(() => {});
  }

  async function renameTeam(name) {
    if (DEMO) throw new Error("That isn't available in the demo.");
    await setDoc(`teams/${state.key}`, { name, updatedAt: now() }, { mask: ["name", "updatedAt"], exists: true });
    if (state.settings?.inviteCode) {
      await setDoc(`invites/${state.settings.inviteCode}`, { teamName: name }, { mask: ["teamName"] }).catch(() => {});
    }
  }

  /// A new team made here: you're its only member and its admin, with an invite link ready to share.
  async function createTeam(rawName) {
    const name = rawName.trim().slice(0, 80);
    if (!name) throw new Error("Give the team a name.");
    const teamId = randomCode(22, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789");
    try { await setDoc(`teams/${teamId}`, { name, members: [me()], managers: [me()], createdAt: now(), updatedAt: now() }, { exists: false }); }
    catch (e) { throw e instanceof Forbidden ? new Error("Starting new teams isn't open to everyone yet. Ask to be added.") : e; }
    await becomeMember(teamId, name);
    const code = newCode();
    await setDoc(`invites/${code}`, { teamId, teamName: name, createdAt: now() }, { exists: false });
    await setDoc(`teams/${teamId}/private/settings`, { inviteCode: code });
    return teamId;
  }

  async function newInviteLink() {
    if (DEMO) throw new Error("That isn't available in the demo.");
    const code = newCode();
    await setDoc(`invites/${code}`, { teamId: state.key, teamName: state.team.name, createdAt: now() }, { exists: false });
    if (state.settings?.inviteCode) await deleteDoc(`invites/${state.settings.inviteCode}`).catch(() => {});
    await setDoc(`teams/${state.key}/private/settings`, { inviteCode: code }, { mask: ["inviteCode"] });
  }

  async function leaveTeam() {
    await deleteDoc(`teams/${state.key}/members/${me()}`).catch(() => {});
    await changeLists(state.key, { remove: { members: [me()], managers: [me()], leads: [me()], schedulers: [me()], scorers: [me()] } });
    await dropFromMyTeams(state.key);
  }

  /// Deletes the team and everything in it, for everyone.
  async function deleteTeam() {
    const t = state.key;
    // Website-scored games keep every revision under them; those go first.
    for (const d of await listDocs(`teams/${t}/scoring`, [["mask.fieldPaths", "rev"]])) {
      for (const r of await listDocs(`teams/${t}/scoring/${d.id}/revs`, [["mask.fieldPaths", "rev"]])) await deleteDoc(`teams/${t}/scoring/${d.id}/revs/${r.id}`);
    }
    for (const sub of ["scoring", "schedule", "games", "books", "members", "links", "names"]) {
      for (const d of await listDocs(`teams/${t}/${sub}`, [["mask.fieldPaths", "updatedAt"]])) await deleteDoc(`teams/${t}/${sub}/${d.id}`);
    }
    if (state.settings?.inviteCode) await deleteDoc(`invites/${state.settings.inviteCode}`).catch(() => {});
    if (state.settings?.scorerCode) await deleteDoc(`scorerCodes/${state.settings.scorerCode}`).catch(() => {});
    await deleteDoc(`teams/${t}/private/settings`).catch(() => {});
    await deleteDoc(`teams/${t}`);
    await dropFromMyTeams(t);
  }

  // ---------- Routing ----------

  function route() {
    const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
    if (parts[0] === "game" && parts[1]) return { name: "game", id: decodeURIComponent(parts[1]) };
    if (parts[0] === "solo" && parts[1]) return { name: "solo", id: decodeURIComponent(parts[1]) };
    if (parts[0] === "score") return { name: "score", id: parts[1] ? decodeURIComponent(parts[1]) : null };
    if (["games", "stats", "me", "spray", "team"].includes(parts[0])) return { name: parts[0] };
    return { name: "schedule" };
  }

  // ---------- Field drawing (same shapes and colors as the app) ----------

  const COLORS = { hit: "#1a52db", hr: "#f58c0d", out: "#d91f26", other: "#8c40bf" };
  const SPOTS = [["P", 0, 0.19], ["1B", 0.23, 0.30], ["2B", 0.11, 0.47], ["SS", -0.11, 0.47], ["3B", -0.23, 0.30],
                 ["LF", -0.425, 0.654], ["LC", -0.149, 0.766], ["RC", 0.149, 0.766], ["RF", 0.425, 0.654]];

  // Field units (1 = fence) to SVG units: x right, y up from home plate.
  const P = (x, y) => `${(x * 100).toFixed(2)},${(-y * 100).toFixed(2)}`;
  const polar = (deg, d) => [d * Math.sin(deg * Math.PI / 180), d * Math.cos(deg * Math.PI / 180)];

  function sector(r0, r1, a0, a1, steps = 36) {
    const pts = [];
    for (let i = 0; i <= steps; i++) pts.push(P(...polar(a0 + (a1 - a0) * i / steps, r1)));
    for (let i = steps; i >= 0; i--) pts.push(P(...polar(a0 + (a1 - a0) * i / steps, r0)));
    return `<polygon points="${pts.join(" ")}"/>`;
  }

  function fieldSVG(dots) {
    const parts = [];
    parts.push(`<g fill="#8fb880">${sector(0, 0.6, -64, 64)}</g>`);
    parts.push(`<g fill="#547359">${sector(1.0, 1.1, -45, 45)}</g>`);
    parts.push(`<g fill="#73b561">${sector(0, 1.0, -45, 45)}</g>`);
    for (let r = 0.55; r < 1.0; r += 0.09) parts.push(`<g fill="#5c9e4f" opacity="0.35">${sector(r, r + 0.045, -45, 45)}</g>`);
    parts.push(`<g fill="#d1a16e" opacity="0.85">${sector(0.95, 1.0, -45, 45)}</g>`);
    parts.push(`<g fill="#d1a16e">${sector(0, 0.53, -45, 45)}</g>`);
    parts.push(`<polygon fill="#73b561" points="${[P(0, 0.06), P(0.17, 0.215), P(0, 0.37), P(-0.17, 0.215)].join(" ")}"/>`);
    parts.push(`<circle cx="0" cy="-20" r="3.5" fill="#d1a16e"/>`);
    const fence = [];
    for (let i = 0; i <= 40; i++) fence.push(P(...polar(-45 + 90 * i / 40, 1.0)));
    parts.push(`<polyline points="${fence.join(" ")}" fill="none" stroke="#1f4527" stroke-width="1.6"/>`);
    for (const side of [-45, 45]) {
      parts.push(`<line x1="0" y1="0" x2="${polar(side, 1.1)[0] * 100}" y2="${-polar(side, 1.1)[1] * 100}" stroke="#fff" stroke-width="1"/>`);
    }
    for (const [x, y] of [[0.212, 0.212], [0, 0.424], [-0.212, 0.212]]) {
      parts.push(`<rect x="${x * 100 - 1.4}" y="${-y * 100 - 1.4}" width="2.8" height="2.8" fill="#fff" transform="rotate(45 ${x * 100} ${-y * 100})"/>`);
    }
    parts.push(`<polygon fill="#fff" points="-1.4,-1.4 1.4,-1.4 1.4,0 0,1.4 -1.4,0"/>`);
    const label = (t, x, y, size) =>
      `<text x="${x * 100}" y="${-y * 100}" font-size="${size}" text-anchor="middle" dominant-baseline="central" fill="#fff" fill-opacity="0.8" font-weight="800" font-family="ui-rounded, system-ui, sans-serif">${t}</text>`;
    for (const [t, x, y] of SPOTS) parts.push(label(t, x, y, 4.6));
    parts.push(label("OVER THE FENCE", 0, 1.05, 3.6));
    for (const d of dots) {
      const [x, y] = polar(d.angle, d.distance);
      const cx = x * 100, cy = -y * 100, color = COLORS[d.kind] || COLORS.other;
      if (d.kind === "out") {
        const r = 2;
        const path = `M${cx - r},${cy - r}L${cx + r},${cy + r}M${cx + r},${cy - r}L${cx - r},${cy + r}`;
        parts.push(`<path d="${path}" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>`);
        parts.push(`<path d="${path}" stroke="${color}" stroke-width="1.2" stroke-linecap="round"/>`);
      } else {
        parts.push(`<circle cx="${cx}" cy="${cy}" r="${d.kind === "hr" ? 2.9 : 2.3}" fill="${color}" stroke="#fff" stroke-width="0.7"/>`);
      }
    }
    return parts.join("");
  }

  function sprayCard(titleText, labelText, dots) {
    const hits = dots.filter(d => d.kind === "hit" || d.kind === "hr").length;
    const outs = dots.filter(d => d.kind === "out").length;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "-80 -114 160 118");
    svg.setAttribute("class", "field");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `Spray chart: ${dots.length} balls in play`);
    svg.innerHTML = fieldSVG(dots);
    const key = (kind, text) => h("span", null, h("i", { style: `background:${COLORS[kind]}` }), text);
    return h("div", { class: "card spray-card" },
      h("div", { class: "spray-head" }, h("span", { class: "t" }, titleText), h("span", { class: "l" }, labelText)),
      svg,
      h("div", { class: "keys" },
        key("hit", "Hit"), key("hr", "HR"), key("out", "Out"), key("other", "E / FC"),
        h("span", { class: "count" }, `${dots.length} in play · ${hits} H · ${outs} out`)));
  }

  function diamondSVG(live) {
    const base = (x, y, on) =>
      `<rect x="${x - 9}" y="${y - 9}" width="18" height="18" rx="2.5" transform="rotate(45 ${x} ${y})" fill="${on ? "#d9f23a" : "rgba(255,255,255,0.1)"}" stroke="${on ? "#d9f23a" : "rgba(255,255,255,0.3)"}" stroke-width="1.5"/>`;
    return `<svg viewBox="0 0 112 86" aria-hidden="true">
      <path d="M56 78 L92 44 L56 10 L20 44 Z" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="1.5"/>
      ${base(92, 44, !!live.first)}${base(56, 12, !!live.second)}${base(20, 44, !!live.third)}
      <polygon points="50,72 62,72 62,78 56,84 50,78" fill="rgba(255,255,255,0.7)"/></svg>`;
  }

  // ---------- Tables ----------

  function statsTable(columns, rows, opts = {}) {
    const head = h("tr", null, columns.map(c => {
      const sortable = !!opts.onSort && c.key !== "name";
      const sorted = opts.sort && opts.sort.col === c.key;
      return h("th", {
        class: [sortable && "sortable", sorted && "sorted"].filter(Boolean).join(" ") || null,
        title: c.title || null,
        onclick: sortable ? () => opts.onSort(c.key) : null,
      }, c.label, sorted ? (opts.sort.dir < 0 ? " ▾" : " ▴") : "");
    }));
    const body = rows.map(r => h("tr", { class: r._total ? "total" : null }, columns.map(c => {
      const v = c.value ? c.value(r) : r[c.key];
      const zero = typeof v === "number" && v === 0 && !c.rate;
      return h("td", { class: [zero && "zero", c.rate && "rate"].filter(Boolean).join(" ") || null },
        c.rate ? rate(v) : (zero ? "–" : v));
    })));
    return h("div", { class: "card scroll" }, h("table", { class: "stats" }, h("thead", null, head), h("tbody", null, body)));
  }

  const BATTING = [
    { key: "name", label: "Player" },
    { key: "pa", label: "PA", title: "Plate appearances" },
    { key: "ab", label: "AB", title: "At-bats" },
    { key: "r", label: "R", title: "Runs" },
    { key: "h", label: "H", title: "Hits" },
    { key: "b2", label: "2B" },
    { key: "b3", label: "3B" },
    { key: "hr", label: "HR" },
    { key: "rbi", label: "RBI" },
    { key: "bb", label: "BB", title: "Walks" },
    { key: "k", label: "K", title: "Strikeouts" },
    { key: "sf", label: "SF", title: "Sacrifice flies" },
    { key: "avg", label: "AVG", rate: true },
    { key: "obp", label: "OBP", rate: true },
    { key: "slg", label: "SLG", rate: true },
    { key: "ops", label: "OPS", rate: true },
  ];

  // ---------- Small UI helpers ----------

  /// Runs an action from a button: disables it while working, then re-renders or shows the error.
  function action(fn, { after } = {}) {
    return async e => {
      const btn = e?.currentTarget;
      if (btn) btn.disabled = true;
      try {
        await fn();
        if (after) await after(); else render();
      } catch (err) {
        if (btn) btn.disabled = false;
        alert(err.message || "Something went wrong. Try again.");
      }
    };
  }

  function panel(...kids) {
    return h("div", { class: "lock" }, h("div", { class: "panel" },
      h("img", { src: "apple-touch-icon.png", alt: "" }), ...kids,
      h("p", { class: "fine" }, h("a", { href: "privacy.html" }, "Privacy"))));
  }

  function copyButton(text, label) {
    return h("button", {
      type: "button", class: "btn small ghost",
      onclick: async e => {
        try { await navigator.clipboard.writeText(text); } catch { prompt("Copy this:", text); return; }
        const b = e.currentTarget; b.textContent = "Copied"; setTimeout(() => { b.textContent = label; }, 1800);
      },
    }, label);
  }

  function shareButton(url, text) {
    if (!navigator.share) return null;
    return h("button", { type: "button", class: "btn small", onclick: () => navigator.share({ url, text }).catch(() => {}) }, "Share…");
  }

  // ---------- Sign-in, name, home ----------

  function signInView(message) {
    const context = JOIN ? "Sign in to join your team." : CLAIM ? "Sign in to set up your team's website."
      : TEAM ? "Sign in to see your team." : "Schedules, availability and stats for your slow pitch teams.";
    const input = h("input", { type: "email", placeholder: "you@email.com", autocomplete: "email", required: true,
                               "aria-label": "Email", value: storage.get("statbook.pendingEmail") || "" });
    const err = h("div", { class: "err", role: "alert" }, message || "");
    const button = h("button", { class: "btn", type: "submit" }, "Email Me a Sign-In Link");
    const form = h("form", {
      onsubmit: async e => {
        e.preventDefault();
        button.disabled = true;
        err.textContent = "";
        try {
          await sendSignInLink(input.value.trim());
          if (standalone()) return waitForHandoffView(input.value.trim());
          app.replaceChildren(panel(
            h("h1", null, "Check your email"),
            h("p", null, `We sent a sign-in link to ${input.value.trim()}. Open it on this device to finish signing in. It may take a minute, and check spam if it doesn't show up.`),
            h("p", { class: "or" }, "If the link opens in a different app or browser, you'll be asked for your email once, then you're in there. Use the newest email if you asked more than once."),
            h("button", { class: "btn ghost", type: "button", onclick: () => signInView() }, "Use a different email")));
        } catch (e2) {
          err.textContent = e2.message;
          button.disabled = false;
        }
      },
    }, input, button, err);
    app.replaceChildren(panel(h("h1", null, "Team Stats"), h("p", null, context), form,
      h("p", { class: "or" }, "No password needed. New here? The same link creates your account.")));
    setTimeout(() => input.focus(), 50);
  }

  /// The home screen app, while you open the emailed link in Safari.
  function waitForHandoffView(email) {
    const view = panel(
      h("h1", null, "Check your email"),
      h("p", null, `We sent a sign-in link to ${email || "your email"}. Tap it: it opens in Safari and signs you in there. Then come back here and this app signs itself in.`),
      h("p", { class: "or" }, "Waiting for you to tap the link… It may take a minute, and check spam if it doesn't show up."),
      h("button", { class: "btn ghost", type: "button", onclick: () => signInView() }, "Use a different email"));
    app.replaceChildren(view);
    let busy = false;
    const check = async () => {
      if (!view.isConnected) return stop();
      if (busy || document.visibilityState !== "visible") return;
      busy = true;
      try { if (await pickUpHandoff()) { stop(); return start(); } } catch { /* offline: try again */ }
      busy = false;
    };
    const timer = setInterval(check, 3000);
    const stop = () => { clearInterval(timer); document.removeEventListener("visibilitychange", check); };
    document.addEventListener("visibilitychange", check);
  }

  /// Safari, after signing in from a link the home screen app asked for.
  async function handoffDoneView(id) {
    app.replaceChildren(panel(h("p", null, "Signing in the home screen app…")));
    const here = h("button", { class: "btn ghost", type: "button", onclick: () => start() }, "Use It Here Instead");
    try { await leaveHandoff(id); }
    catch (e) {
      return app.replaceChildren(panel(h("h1", null, "Almost there"),
        h("p", null, `You're signed in here in Safari, but the home screen app couldn't be signed in (${e.message}). Open it and send yourself a new link.`), here));
    }
    app.replaceChildren(panel(
      h("h1", null, "You're signed in"),
      h("p", null, "Go back to Team Stats on your home screen. It signs itself in within a few seconds."),
      here));
  }

  function finishSignInView(oobCode, message, handoff) {
    const input = h("input", { type: "email", placeholder: "you@email.com", autocomplete: "email", required: true, "aria-label": "Email" });
    const err = h("div", { class: "err", role: "alert" }, message || "");
    const button = h("button", { class: "btn", type: "submit" }, "Sign In");
    app.replaceChildren(panel(
      h("h1", null, "Finish signing in"),
      h("p", null, handoff
        ? "Enter the email address the link was sent to, and the home screen app signs in too."
        : "Enter the email address the link was sent to. (This shows when the link opens in a different app or browser from the one you asked in.)"),
      h("form", {
        onsubmit: async e => {
          e.preventDefault();
          const email = input.value.trim();
          button.disabled = true; button.textContent = "Signing in…"; err.textContent = "";
          try { await finishSignIn(email, oobCode); return handoff ? handoffDoneView(handoff) : start(); }
          catch (e2) {
            if (!handoff && await idToken()) return start();
            // The link can't be used any more: straight to sending a new one, email filled in.
            if (/expired or was already used/.test(e2.message)) {
              storage.set("statbook.pendingEmail", email);
              return signInView(`${e2.message.replace(" Send yourself a new one.", "")} Tap below to get a new one.`);
            }
            err.textContent = /doesn't look right/.test(e2.message)
              ? "That isn't the email this link was sent to. Check it for typos, or go back and send yourself a new link." : e2.message;
            button.disabled = false; button.textContent = "Sign In";
          }
        },
      }, input, button, err),
      h("p", { class: "or" }, h("a", { href: "#", onclick: e => { e.preventDefault(); signInView(); } }, "Send a new link instead"))));
    setTimeout(() => input.focus(), 50);
  }

  function nameView() {
    const input = h("input", { type: "text", placeholder: "First and last name", autocomplete: "name", required: true,
                               maxlength: "80", "aria-label": "Your name" });
    app.replaceChildren(panel(
      h("h1", null, "What's your name?"),
      h("p", null, "This is what your teammates see on the schedule."),
      h("form", {
        onsubmit: async e => {
          e.preventDefault();
          const name = input.value.trim();
          if (!name) return;
          const button = e.currentTarget.querySelector("button");
          button.disabled = true; button.textContent = "Saving…";
          try { await saveName(name); await start(); }
          catch (e2) { alert(e2.message); button.disabled = false; button.textContent = "Continue"; }
        },
      }, input, h("button", { class: "btn", type: "submit" }, "Continue"))));
    setTimeout(() => input.focus(), 50);
  }

  function homeView() {
    applyTheme(null);
    const teams = Object.entries(state.profile.teams || {}).sort((a, b) => a[1].localeCompare(b[1]));
    const code = h("input", { type: "text", placeholder: "ABCD-EFGH-JKLM", required: true, "aria-label": "Scorer code", autocapitalize: "characters" });
    const teamName = h("input", { type: "text", placeholder: "Team name", required: true, maxlength: "80", "aria-label": "Team name", autocapitalize: "words" });
    app.replaceChildren(panel(
      h("h1", null, state.profile.name ? `Hi, ${state.profile.name.split(" ")[0]}` : "Your teams"),
      flashMessage(),
      teams.length
        ? [h("p", null, "Your teams"), h("div", { class: "team-list" }, teams.map(([id, name]) =>
            h("div", { class: "team-item" }, h("a", { href: `${SITE}?t=${id}` }, name || "Team"))))]
        : h("p", null, `You're not on a team yet. Ask your team's admin to send you the team's invite link, then open it to join${state.canCreateTeams ? ", or start your own team" : ""}.`),
      state.canCreateTeams ? h("details", { class: "fold", open: !teams.length || null }, h("summary", null, "Start a new team"),
        h("p", { class: "or" }, "You'll be its admin: invite your teammates with its link, set the schedule and keep score here."),
        h("form", { onsubmit: e => { e.preventDefault(); action(async () => { const id = await createTeam(teamName.value); location.href = `${SITE}?t=${id}#/team`; }, { after: () => {} })(e); } },
          teamName, h("button", { class: "btn", type: "submit" }, "Create Team"))) : null,
      // A team kept in the Slow Pitch Book app: its scorer code brings it here and makes you its admin.
      h("details", { class: "fold" }, h("summary", null, "Have a team in the Stat Book app?"),
        h("p", { class: "or" }, "In the app tap Teams → your team → Website & Scoring → Set Up Team on Website, or enter the team's scorer code here. You'll become the team's admin."),
        h("form", { onsubmit: e => { e.preventDefault(); action(async () => { const id = await claimWithScorerCode(code.value); location.href = `${SITE}?t=${id}#/team`; }, { after: () => {} })(e); } },
          code, h("button", { class: "btn", type: "submit" }, "Add Team"))),
      h("p", { class: "or" }, `Signed in as ${session.email} · `,
        h("a", { href: "#", onclick: e => { e.preventDefault(); nameEdit(); } }, "Change name"), " · ",
        h("a", { href: "#", onclick: e => { e.preventDefault(); signOut(); } }, "Sign out"))));
  }

  function nameEdit() {
    const name = prompt("Your name, as teammates see it:", state.profile.name || "");
    if (name && name.trim()) action(() => saveName(name.trim()), { after: () => homeView() })();
  }

  function flashMessage() {
    if (!state.flash) return null;
    const m = state.flash;
    state.flash = "";
    return h("p", { class: "flash" }, m);
  }

  async function joinView() {
    let invite = null;
    try { invite = await getDoc(`invites/${JOIN}`); } catch { /* shown below */ }
    if (!invite) {
      state.flash = "That invite link has expired. Ask your manager for a new one.";
      history.replaceState(null, "", SITE);
      return homeView();
    }
    if (state.profile.teams[invite.teamId]) { location.replace(`${SITE}?t=${invite.teamId}`); return; }
    app.replaceChildren(panel(
      h("h1", null, `Join ${invite.teamName}?`),
      h("p", null, `You'll see the schedule, mark which games you can make, and see the team's stats. Teammates will see you as ${state.profile.name}.`),
      h("button", { class: "btn", type: "button", onclick: action(async () => {
        const id = await joinWithInvite(JOIN);
        location.replace(`${SITE}?t=${id}`);
      }, { after: () => {} }) }, `Join ${invite.teamName}`),
      h("p", { class: "or" }, h("a", { href: SITE }, "Not now"))));
  }

  function claimView() {
    app.replaceChildren(panel(
      h("h1", null, "Set up your team's website"),
      h("p", null, "You'll become this team's admin: you can invite teammates, add the schedule, and everyone you invite can see the stats your app publishes."),
      h("button", { class: "btn", type: "button", onclick: action(async () => {
        const id = await claimWithScorerCode(CLAIM);
        location.replace(`${SITE}?t=${id}#/team`);
      }, { after: () => {} }) }, "Become Admin"),
      h("p", { class: "or" }, h("a", { href: SITE }, "Not now"))));
  }

  function notMemberView() {
    app.replaceChildren(panel(
      h("h1", null, "You're not on this team"),
      h("p", null, "Ask the team's manager for an invite link, or check that this is the right link. If the team was deleted, it's gone for everyone."),
      state.profile.teams[TEAM] ? h("button", { class: "btn ghost", type: "button",
        onclick: action(() => dropFromMyTeams(TEAM), { after: () => { location.href = SITE; } }) }, "Remove from My Teams") : null,
      h("p", { class: "or" }, h("a", { href: SITE }, "‹ My Teams"))));
  }

  // ---------- Team pages ----------

  function shell(current, content) {
    const shown = state.games.filter(inEvent);
    const finals = shown.filter(g => g.isFinal);
    const tab = (name, href, label) => h("a", { href, class: current === name ? "on" : null }, label);
    return [
      h("header", { class: "topbar" }, h("div", { class: "wrap" },
        h("div", { class: "brand" },
          h("img", { src: "apple-touch-icon.png", alt: "" }),
          h("div", null,
            h("h1", null, state.team?.name || "Team"),
            h("div", { class: "sub" }, `${state.members.length} player${state.members.length === 1 ? "" : "s"} · ${finals.length} game${finals.length === 1 ? "" : "s"} played`,
              DEMO ? " " : "", DEMO ? h("span", { class: "pill demo" }, "Demo data") : null)),
          seasonPicker(shown)),
        h("nav", { class: "tabs", "aria-label": "Sections" },
          tab("schedule", "#/", "Schedule"), tab("games", "#/games", "Games"), tab("stats", "#/stats", "Stats"),
          tab("me", "#/me", "My Stats"), tab("spray", "#/spray", "Spray"), tab("team", "#/team", "Team"),
          h("span", { class: "spacer" }),
          DEMO ? null : h("a", { class: "teams-link", href: SITE }, "My Teams")))),
      h("main", { class: "wrap" }, flashMessage(),
        state.offline ? h("div", { class: "notice" }, "You're offline. Games saved on this phone are here; they upload when you're back online.") : null,
        content,
        h("div", { class: "foot" },
          state.updated ? `Updated ${state.updated.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} · ` : "",
          "Refreshes automatically")),
    ];
  }

  const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  function fmtTime(t) {
    if (!t) return "";
    const [hh, mm] = t.split(":").map(Number);
    return new Date(2000, 0, 1, hh, mm).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  /// Directions to a game: the exact pin when the app dropped one, otherwise a search for the field / park.
  function mapLinks(g) {
    const pin = typeof g.lat === "number" && typeof g.lng === "number" ? `${g.lat},${g.lng}` : null;
    const place = encodeURIComponent(g.location || "");
    return [
      ["Apple Maps", pin ? `https://maps.apple.com/?ll=${pin}&q=${place || "Game"}` : `https://maps.apple.com/?q=${place}`],
      ["Google Maps", `https://www.google.com/maps/search/?api=1&query=${pin || place}`],
      ["Waze", pin ? `https://waze.com/ul?ll=${pin}&navigate=yes` : `https://waze.com/ul?q=${place}&navigate=yes`],
    ];
  }
  const ANSWERS = [["in", "In"], ["maybe", "Maybe"], ["out", "Out"]];

  function scheduleView() {
    const today = todayISO();
    const upcoming = state.schedule.filter(g => g.date >= today);
    const past = state.schedule.filter(g => g.date < today).reverse();
    const manager = canSchedule();
    return [
      h("h2", { class: "section" }, "Upcoming",
        manager && state.editing !== "new"
          ? h("button", { class: "btn small", type: "button", onclick: () => { state.editing = "new"; render(); } }, "+ Add Game")
          : null),
      state.editing === "new" ? gameForm(null) : null,
      upcoming.length
        ? upcoming.map(g => (state.editing === g.id ? gameForm(g) : state.editingLineup === g.id ? lineupEditor(g) : scheduleCard(g, manager)))
        : (state.editing === "new" ? null : h("div", { class: "card empty" },
            manager ? "No games on the schedule yet. Tap Add Game to add the next one." : "No games on the schedule yet. Your manager adds them here.")),
      past.length ? h("details", { class: "fold past" },
        h("summary", null, `Past games (${past.length})`),
        past.slice(0, 20).map(g => (state.editing === g.id ? gameForm(g) : state.editingLineup === g.id ? lineupEditor(g) : scheduleCard(g, manager, true)))) : null,
    ];
  }

  function lineupEditor(g) {
    return scorer ? scorer.scheduleLineupEditor(g, saved => { state.editingLineup = null; if (saved) refreshNow(); else render(); }) : null;
  }

  async function saveLineup(id, lineup) {
    if (DEMO) { const g = state.schedule.find(x => x.id === id); if (g) g.lineup = lineup; return; }
    await setDoc(`teams/${state.key}/schedule/${id}`, { lineup, updatedAt: now() }, { mask: ["lineup", "updatedAt"], exists: true });
  }

  /// The batting order (everyone), Set Lineup (managers) and Keep Score (managers and scorekeepers, on the day).
  function lineupBlock(g) {
    const lineup = g.lineup || [];
    const runsTeam = isLead();
    const canKeep = scorer?.isScorerHere() && lineup.length && g.date <= todayISO();
    const buttons = [
      runsTeam ? h("button", { class: "btn small ghost", type: "button", onclick: () => { state.editingLineup = g.id; render(); } },
        lineup.length ? "Edit Lineup" : "Set Lineup") : null,
      canKeep && state.tossFor !== g.id ? h("button", { class: "btn small", type: "button", onclick: () => {
        if (scorer.isStarted(g.id)) { location.hash = `#/score/${encodeURIComponent(g.id)}`; return; }
        state.tossFor = g.id; render();
      } }, "Keep Score") : null,
    ].filter(Boolean);
    // Keep Score asks the coin toss first (a game already being scored just opens).
    const toss = canKeep && state.tossFor === g.id ? h("div", { class: "card pad toss-card" },
      scorer.sidePicker(null, home => action(async () => {
        const id = await scorer.startFromSchedule(g, home);
        state.tossFor = null;
        if (id) location.hash = `#/score/${encodeURIComponent(id)}`;
      }, { after: () => {} })()),
      h("button", { class: "link-btn", type: "button", onclick: () => { state.tossFor = null; render(); } }, "Cancel")) : null;
    if (!lineup.length && !buttons.length) return null;
    const nameOf = p => (p.member && state.members.find(m => m.uid === p.member)?.name) || p.name;
    return h("div", { class: "lineup-block" },
      lineup.length ? h("details", { class: "who" }, h("summary", null, `Batting order (${lineup.length})`),
        h("ol", { class: "batting-order" }, lineup.map(p => h("li", { class: p.member === me() ? "me" : null }, nameOf(p))))) : null,
      buttons.length ? h("div", { class: "form-actions start" }, buttons) : null,
      toss);
  }

  function scheduleCard(g, manager, isPast = false) {
    const answers = g.availability || {};
    const mine = answers[me()]?.status || "";
    const groups = { in: [], maybe: [], out: [] };
    for (const [uid, a] of Object.entries(answers)) {
      if (groups[a.status]) groups[a.status].push({ uid, name: a.name, note: a.note });
    }
    const answered = new Set(Object.keys(answers));
    const noReply = state.members.filter(m => !answered.has(m.uid));
    const d = parseDate(g.date);
    const opp = g.opponent ? `vs ${g.opponent}` : "Game";
    const who = (label, list, cls) => list.length ? h("div", { class: "who-group" },
      h("div", { class: `who-head ${cls}` }, `${label} · ${list.length}`),
      h("div", { class: "who-names" }, list.map(p => h("span", { class: "who-name" }, p.name || "Player", p.note ? h("em", null, ` (${p.note})`) : null)))) : null;
    return h("div", { class: `card sched${isPast ? " is-past" : ""}` },
      h("div", { class: "sched-top" },
        h("div", { class: "sched-date" },
          h("span", { class: "dow" }, d ? d.toLocaleDateString(undefined, { weekday: "short" }) : ""),
          h("span", { class: "day" }, d ? d.getDate() : ""),
          h("span", { class: "mon" }, d ? d.toLocaleDateString(undefined, { month: "short" }) : "")),
        h("div", { class: "sched-info" },
          manager ? h("div", { class: "sched-admin" },
            h("button", { class: "link-btn", type: "button", onclick: () => { state.editing = g.id; render(); } }, "Edit"),
            h("button", { class: "link-btn danger", type: "button", onclick: e => {
              if (confirm(`Delete ${opp} on ${fmtDate(g.date)}? Everyone's answers go with it.`)) action(() => deleteGame(g.id), { after: refreshNow })(e);
            } }, "Delete")) : null,
          h("div", { class: "opp" }, opp),
          h("div", { class: "meta" }, g.time ? fmtTime(g.time) : "Time TBD"),
          g.location || typeof g.lat === "number" ? h("div", { class: "loc" },
            h("span", { class: "loc-name" }, "📍 ", g.location || "Pinned on the map"),
            h("span", { class: "loc-links" }, mapLinks(g).map(([label, href]) =>
              h("a", { class: "map-link", href, target: "_blank", rel: "noopener" }, label)))) : null,
          g.notes ? h("div", { class: "notes" }, g.notes) : null)),
      isPast ? null : h("div", { class: "answer" },
        h("span", { class: "answer-label" }, "Can you make it?"),
        h("div", { class: "seg", role: "group", "aria-label": "Your availability" }, ANSWERS.map(([value, label]) =>
          h("button", {
            type: "button", class: `seg-btn ${value}${mine === value ? " on" : ""}`, "aria-pressed": String(mine === value),
            onclick: action(() => answer(g.id, mine === value ? null : value), { after: refreshNow }),
          }, label)))),
      h("div", { class: "tally" },
        h("span", { class: "t-in" }, `${groups.in.length} in`),
        h("span", { class: "t-maybe" }, `${groups.maybe.length} maybe`),
        h("span", { class: "t-out" }, `${groups.out.length} out`),
        h("span", { class: "t-none" }, `${noReply.length} no reply`)),
      h("details", { class: "who" }, h("summary", null, "Who's coming"),
        who("In", groups.in, "in"), who("Maybe", groups.maybe, "maybe"), who("Out", groups.out, "out"),
        who("No reply", noReply, "none")),
      lineupBlock(g));
  }

  // ---------- Map pins for scheduled games ----------
  // Leaflet with OpenStreetMap / Esri tiles and OpenStreetMap search, loaded only when someone opens the map.

  const LEAFLET = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/";
  let leafletLoad = null;
  function loadLeaflet() {
    if (!leafletLoad) {
      leafletLoad = new Promise((resolve, reject) => {
        const css = h("link", { rel: "stylesheet", href: `${LEAFLET}leaflet.min.css`, crossorigin: "anonymous",
          integrity: "sha512-h9FcoyWjHcOcmEVkxOfTLnmZFWIH0iZhZT1H2TbOq55xssQGEJHEaIm+PgoUaZbRvQTNTluNOEfb1ZRy6D3BOw==" });
        const js = h("script", { src: `${LEAFLET}leaflet.min.js`, crossorigin: "anonymous",
          integrity: "sha512-puJW3E/qXDqYp9IfhAI54BJEaWIfloJ7JWs7OeD5i6ruC9JZL1gERT1wjtwXFlh7CjE7ZJ+/vcRZRkIYIb6p4g==" });
        js.onload = () => resolve(window.L);
        js.onerror = () => { leafletLoad = null; reject(new Error("Couldn't load the map. Check your connection and try again.")); };
        document.head.append(css, js);
      });
    }
    return leafletLoad;
  }

  const NOMINATIM = "https://nominatim.openstreetmap.org/";
  async function findPlaces(q) {
    const r = await fetch(`${NOMINATIM}search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`);
    if (!r.ok) throw new Error("Search isn't working right now. Tap the map to drop the pin instead.");
    return (await r.json()).map(p => ({ name: p.name || p.display_name.split(",")[0], detail: p.display_name, lat: +p.lat, lng: +p.lon }));
  }
  /// What Maps calls a spot (the park it's in, if known), or "".
  async function placeName(lat, lng) {
    try {
      const p = await (await fetch(`${NOMINATIM}reverse?format=jsonv2&zoom=17&lat=${lat}&lon=${lng}`)).json();
      const a = p.address || {};
      // A park or field, not the road the pin happens to sit on.
      return a.leisure || a.park || (p.category === "highway" ? "" : p.name) || "";
    } catch { return ""; }
  }

  /// Fields this team has pinned before (the newest pin for each name), A to Z.
  function savedFields() {
    const byName = new Map();
    for (const g of [...state.schedule].sort((a, b) => (b.date || "").localeCompare(a.date || ""))) {
      const name = (g.location || "").trim();
      if (name && typeof g.lat === "number" && typeof g.lng === "number" && !byName.has(name.toLowerCase())) {
        byName.set(name.toLowerCase(), { name, lat: g.lat, lng: g.lng });
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /// The pin part of the game form: pick a saved field, or drop / drag a pin on a map. `loc` is the
  /// Field / park input, which doubles as the pin's name. get() returns { lat, lng } or null.
  function pinField(loc, start) {
    let pin = start;
    let map = null, marker = null, autoName = "";
    const fields = savedFields();
    const status = h("span", { class: "pin-status" });
    const dropBtn = h("button", { class: "btn small ghost", type: "button", onclick: () => openMap() });
    const removeBtn = h("button", { class: "link-btn danger", type: "button", onclick: () => setPin(null) }, "Remove Pin");
    const search = h("input", { type: "search", placeholder: "Search for a park or address", "aria-label": "Search for a park or address",
      onkeydown: e => { if (e.key === "Enter") { e.preventDefault(); runSearch(); } } });
    const results = h("div", { class: "pin-results" });
    const mapEl = h("div", { class: "pin-canvas" });
    const note = h("p", { class: "pin-note" }, "Tap the map to drop the pin on the field, then drag it to fine-tune. Give the field a name in Location so you can pick it again next time.");
    let street, satellite;
    const styleBtn = (label, sat) => h("button", { class: "seg-btn", type: "button", "aria-pressed": String(sat),
      onclick: e => {
        if (!map) return;
        map.removeLayer(sat ? street : satellite); (sat ? satellite : street).addTo(map);
        for (const b of e.currentTarget.parentElement.children) b.setAttribute("aria-pressed", String(b === e.currentTarget));
      } }, label);
    const box = h("div", { class: "pin-map", hidden: true },
      h("div", { class: "pin-search" }, search, h("button", { class: "btn small", type: "button", onclick: () => runSearch() }, "Search")),
      results, mapEl,
      h("div", { class: "pin-tools" },
        h("div", { class: "seg", role: "group", "aria-label": "Map style" }, styleBtn("Satellite", true), styleBtn("Map", false)),
        h("button", { class: "btn small", type: "button", onclick: () => { box.hidden = true; refresh(); } }, "Done")),
      note);

    function refresh() {
      dropBtn.textContent = pin ? "Move Pin" : "Drop a Pin on the Map";
      removeBtn.hidden = !pin;
      status.textContent = pin ? `📍 Pinned at ${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}` : "No pin yet";
    }
    function setPin(p, { center = false } = {}) {
      pin = p ? { lat: +p.lat.toFixed(6), lng: +p.lng.toFixed(6) } : null;
      if (map) {
        if (!pin && marker) { marker.remove(); marker = null; }
        if (pin && !marker) {
          marker = window.L.marker([pin.lat, pin.lng], { draggable: true,
            icon: window.L.divIcon({ className: "pin-icon", iconSize: [24, 24], iconAnchor: [12, 12] }) }).addTo(map);
          marker.on("dragend", () => { const c = marker.getLatLng(); dropped({ lat: c.lat, lng: c.lng }); });
        } else if (pin) marker.setLatLng([pin.lat, pin.lng]);
        if (pin && center) map.setView([pin.lat, pin.lng], 17);
      }
      refresh();
    }
    /// A pin placed by hand: when the field has no name yet, name it after the park it's in.
    async function dropped(p) {
      setPin(p);
      if (loc.value.trim()) return;
      const name = await placeName(p.lat, p.lng);
      if (name && pin && pin.lat === +p.lat.toFixed(6) && !loc.value.trim()) loc.value = name;
    }
    async function runSearch(q = search.value.trim(), jump = false) {
      if (!q) return;
      results.replaceChildren(h("div", { class: "pin-note" }, "Searching…"));
      try {
        const found = await findPlaces(q);
        if (jump) {
          results.replaceChildren();
          if (found[0] && map && !pin) map.setView([found[0].lat, found[0].lng], 16);
          return;
        }
        results.replaceChildren(...(found.length ? found.map(f => h("button", { class: "pin-result", type: "button", onclick: () => {
          if (!loc.value.trim() || loc.value === autoName) { loc.value = f.name; autoName = f.name; }   // a newer search renames it
          setPin(f, { center: true });
          results.replaceChildren();
          search.value = "";
        } }, h("b", null, f.name), h("span", null, f.detail))) : [h("div", { class: "pin-note" }, "No places found. Try another search, or tap the map.")]));
      } catch (e) {
        results.replaceChildren(h("div", { class: "pin-note" }, e.message));
      }
    }
    async function openMap() {
      box.hidden = false;
      if (map) { map.invalidateSize(); return; }
      let L;
      try { L = await loadLeaflet(); } catch (e) { note.textContent = e.message; return; }
      street = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' });
      satellite = L.layerGroup([
        L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Imagery &copy; Esri" }),
        // Place names on the photos, until you're close enough to see the fields themselves.
        L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", { maxZoom: 15 }),
      ]);
      map = L.map(mapEl, { layers: [satellite] }).setView([39.5, -98.35], 4);
      map.on("click", e => dropped({ lat: e.latlng.lat, lng: e.latlng.lng }));
      if (pin) setPin(pin, { center: true });
      else if (loc.value.trim()) runSearch(loc.value.trim(), true);
      else if (fields[0]) map.setView([fields[0].lat, fields[0].lng], 14);
      setTimeout(() => map.invalidateSize(), 50);
    }

    refresh();
    const el = h("div", { class: "pin-field" },
      fields.length ? h("select", { class: "control", "aria-label": "Choose a saved field",
        onchange: e => {
          const f = fields[+e.target.value];
          e.target.value = "";
          if (!f) return;
          loc.value = f.name; autoName = "";
          setPin(f, { center: true });
        } }, h("option", { value: "" }, "Choose a saved field…"), fields.map((f, i) => h("option", { value: String(i) }, f.name))) : null,
      h("div", { class: "pin-row" }, status, dropBtn, removeBtn),
      box);
    return { el, get: () => pin };
  }

  function gameForm(g) {
    const f = g || { date: todayISO(), time: "", opponent: "", location: "", notes: "" };
    const date = h("input", { type: "date", required: true, value: f.date, "aria-label": "Date" });
    const time = h("input", { type: "time", value: f.time || "", "aria-label": "Time" });
    const opponent = h("input", { type: "text", placeholder: "Opponent", maxlength: "80", value: f.opponent || "", "aria-label": "Opponent" });
    const loc = h("input", { type: "text", placeholder: "Field / park", maxlength: "200", value: f.location || "", "aria-label": "Location" });
    const where = pinField(loc, typeof f.lat === "number" && typeof f.lng === "number" ? { lat: f.lat, lng: f.lng } : null);
    const notes = h("textarea", { placeholder: "Notes (arrival time, jersey color…)", maxlength: "500", rows: "2", "aria-label": "Notes" }, f.notes || "");
    return h("form", {
      class: "card game-form",
      onsubmit: e => {
        e.preventDefault();
        action(async () => {
          await saveGame(g?.id, { date: date.value, time: time.value, opponent: opponent.value.trim(),
                                  location: loc.value.trim(), notes: notes.value.trim(),
                                  lat: where.get()?.lat ?? null, lng: where.get()?.lng ?? null });
          state.editing = null;
        }, { after: refreshNow })(e);
      },
    },
      h("div", { class: "form-title" }, g ? "Edit game" : "Add a game"),
      h("div", { class: "row2" }, h("label", null, "Date", date), h("label", null, "Time (optional)", time)),
      h("label", null, "Opponent", opponent),
      h("label", null, "Location", loc),
      where.el,
      h("label", null, "Notes", notes),
      h("div", { class: "form-actions" },
        h("button", { class: "btn ghost", type: "button", onclick: () => { state.editing = null; render(); } }, "Cancel"),
        h("button", { class: "btn", type: "submit" }, g ? "Save" : "Add Game")));
  }

  const ROLES = [["player", "Player"], ["scheduler", "Scheduler"], ["scorer", "Scorekeeper"], ["lead", "Manager"], ["admin", "Admin"]];
  function roleOf(uid) {
    const t = state.team || {};
    return (t.managers || []).includes(uid) ? "admin" : (t.leads || []).includes(uid) ? "lead"
      : (t.scorers || []).includes(uid) ? "scorer" : (t.schedulers || []).includes(uid) ? "scheduler" : "player";
  }

  /// Player / Scheduler / Scorekeeper / Manager / Admin for one teammate (admins only). One role each.
  function roleSelect(uid, current) {
    const sel = h("select", { class: "role-select", "aria-label": "Role", onchange: e => {
      const role = e.target.value;
      const t = state.team;
      const without = f => (t[f] || []).filter(x => x !== uid);
      const lists = { managers: without("managers"), leads: without("leads"), schedulers: without("schedulers"), scorers: without("scorers") };
      ({ admin: lists.managers, lead: lists.leads, scheduler: lists.schedulers, scorer: lists.scorers })[role]?.push(uid);
      sel.disabled = true;
      setRoles(t.members, lists.managers, lists.schedulers, lists.scorers, lists.leads).then(refreshNow, err => {
        sel.value = current;   // didn't save: show the role they still have
        sel.disabled = false;
        alert(err.message || "Something went wrong. Try again.");
      });
    } }, ROLES.map(([v, t]) => h("option", { value: v }, t)));
    sel.value = current;
    return sel;
  }

  // ---------- Linking players to their stats (like the app's Players → Link) ----------

  /// Everyone in the scorebook: linked members by account, everyone else by name, with games and PA.
  function scorebookPeople() {
    const people = new Map();
    for (const g of state.games) {
      const seen = new Set();
      for (const l of g.lines || []) {
        if (!(l.pa > 0 || l.r > 0 || l.crr > 0)) continue;
        const key = l.member ? `m:${l.member}` : `n:${String(l.name).trim().toLowerCase()}`;
        const p = people.get(key) || { key, name: String(l.name).trim(), member: l.member || null, games: 0, pa: 0, gameIDs: new Set() };
        if (!seen.has(key)) { p.games += 1; seen.add(key); }
        p.pa += l.pa;
        p.gameIDs.add(g.id);
        people.set(key, p);
      }
    }
    return people;
  }

  function linkStatus(m) {
    const p = scorebookPeople().get(`m:${m.uid}`);
    const mine = (state.links || []).filter(l => l.uid === m.uid);
    return h("div", { class: "link-status" },
      p ? `Linked · ${p.games} G · ${p.pa} PA` : "No stats linked yet",
      mine.length ? ` · scored as ${mine.map(l => l.name).join(", ")}` : "",
      h("button", { class: "link-btn", type: "button", onclick: () => { state.linking = state.linking === m.uid ? null : m.uid; render(); } },
        state.linking === m.uid ? "Done" : p ? "Link More" : "Link"),
      mine.length ? h("button", { class: "link-btn danger", type: "button", onclick: e => {
        if (confirm(`Unlink ${m.name}? Games scored as ${mine.map(l => l.name).join(", ")} go back to counting under that name.`)) {
          action(async () => { for (const l of mine) await deleteLink(l.id); }, { after: refreshNow })(e);
        }
      } }, "Unlink") : null);
  }

  /// Pick the name(s) this player was scored under; those games then count as theirs.
  function linkPanel(m) {
    if (!m) return null;
    const people = scorebookPeople();
    const linkedGames = people.get(`m:${m.uid}`)?.gameIDs || new Set();
    const first = (m.name || "").trim().toLowerCase().split(/\s+/)[0] || "";
    const free = [...people.values()].filter(p => !p.member).sort((a, b) => a.name.localeCompare(b.name));
    const likely = free.filter(p => { const n = p.name.toLowerCase(); return first && (n.startsWith(first) || n.startsWith(first[0] + " ")); });
    const rest = free.filter(p => !likely.includes(p));
    const row = p => {
      // Two people in the same game can't be one person.
      const together = [...p.gameIDs].some(id => linkedGames.has(id));
      return h("button", { type: "button", class: "link-row", disabled: together || null, onclick: e => {
        if (confirm(`Link ${p.name} to ${m.name}? Games with ${p.name} will count as ${m.name}'s and show their name.`)) {
          action(() => saveLink(p.name, m.uid), { after: refreshNow })(e);
        }
      } }, h("span", null, p.name), h("span", { class: "muted small" }, together ? `played with ${m.name}` : `${p.games} G · ${p.pa} PA`));
    };
    return h("div", { class: "card pad link-panel" },
      h("b", null, `Link ${m.name}`),
      h("p", { class: "muted small" }, `Pick the name you've been scoring ${m.name} under. Those games will show ${m.name} and their stats combine, even if they change their name later.`),
      !free.length ? h("div", { class: "muted" }, "Everyone in the scorebook is already linked.") : null,
      likely.length ? [h("div", { class: "k" }, "Likely"), likely.map(row)] : null,
      rest.length ? [h("div", { class: "k" }, likely.length ? "Everyone else" : "Scorebook players"), rest.map(row)] : null,
      h("div", { class: "form-actions start" }, h("button", { class: "btn small ghost", type: "button", onclick: () => { state.linking = null; render(); } }, "Done")));
  }

  async function saveLink(name, uid) {
    if (DEMO) { state.links = [...(state.links || []).filter(l => l.id !== linkKey(name)), { id: linkKey(name), name, uid }]; await load(state.key); return; }
    await setDoc(`teams/${state.key}/links/${linkKey(name)}`, { name, uid, by: me(), at: now() });
  }
  async function deleteLink(id) {
    if (DEMO) { state.links = (state.links || []).filter(l => l.id !== id); await load(state.key); return; }
    await deleteDoc(`teams/${state.key}/links/${id}`);
  }

  // ---------- Team colors (admins pick them on the Team tab; everyone on the team sees them) ----------

  const DEFAULT_THEME = { main: "#2e7d2a", highlight: "#d9f23a", board: "#222621" };
  const THEMES = [
    ["Field Green", DEFAULT_THEME],
    ["Navy & Gold", { main: "#1f3a93", highlight: "#f5c518", board: "#14213d" }],
    ["Red & White", { main: "#c8102e", highlight: "#ffffff", board: "#2b0a0f" }],
    ["Royal Blue", { main: "#1e5bd7", highlight: "#9fd3ff", board: "#0f1f3d" }],
    ["Black & Orange", { main: "#e85d10", highlight: "#ff9a3c", board: "#151515" }],
    ["Purple & Gold", { main: "#5b2a86", highlight: "#fdb927", board: "#24113a" }],
    ["Maroon & Gold", { main: "#7a1f2b", highlight: "#f2c14e", board: "#2a0d12" }],
    ["Teal", { main: "#00808f", highlight: "#7ff0e0", board: "#0d2a2e" }],
    ["Pink", { main: "#d63384", highlight: "#ffd1e8", board: "#2d0f1f" }],
    ["Columbia Blue", { main: "#2f7fc1", highlight: "#b9d9eb", board: "#13283d" }],
  ];
  const goodHex = c => /^#[0-9a-f]{6}$/i.test(c || "");
  const rgbOf = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
  const hexOf = rgb => "#" + rgb.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
  const mix = (a, b, t) => { const x = rgbOf(a), y = rgbOf(b); return hexOf(x.map((v, i) => v + (y[i] - v) * t)); };
  /// Relative luminance (0 black … 1 white).
  const lum = c => {
    const [r, g, b] = rgbOf(c).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  /// Moves `c` toward `to` until its luminance is on the right side of `limit` (keeps text readable).
  const until = (c, to, ok) => { let x = c; for (let i = 0; i < 12 && !ok(lum(x)); i++) x = mix(x, to, 0.15); return x; };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  /// White or near-black text, whichever reads better on `c`.
  const inkOn = c => (contrast(c, "#ffffff") >= contrast(c, "#121411") ? "#ffffff" : "#121411");

  function themeCSS(t) {
    const main = goodHex(t.main) ? t.main : DEFAULT_THEME.main;
    const high = goodHex(t.highlight) ? t.highlight : DEFAULT_THEME.highlight;
    // The header and scoreboard carry white text, so they stay dark.
    const board = until(goodHex(t.board) ? t.board : DEFAULT_THEME.board, "#000000", l => l <= 0.06);
    // Links and buttons need to read on a light page, and on a dark one in dark mode.
    const light = until(main, "#000000", l => l <= 0.18);
    const dark = until(main, "#ffffff", l => l >= 0.18);
    return `:root{--accent:${light};--on-accent:${inkOn(light)};--optic:${high};--board-1:${board};--board-2:${mix(board, "#000000", 0.45)}}`
      + `@media (prefers-color-scheme: dark){:root{--accent:${dark};--on-accent:${inkOn(dark)}}}`;
  }

  /// Shows `theme` (null = the default colors) right away.
  function applyTheme(theme) {
    let el = document.getElementById("team-theme");
    if (!el) { el = document.createElement("style"); el.id = "team-theme"; document.head.append(el); }
    el.textContent = theme ? themeCSS(theme) : "";
    const bar = document.querySelector('meta[name="theme-color"]');
    if (bar) bar.content = theme ? getComputedStyle(document.documentElement).getPropertyValue("--board-2").trim() || "#121411" : "#121411";
  }
  /// The team's saved colors, remembered on this device so the next visit opens in them.
  function showTeamTheme(teamId, theme) {
    applyTheme(theme || null);
    storage.set(`statbook.theme.${teamId}`, theme ? JSON.stringify(theme) : null);
  }
  const sameTheme = (a, b) => ["main", "highlight", "board"].every(k => (a?.[k] || "").toLowerCase() === (b?.[k] || "").toLowerCase());

  async function saveTheme(theme) {
    if (DEMO) { state.team.theme = theme || undefined; return; }
    await setDoc(`teams/${state.key}`, { ...(theme ? { theme } : {}), updatedAt: now() }, { mask: ["theme", "updatedAt"], exists: true });
    state.team.theme = theme || undefined;
  }

  function themeSection() {
    const saved = state.team?.theme || null;
    const draft = state.themeDraft;
    const shown = draft || saved || DEFAULT_THEME;
    const preview = t => { state.themeDraft = { ...t }; applyTheme(state.themeDraft); render(); };
    const picker = (key, label) => h("label", null, label, h("input", { type: "color", value: shown[key], "aria-label": label,
      // Live while dragging (colors only), then a redraw when they let go.
      oninput: e => { state.themeDraft = { ...shown, ...(state.themeDraft || {}), [key]: e.target.value }; applyTheme(state.themeDraft); },
      onchange: e => { state.themeDraft = { ...shown, ...(state.themeDraft || {}), [key]: e.target.value }; applyTheme(state.themeDraft); render(); } }));
    const changed = draft && !sameTheme(draft, saved || DEFAULT_THEME);
    return [
      h("h2", { class: "section" }, "Team colors"),
      h("div", { class: "card pad" },
        h("div", { class: "theme-presets" }, THEMES.map(([name, t]) => h("button", { type: "button", class: `theme-preset${sameTheme(t, shown) ? " on" : ""}`,
          onclick: () => preview(t) }, h("span", { class: "sw" }, [t.board, t.main, t.highlight].map(c => h("i", { style: `background:${c}` }))), name))),
        h("div", { class: "theme-pickers" }, picker("main", "Main"), picker("highlight", "Highlight"), picker("board", "Header")),
        h("p", { class: "muted small" }, changed ? "Previewing on this screen only. Save to show these colors to the whole team."
          : "Main colors buttons and links, Highlight the scoreboard numbers, Header the bar at the top. Colors are adjusted if needed so text stays readable."),
        h("div", { class: "form-actions start" },
          h("button", { class: "btn small", type: "button", disabled: !changed || null,
            onclick: action(async () => { await saveTheme(sameTheme(draft, DEFAULT_THEME) ? null : draft); state.themeDraft = null; showTeamTheme(state.key, state.team.theme); }) }, "Save Colors"),
          changed ? h("button", { class: "btn small ghost", type: "button", onclick: () => { state.themeDraft = null; applyTheme(saved); render(); } }, "Cancel") : null,
          saved && !draft ? h("button", { class: "btn small ghost", type: "button",
            onclick: action(async () => { await saveTheme(null); showTeamTheme(state.key, null); }) }, "Use Default Colors") : null)),
    ];
  }

  // ---------- Adding people from your other teams (admins, like the app's Add From Another Team) ----------

  /// Loads the other teams you're an admin of, with their players' names.
  async function loadOtherTeams() {
    const ids = Object.keys(state.profile?.teams || {}).filter(id => id !== state.key);
    const teams = await Promise.all(ids.map(async id => {
      try {
        const t = await getDoc(`teams/${id}`);
        if (!t || !(t.managers || []).includes(me())) return null;
        const names = new Map((await listDocs(`teams/${id}/members`)).map(m => [m.id, m.name]));
        return { id, name: t.name || "Team", people: (t.members || []).map(uid => ({ uid, name: names.get(uid) || "Player" })) };
      } catch { return null; }
    }));
    return teams.filter(Boolean);
  }

  async function addFromTeam(fromId, person) {
    if (DEMO) throw new Error("That isn't available in the demo.");
    await changeLists(state.key, { add: { members: [person.uid] }, set: { addedFrom: fromId, updatedAt: now() } });
    await setDoc(`teams/${state.key}/members/${person.uid}`, { name: person.name });
  }

  function otherTeamsSection() {
    if (DEMO || Object.keys(state.profile?.teams || {}).filter(id => id !== state.key).length === 0) return null;
    const here = new Set(state.team?.members || []);
    const o = state.otherTeams;
    const open = !!o;
    return h("details", { class: "fold", open: open || null, ontoggle: e => {
      if (e.target.open && !state.otherTeams) {
        state.otherTeams = "loading";
        loadOtherTeams().then(ts => { state.otherTeams = ts; }).catch(() => { state.otherTeams = []; }).finally(render);
        render();
      }
    } },
      h("summary", null, "Add players from your other teams"),
      o === "loading" ? h("div", { class: "muted" }, "Loading your teams…")
        : Array.isArray(o) ? (o.length ? o.map(t => {
          const people = t.people.filter(p => !here.has(p.uid));
          return [h("div", { class: "k" }, t.name),
            people.length ? h("div", { class: "card roster" }, people.map(p => h("div", { class: "roster-row" },
              h("div", { class: "rname" }, p.name),
              h("div", { class: "radmin" }, h("button", { class: "btn small", type: "button",
                onclick: action(() => addFromTeam(t.id, p), { after: refreshNow }) }, "Add")))))
              : h("div", { class: "muted small" }, `Everyone on ${t.name} is already on ${state.team.name}.`)];
        }) : h("div", { class: "muted small" }, "You aren't an admin of any other team.")) : null,
      h("p", { class: "muted small" }, "They're added straight to this team as players, with the name they use on the other team. No invite needed."));
  }

  // ---------- Renaming and merging scorebook names (like the app's Player Names) ----------

  function saveRename(from, to) {
    const t = to.trim(), f = from.trim();
    if (!t || t.toLowerCase() === f.toLowerCase()) throw new Error("Type a different name.");
    if (DEMO) { state.names = [...(state.names || []).filter(r => r.id !== linkKey(f)), { id: linkKey(f), from: f, to: t }]; return load(state.key); }
    return setDoc(`teams/${state.key}/names/${linkKey(f)}`, { from: f, to: t, by: me(), at: now() });
  }
  function undoRename(id) {
    if (DEMO) { state.names = (state.names || []).filter(r => r.id !== id); return load(state.key); }
    return deleteDoc(`teams/${state.key}/names/${id}`);
  }

  function namesSection() {
    const people = [...scorebookPeople().values()].filter(p => !p.member).sort((a, b) => a.name.localeCompare(b.name));
    const renames = (state.names || []).slice().sort((a, b) => a.from.localeCompare(b.from));
    if (!people.length && !renames.length) return null;
    const editing = state.renaming && people.find(p => p.key === state.renaming);
    const editor = p => {
      let typed = p.name;
      const others = people.filter(o => o.key !== p.key);
      const together = o => [...o.gameIDs].some(id => p.gameIDs.has(id));
      return h("div", { class: "card pad link-panel" },
        h("b", null, `Rename ${p.name}`),
        h("div", { class: "pin-search" },
          h("input", { type: "text", value: p.name, maxlength: "80", "aria-label": "New name", oninput: e => { typed = e.target.value; } }),
          h("button", { class: "btn small", type: "button", onclick: e => {
            const into = others.find(o => o.name.toLowerCase() === typed.trim().toLowerCase());
            if (into && together(into)) { alert(`${p.name} and ${into.name} played in the same game, so they can't be the same person.`); return; }
            if (into && !confirm(`${into.name} already exists, so their stats will be combined. Merge ${p.name} into ${into.name}?`)) return;
            action(async () => { await saveRename(p.name, typed); state.renaming = null; }, { after: refreshNow })(e);
          } }, "Rename")),
        others.length ? [h("div", { class: "k" }, "Same person as"),
          others.map(o => h("button", { type: "button", class: "link-row", disabled: together(o) || null, onclick: e => {
            if (confirm(`Merge ${p.name} into ${o.name}? Every game with ${p.name} counts as ${o.name}'s.`)) {
              action(async () => { await saveRename(p.name, o.name); state.renaming = null; }, { after: refreshNow })(e);
            }
          } }, h("span", null, o.name), h("span", { class: "muted small" }, together(o) ? "played together" : `${o.games} G · ${o.pa} PA`)))] : null,
        h("div", { class: "form-actions start" }, h("button", { class: "btn small ghost", type: "button", onclick: () => { state.renaming = null; render(); } }, "Cancel")));
    };
    return [
      h("h2", { class: "section" }, "Scorebook names"),
      h("div", { class: "card roster" }, people.map(p => h("div", { class: "roster-row" },
        h("div", { class: "rname" }, p.name, h("span", { class: "you" }, `${p.games} G · ${p.pa} PA`)),
        h("div", { class: "radmin" }, h("button", { class: "link-btn", type: "button", onclick: () => { state.renaming = p.key; render(); } }, "Rename"))))),
      editing ? editor(editing) : null,
      renames.length ? h("details", { class: "fold" }, h("summary", null, `Renamed (${renames.length})`),
        h("div", { class: "card roster" }, renames.map(r => h("div", { class: "roster-row" },
          h("div", { class: "rname" }, `${r.from} → ${r.to}`),
          h("div", { class: "radmin" }, h("button", { class: "link-btn danger", type: "button", onclick: action(() => undoRename(r.id), { after: refreshNow }) }, "Undo")))))) : null,
      h("div", { class: "legend" }, "Names in the scorebook that aren't teammates' accounts (fill-ins, and players before they joined). Rename fixes a typo in every game; picking “Same person as” merges two names. To give a teammate their stats, use Link above instead."),
    ];
  }

  function teamView() {
    const manager = isManager();
    const invite = state.settings?.inviteCode ? `${SITE}?join=${state.settings.inviteCode}` : "";
    const rank = uid => ["admin", "lead", "scorer", "scheduler", "player"].indexOf(roleOf(uid));
    const sorted = [...state.members].sort((a, b) => rank(a.uid) - rank(b.uid) || (a.name || "").localeCompare(b.name || ""));
    return [
      manager && invite ? [
        h("h2", { class: "section" }, "Invite teammates"),
        h("div", { class: "card pad" },
          h("p", { class: "muted small", style: "margin-top:0" }, "Send this link to your team. They sign in with their email and they're on the team."),
          h("div", { class: "codebox" }, invite),
          h("div", { class: "form-actions start" }, copyButton(invite, "Copy Link"), shareButton(invite, `Join ${state.team.name} on Team Stats`),
            h("button", { class: "btn small ghost", type: "button", onclick: e => {
              if (confirm("Make a new invite link? The old one stops working.")) action(newInviteLink, { after: refreshNow })(e);
            } }, "New Link"))),
      ] : null,
      h("h2", { class: "section" }, `Players (${state.members.length})`),
      h("div", { class: "card roster" }, sorted.map(m => h("div", { class: "roster-row" },
        h("div", { class: "rname" }, m.name || "Player",
          roleOf(m.uid) === "player" ? null
            : h("span", { class: `pill ${roleOf(m.uid) === "admin" ? "mgr" : "role"}` }, ROLES.find(r => r[0] === roleOf(m.uid))[1]),
          m.uid === me() ? h("span", { class: "you" }, "You") : null),
        manager && m.uid !== me() ? h("div", { class: "radmin" },
          roleSelect(m.uid, roleOf(m.uid)),
          h("button", { class: "link-btn danger", type: "button", onclick: e => {
            if (confirm(`Remove ${m.name || "this player"} from ${state.team.name}?`)) action(() => removeMember(m.uid), { after: refreshNow })(e);
          } }, "Remove")) : null,
        manager ? linkStatus(m) : null))),
      manager && state.linking ? linkPanel(state.members.find(m => m.uid === state.linking)) : null,
      manager ? otherTeamsSection() : null,
      manager ? h("div", { class: "legend" }, "Link each player to the name they've been scored under (in the app or here): their stats then follow their account, under the name they chose. Admins have full control: players, roles, invites, links and the team. Managers set the schedule, choose lineups and keep score. Scorekeepers keep score from the lineup a manager set (they can make subs and add late arrivals). Schedulers add, edit and delete games on the schedule. Players see the schedule and stats and answer for themselves.") : null,
      manager ? namesSection() : null,
      manager ? themeSection() : null,
      manager && state.settings?.scorerCode ? [
        h("h2", { class: "section" }, "Keeping score in the app"),
        h("div", { class: "card pad" },
          h("p", { class: "muted small", style: "margin-top:0" },
            "In Slow Pitch Book on the scorer's iPhone or iPad: Teams → this team → I Have a Scorer Code. Stats from that device then appear here. Only give it to people who keep score."),
          h("div", { class: "codebox big" }, showCode(state.settings.scorerCode)),
          h("div", { class: "form-actions start" }, copyButton(showCode(state.settings.scorerCode), "Copy Code"))),
      ] : null,
      h("h2", { class: "section" }, "Team"),
      h("div", { class: "card pad team-actions" },
        manager ? h("button", { class: "btn small ghost", type: "button", onclick: e => {
          const name = prompt("Team name:", state.team.name);
          if (name && name.trim()) action(() => renameTeam(name.trim()), { after: refreshNow })(e);
        } }, "Rename Team") : null,
        DEMO ? null : h("button", { class: "btn small ghost", type: "button", onclick: e => {
          if (manager && (state.team.managers || []).length <= 1) {
            alert("You're the only admin. Make someone else an admin first, or delete the team.");
            return;
          }
          if (confirm(`Leave ${state.team.name}? You'll need a new invite to come back.`)) {
            action(leaveTeam, { after: () => { location.href = SITE; } })(e);
          }
        } }, "Leave Team"),
        manager && !DEMO ? h("button", { class: "btn small danger", type: "button", onclick: e => {
          const typed = prompt(`This deletes ${state.team.name} for everyone: schedule, answers, players and stats. Type the team name to confirm.`);
          if (typed != null && typed.trim().toLowerCase() === state.team.name.trim().toLowerCase()) {
            action(deleteTeam, { after: () => { location.href = SITE; } })(e);
          }
        } }, "Delete Team") : null),
    ];
  }

  function liveCard(g) {
    const l = g.live || {};
    const visitorsFirst = g.isHome ? [[them(g), g.them ?? "–"], [us(g), g.us]] : [[us(g), g.us], [them(g), g.them ?? "–"]];
    const runners = [["1st", l.first], ["2nd", l.second], ["3rd", l.third]].filter(([, n]) => n);
    return h("a", { class: "board live-card", href: `#/game/${encodeURIComponent(g.id)}`, style: "display:block;text-decoration:none" },
      h("div", { class: "live-top" },
        h("span", { class: "pill live" }, "Live"),
        h("span", { class: "where" }, `${title(g)} · ${fmtDay(g.date)}`),
        h("span", { class: "open" }, "Open game ›")),
      h("div", { class: "live-body" },
        h("div", null,
          visitorsFirst.map(([name, runs]) => h("div", { class: "score-row" },
            h("span", { class: "tm" }, name), h("span", { class: "rn" }, runs))),
          h("div", { class: "situation" },
            h("span", null, `${g.isHome ? "▼" : "▲"} ${ordinal(l.inning || 1)}`),
            h("span", null, `${l.outs || 0} out${l.outs === 1 ? "" : "s"}`,
              h("span", { class: "outs", "aria-hidden": "true" },
                [0, 1, 2].map(i => h("i", { class: i < (l.outs || 0) ? "on" : null }))))),
          l.batter ? h("div", { class: "atbat" }, "At bat: ", h("b", null, l.batter)) : null,
          l.pitcher ? h("div", { class: "atbat" }, "Pitching: ", h("b", null, l.pitcher)) : null),
        h("div", { class: "diamond" },
          h("div", { svg: diamondSVG(l) }),
          h("div", { class: "runners" },
            runners.length ? runners.map(([b, n]) => h("div", null, `${b}: ${n}`)) : "Bases empty"))));
  }

  /// "Keep Score" for managers and scorers, with anything still waiting to upload from this phone.
  function keepScoreBar() {
    if (!scorer || !(scorer.isScorerHere() || scorer.recsForTeam(state.key).length)) return null;
    const waiting = scorer.waiting(state.key);
    return h("a", { class: "card keep-score", href: "#/score" },
      h("span", { class: "ks-icon", "aria-hidden": "true" }, "✎"),
      h("div", null, h("b", null, "Keep Score"), h("div", { class: "muted small" },
        waiting ? `${waiting} game${waiting === 1 ? "" : "s"} on this phone still to upload` : "Score a game from this phone")),
      h("span", { class: "chev", "aria-hidden": "true" }, "›"));
  }

  function gamesView() {
    return [keepScoreBar(), gamesList()];
  }

  function gamesList() {
    const live = state.games.filter(g => !g.isFinal);
    const row = g => h("a", { class: "game-row", href: `#/game/${encodeURIComponent(g.id)}` },
      // No result known (an imported game with no pitching): a plain badge, not a tie.
      h("span", { class: `badge ${g.isFinal ? (g.outcome || "T") : "LIVE"}` }, g.isFinal ? (g.outcome || (g.them == null ? "–" : "T")) : "LIVE"),
      h("div", null,
        h("div", { class: "who" }, title(g)),
        h("div", { class: "when" }, [g.team, fmtDate(g.date)].filter(Boolean).join(" · "))),
      h("span", { class: "sc" }, `${g.us}–${g.them ?? "?"}`),
      h("span", { class: "chev", "aria-hidden": "true" }, "›"));
    const list = games => h("div", { class: "card games", style: "gap:0;overflow:hidden" },
      games.map((g, i) => [i ? h("div", { style: "height:1px;background:var(--line);margin-left:66px" }) : null, row(g)]));

    if (!state.games.length) {
      return [h("h2", { class: "section" }, "Games"),
        h("div", { class: "card empty" }, "No stats yet. Games kept in the Slow Pitch Book app show up here once the scorer links the app (Team tab).")];
    }
    // Live games first, then the rest grouped by season / tournament like the app (newest group first,
    // games with no season last). Without any seasons it's one plain list.
    // Live games always get their scoreboard card on top; the list is the season picked in the header.
    const ordered = [...live.filter(inEvent), ...state.games.filter(g => g.isFinal && inEvent(g))];
    if (!ordered.length) {
      return [live.map(liveCard), h("h2", { class: "section" }, currentEventLabel() || "Games"),
        h("div", { class: "card empty" }, "No games in this season yet. Tap the season at the top right to pick another.")];
    }
    const events = eventsOf(ordered);
    if (!events.length) return [live.map(liveCard), h("h2", { class: "section" }, "Games"), list(ordered)];
    const groups = events.map(e => ({ title: e.name, tournament: e.kind === "tournament", games: ordered.filter(g => eventKey(g) === e.key) }));
    const rest = ordered.filter(g => !g.event);
    if (rest.length) groups.push({ title: "Other games", tournament: false, games: rest });
    return [
      live.map(liveCard),
      groups.map(gr => [
        h("h2", { class: "section" }, gr.title, gr.tournament ? h("span", { class: "pill tourney" }, "Tournament") : null,
          h("span", { class: "rec" }, record(gr.games))),
        list(gr.games),
      ]),
    ];
  }

  function lineScore(g) {
    const n = Math.max(g.usByInning?.length || 0, g.themByInning?.length || 0, 1);
    const innings = Array.from({ length: n }, (_, i) => i + 1);
    const usRow = { name: us(g), runs: g.usByInning || [], r: g.us, h: g.totals?.h ?? "–" };
    const themRow = { name: them(g), runs: g.themByInning || [], r: g.them ?? "–", h: "–" };
    const rows = g.isHome ? [themRow, usRow] : [usRow, themRow];
    return h("div", { class: "card scroll" }, h("table", { class: "stats line" },
      h("thead", null, h("tr", null, h("th", null, ""), innings.map(i => h("th", null, i)), h("th", { class: "r" }, "R"), h("th", null, "H"))),
      h("tbody", null, rows.map(r => h("tr", null,
        h("td", null, r.name),
        innings.map(i => h("td", null, r.runs[i - 1] ?? "")),
        h("td", { class: "r" }, r.r), h("td", null, r.h))))));
  }

  /// Fixes the other team's runs on a game the app scored (the website only has its published summary).
  async function saveOpponentRuns(id, runs) {
    const fix = g => {
      g.themByInning = runs;
      g.them = runs.reduce((a, b) => a + b, 0);
      if (g.isFinal) g.outcome = g.us > g.them ? "W" : g.us < g.them ? "L" : "T";
      return g;
    };
    if (DEMO) { const g = state.games.find(x => x.id === id); if (g) fix(g); return; }
    const doc = await getDoc(`teams/${state.key}/games/${encodeURIComponent(id)}`);
    if (!doc?.json) throw new Error("That game isn't on the website anymore.");
    await setDoc(`teams/${state.key}/games/${encodeURIComponent(id)}`, { json: JSON.stringify(fix(JSON.parse(doc.json))), updatedAt: now() },
      { mask: ["json", "updatedAt"], exists: true });
  }

  function opponentRunsEditor(g) {
    const n = Math.max(g.usByInning?.length || 0, g.themByInning?.length || 0, 1);
    const d = state.fixingScore;
    if (!d.runs) d.runs = Array.from({ length: n }, (_, i) => g.themByInning?.[i] || 0);
    const set = (i, v) => { d.runs[i] = Math.max(0, Math.min(99, v)); render(); };
    const total = d.runs.reduce((a, b) => a + b, 0);
    return h("div", { class: "card pad fix-score" },
      h("b", null, `${them(g)} runs by inning`),
      d.runs.map((r, i) => h("div", { class: "opp-row" }, h("span", null, `Inning ${i + 1}`),
        h("span", { class: "stepper" },
          h("button", { type: "button", "aria-label": `One less run in inning ${i + 1}`, onclick: () => set(i, r - 1) }, "−"),
          h("b", null, String(r)),
          h("button", { type: "button", "aria-label": `One more run in inning ${i + 1}`, onclick: () => set(i, r + 1) }, "+")))),
      h("div", { class: "opp-row" }, h("span", null, "Add an inning"),
        h("span", { class: "stepper" }, h("button", { type: "button", "aria-label": "Add an inning", onclick: () => { d.runs.push(0); render(); } }, "+"))),
      h("p", { class: "muted small" }, `Final: ${g.isHome ? `${them(g)} ${total} – ${us(g)} ${g.us}` : `${us(g)} ${g.us} – ${them(g)} ${total}`}. `
        + "This game was scored in the Stat Book app: if it's changed there later, the app's copy replaces this fix."),
      h("div", { class: "form-actions start" },
        h("button", { class: "btn small", type: "button", onclick: action(async () => { await saveOpponentRuns(g.id, d.runs); state.fixingScore = null; }, { after: refreshNow }) }, "Save Score"),
        h("button", { class: "btn small ghost", type: "button", onclick: () => { state.fixingScore = null; render(); } }, "Cancel")));
  }

  function gameView(id) {
    if (state.fixingScore && state.fixingScore.id !== id) state.fixingScore = null;
    const g = state.games.find(x => x.id === id);
    if (!g) return [h("a", { class: "back", href: "#/games" }, "‹ All games"), h("div", { class: "card empty", style: "margin-top:12px" }, "That game isn't on the website anymore.")];
    loadScored(g);
    // Fixing a finished game: games scored here open in the scorer (every play is kept); the app's only have their summary.
    const scoredHere = state.scored[g.id]?.game;
    const canFix = g.isFinal && scorer?.isScorerHere();
    const editBtn = !canFix || scoredHere === "loading" || scoredHere === undefined ? null
      : scoredHere ? h("a", { class: "btn small", href: `#/score/${encodeURIComponent(g.id)}` }, "Edit Game")
      : state.fixingScore?.id === g.id ? null
      : h("button", { class: "btn small ghost", type: "button", onclick: () => { state.fixingScore = { id: g.id }; render(); } }, "Fix Opponent Score");
    const deleteBtn = isAdmin() && scorer ? h("button", { class: "btn small danger", type: "button", onclick: action(async () => {
      if (await scorer.confirmDeleteGame(state.key, g.id, title(g))) { location.hash = "#/games"; await refreshNow(); }
    }, { after: () => {} }) }, "Delete Game") : null;

    const lines = (g.lines || []).filter(l => l.pa > 0 || l.r > 0 || l.crr > 0).map(derive);
    const totals = g.totals ? { ...derive(g.totals), name: "Team", _total: true } : null;
    const players = [...new Set((g.spray || []).map(s => s.name))];
    const chosen = players.includes(state.gamePlayer[g.id]) ? state.gamePlayer[g.id] : "";
    const dots = (g.spray || []).filter(s => !chosen || s.name === chosen);
    const status = g.isFinal ? (g.outcome === "W" ? "Final · Win" : g.outcome === "L" ? "Final · Loss" : "Final") : "Live";

    const byInning = new Map();
    for (const p of g.plays || []) {
      if (!byInning.has(p.inning)) byInning.set(p.inning, []);
      byInning.get(p.inning).push(p);
    }

    const book = state.books[g.id];
    const scored = state.scored[g.id]?.game;
    return [
      h("a", { class: "back", href: "#/games" }, "‹ All games"),
      h("div", { class: "board game-head" },
        h("div", { class: "status" }, g.isFinal ? status : h("span", { class: "pill live" }, "Live")),
        // Visitors on the left, home team on the right.
        h("div", { class: "teams" }, (g.isHome ? [[them(g), g.them ?? "–"], [us(g), g.us]] : [[us(g), g.us], [them(g), g.them ?? "–"]])
          .map(([name, runs]) => h("div", null, h("div", { class: "tn" }, name), h("div", { class: "big" }, runs)))
          .flatMap((side, i) => (i ? [h("div", { class: "dash" }, "–"), side] : [side]))),
        h("div", { class: "date" }, `${title(g)} · ${fmtDate(g.date)}`)),
      g.isFinal ? null : liveCard(g),
      h("h2", { class: "section" }, "Line Score", editBtn),
      lineScore(g),
      state.fixingScore?.id === g.id ? opponentRunsEditor(g) : null,
      h("h2", { class: "section" }, "Batting"),
      lines.length ? statsTable(BATTING, totals ? [...lines, totals] : lines) : h("div", { class: "card empty" }, "No at-bats yet."),
      (g.pitching || []).length ? [
        h("h2", { class: "section" }, "Pitching"),
        statsTable([PITCHING[0], ...PITCHING.slice(5)], g.pitching.map(l => pitchDerive({ ...l,
          name: l.name + (l.w ? " (W)" : l.l ? " (L)" : "") }))),
      ] : null,
      h("h2", { class: "section" }, "Spray Chart"),
      players.length ? h("div", { class: "controls" },
        h("select", {
          class: "control", "aria-label": "Player",
          onchange: e => { state.gamePlayer[g.id] = e.target.value; render(); },
        }, h("option", { value: "" }, "Whole team"),
          players.map(p => { const o = h("option", { value: p }, p); if (p === chosen) o.selected = true; return o; }))) : null,
      sprayCard(chosen || "Team Spray Chart", `${fmtDate(g.date)} · ${title(g)}`, dots),
      h("h2", { class: "section" }, "Play-by-Play"),
      byInning.size
        ? h("div", { class: "card pbp" }, [...byInning.entries()].map(([inn, plays]) => [
            h("div", { class: "inn" }, `${ordinal(inn)} inning`),
            plays.map(p => h("div", { class: "play" }, h("div", null, p.text), p.runners ? h("div", { class: "r" }, p.runners) : null)),
          ]))
        : h("div", { class: "card empty" }, "No plays yet."),
      scored && scored !== "loading" ? [
        h("h2", { class: "section" }, "Scorebook"),
        StatBook.panel(withBookNames(scored)),
      ] : g.isFinal ? [
        h("h2", { class: "section" }, "Scorebook"),
        h("div", { class: "card book pad" },
          book && book.startsWith("data:")
            ? h("img", { src: book, alt: `Scorebook for ${title(g)} on ${fmtDate(g.date)}` })
            : h("div", { class: "note" }, book === "none" ? "The scorebook image isn't available for this game." : "Loading the scorebook…")),
      ] : null,
      deleteBtn ? h("div", { class: "form-actions start", style: "margin-top:28px" }, deleteBtn) : null,
    ];
  }

  function statsView() {
    const teams = [...new Set(state.games.map(g => g.team).filter(Boolean))].sort();
    const team = teams.includes(state.statsTeam) ? state.statsTeam : "";
    const games = state.games.filter(g => (!team || g.team === team) && inEvent(g));
    const finals = games.filter(g => g.isFinal).length;
    const mode = ["table", "trends"].includes(state.statsMode) ? state.statsMode : "leaders";
    const modeBtn = (key, label) => h("button", { class: `seg-btn stats-mode${mode === key ? " on" : ""}`, type: "button",
      "aria-pressed": String(mode === key), onclick: () => { state.statsMode = key; render(); } }, label);
    return [
      h("h2", { class: "section" }, currentEventLabel() || "Season Stats",
        h("span", { class: "rec" }, `${record(games)} · ${finals} game${finals === 1 ? "" : "s"}`)),
      h("div", { class: "controls" },
        h("div", { class: "seg stats-modes", role: "group", "aria-label": "Show" },
          modeBtn("leaders", "Leaders"), modeBtn("table", "All Players"), modeBtn("trends", "Over Time")),
        teams.length > 1
          ? h("select", { class: "control", "aria-label": "Team", onchange: e => { state.statsTeam = e.target.value; render(); } },
              h("option", { value: "" }, "All teams"),
              teams.map(t => { const o = h("option", { value: t }, t); if (t === team) o.selected = true; return o; }))
          : null),
      ...(mode === "leaders" ? leadersSection(games) : mode === "trends" ? trendsSection(games) : statsTableSection(games)),
    ];
  }

  // ---------- Leaders (top five in each category) ----------

  /// Best Offensive Player: each player's number in each category is compared with the team's (how many
  /// spreads above or below the team average it is), then weighted by how much it wins games: getting on base and
  /// hitting for power most, then driving in and scoring runs, with the rest as tie-breakers. Counting stats are
  /// per game or per plate appearance, so a missed game doesn't sink a strong hitter. (OPS is left out: it's
  /// OBP + SLG again.) Shown as a rating where 50 is the team's average hitter.
  const OFFENSE = [
    { label: "OBP", weight: 24, of: r => r.obp },
    { label: "SLG", weight: 24, of: r => r.slg },
    { label: "RBI a game", weight: 12, of: r => (r.g ? r.rbi / r.g : 0) },
    { label: "AVG", weight: 10, of: r => r.avg },
    { label: "runs a game", weight: 10, of: r => (r.g ? r.r / r.g : 0) },
    { label: "home runs", weight: 6, of: r => (r.pa ? r.hr / r.pa : 0) },
    { label: "strikeouts", weight: -6, of: r => (r.pa ? r.k / r.pa : 0) },
    { label: "doubles and triples", weight: 4, of: r => (r.pa ? (r.b2 + r.b3) / r.pa : 0) },
    { label: "walks", weight: 4, of: r => (r.pa ? r.bb / r.pa : 0) },
  ];
  const OFFENSE_TOTAL = OFFENSE.reduce((s, c) => s + Math.abs(c.weight), 0);
  function offenseRatings(rows) {
    const spread = OFFENSE.map(c => {
      const vals = rows.map(c.of);
      const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
      const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length);
      return { ...c, mean, sd };
    });
    return rows.map(r => {
      const z = spread.reduce((sum, c) => sum + (c.sd ? ((c.of(r) - c.mean) / c.sd) * c.weight : 0), 0) / OFFENSE_TOTAL;
      return { ...r, rating: Math.round(50 + 15 * z) };
    });
  }

  const LEADERS = [
    { key: "rating", label: "Best Offensive Player", rated: true, value: r => String(r.rating) },
    { key: "avg", label: "Batting Average", qualified: true, value: r => rate(r.avg) },
    { key: "h", label: "Hits" },
    { key: "hr", label: "Home Runs" },
    { key: "rbi", label: "Runs Batted In" },
    { key: "r", label: "Runs Scored" },
    { key: "ops", label: "On Base Plus Slugging", qualified: true, value: r => rate(r.ops) },
    { key: "obp", label: "On Base Percentage", qualified: true, value: r => rate(r.obp) },
    { key: "slg", label: "Slugging Percentage", qualified: true, value: r => rate(r.slg) },
    { key: "tb", label: "Total Bases" },
    { key: "b1", label: "Singles" },
    { key: "b2", label: "Doubles" },
    { key: "b3", label: "Triples" },
    { key: "bb", label: "Walks" },
    { key: "pa", label: "Plate Appearances" },
  ];
  const PITCH_LEADERS = [
    { key: "outs", label: "Innings Pitched", value: r => inningsText(r.outs) },
    { key: "era", label: "Earned Run Average", qualified: true, low: true, value: r => r.era.toFixed(2) },
    { key: "w", label: "Wins" },
  ];

  /// The top five by `cat` (ties share a place), leaving out anyone with nothing in it.
  function topFive(rows, cat) {
    const val = r => r[cat.key];
    const sorted = rows.filter(r => val(r) != null && (cat.low || cat.rated || val(r) > 0))
      .sort((a, b) => (cat.low ? val(a) - val(b) : val(b) - val(a)) || b.pa - a.pa || a.name.localeCompare(b.name));
    let place = 0;
    return sorted.slice(0, 5).map((r, i) => {
      if (i === 0 || val(r) !== val(sorted[i - 1])) place = i + 1;
      return { r, place };
    });
  }

  const initials = name => String(name || "?").trim().split(/\s+/).slice(0, 2).map(w => w[0] || "").join("").toUpperCase() || "?";

  function leaderRow(cat, rows) {
    const top = topFive(rows, cat);
    if (!top.length) return [];
    return [
      h("h2", { class: "section leaders-title" }, cat.label),
      h("div", { class: "leader-row", role: "list" }, top.map(({ r, place }) =>
        h("div", { class: `leader-card${place === 1 ? " first" : ""}`, role: "listitem" },
          h("div", { class: "leader-face", "aria-hidden": "true" }, initials(r.name), h("span", { class: "leader-place" }, place)),
          h("div", { class: "leader-name" }, r.name),
          h("div", { class: "leader-value" }, cat.value ? cat.value(r) : r[cat.key])))),
    ];
  }

  function leadersSection(games) {
    const batters = seasonLines(games);
    if (!batters.length) return [h("div", { class: "card empty" }, "No stats yet.")];
    // Averages and the overall rating only count regular players: at least 2 plate appearances a game the team
    // played (anyone, if nobody's there yet), so a 1-for-1 night doesn't top the list.
    const teamGames = Math.max(1, ...batters.map(r => r.g));
    const regular = batters.filter(r => r.pa >= 2 * teamGames);
    const qualified = regular.length ? regular : batters;
    const rated = offenseRatings(qualified);
    const pitchers = seasonPitching(games);
    const pitchGames = games.filter(g => g.isFinal).length;
    const regularArms = pitchers.filter(p => p.outs >= 3 * pitchGames);
    const arms = regularArms.length ? regularArms : pitchers.filter(p => p.outs > 0);
    return [
      ...LEADERS.flatMap(cat => leaderRow(cat, cat.rated ? rated : cat.qualified ? qualified : batters)),
      ...PITCH_LEADERS.flatMap(cat => leaderRow(cat, cat.qualified ? arms : pitchers)),
      h("div", { class: "legend" },
        `Best Offensive Player compares each hitter with the rest of the team, weighting what wins games most: ${OFFENSE.map(c => `${c.label} ${Math.abs(c.weight)}%`).join(", ")} (strikeouts count against; RBI and runs are per game, the others per plate appearance, so a missed game doesn't count against anyone). 50 is the team's average hitter. It and the averages count players with at least 2 plate appearances a game (${2 * teamGames} so far)${regular.length ? "" : "; nobody has that many yet, so everyone counts for now"}. ERA counts pitchers with an inning a game.`),
    ];
  }

  /// Stats → Over Time: pick any player and see their running averages game by game.
  function trendsSection(games) {
    const keyOf = l => (l.member ? `m:${l.member}` : `n:${String(l.name || "").trim().toLowerCase()}`);
    const people = new Map();
    for (const g of games) for (const l of g.lines || []) if (counts(l)) people.set(keyOf(l), String(l.name || "").trim());
    if (!people.size) return [h("div", { class: "card empty" }, "No stats yet.")];
    const sorted = [...people.entries()].sort((a, b) => a[1].localeCompare(b[1]));
    // You first if you're in there, else the first name.
    const mineKey = [...people.keys()].find(k => k === `m:${me()}`) || sorted.find(([, n]) => isMine({ name: n }))?.[0];
    const key = people.has(state.trendPlayer) ? state.trendPlayer : mineKey || sorted[0][0];
    const played = [], lines = [];
    for (const g of games) {
      const ls = (g.lines || []).filter(l => keyOf(l) === key && counts(l));
      if (!ls.length) continue;
      played.push(g);
      lines.push(Object.fromEntries(FIELDS.map(f => [f, ls.reduce((s, l) => s + (l[f] || 0), 0)])));
    }
    const pick = h("select", { class: "control", "aria-label": "Player", onchange: e => { state.trendPlayer = e.target.value; render(); } },
      sorted.map(([k, n]) => { const o = h("option", { value: k }, n); if (k === key) o.selected = true; return o; }));
    return [
      h("div", { class: "controls" }, pick),
      played.length > 1 ? trendChart(played, lines, people.get(key))
        : h("div", { class: "card empty" }, `${people.get(key)} has only played one game here, so there's nothing to chart yet.`),
    ];
  }

  function statsTableSection(games) {
    const { col, dir } = state.statsSort;
    const rows = seasonLines(games).sort((a, b) => {
      if (col === "name") return a.name.localeCompare(b.name) * -dir;
      return (b[col] - a[col]) * -dir || b.ab - a.ab || a.name.localeCompare(b.name);
    });
    const total = rows.length ? derive(Object.fromEntries([["name", "Team"], ...FIELDS.map(f => [f, rows.reduce((s, r) => s + r[f], 0)])])) : null;
    if (total) { total._total = true; total.g = ""; }
    const columns = [BATTING[0], { key: "g", label: "G", title: "Games" }, ...BATTING.slice(1)];
    return [
      rows.length
        ? statsTable(columns, [...rows, total], {
            sort: state.statsSort,
            onSort: key => {
              state.statsSort = { col: key, dir: state.statsSort.col === key ? -state.statsSort.dir : -1 };
              render();
            },
          })
        : h("div", { class: "card empty" }, "No stats yet."),
      h("div", { class: "legend" }, "Tap a column to sort. Players are matched by account when the scorer has linked them, otherwise by name. AVG = H/AB · OBP = (H+BB)/(AB+BB+SF) · SLG = total bases/AB."),
      ...pitchingSection(games),
    ];
  }

  function pitchingSection(games) {
    const rows = seasonPitching(games).sort((a, b) => b.outs - a.outs || a.name.localeCompare(b.name));
    if (!rows.length) return [];
    const total = pitchDerive({ name: "Team", g: "", gs: "", w: rows.reduce((s, r) => s + r.w, 0), l: rows.reduce((s, r) => s + r.l, 0),
      outs: rows.reduce((s, r) => s + r.outs, 0), r: rows.reduce((s, r) => s + r.r, 0) });
    total._total = true;
    return [h("h2", { class: "section" }, "Pitching"), statsTable(PITCHING, rows.length > 1 ? [...rows, total] : rows), h("div", { class: "legend" }, PITCH_NOTE)];
  }

  function sprayView() {
    const pool = state.games.filter(inEvent);
    const all = [];
    for (const g of pool) for (const s of g.spray || []) all.push({ ...s, game: g });
    const players = [...new Set(all.map(s => s.name))].sort((a, b) => a.localeCompare(b));
    const player = players.includes(state.sprayPlayer) ? state.sprayPlayer : "";
    const gamesWith = pool.filter(g => (g.spray || []).some(s => !player || s.name === player));
    const game = gamesWith.find(g => g.id === state.sprayGame) || null;
    const dots = all.filter(s => (!player || s.name === player) && (!game || s.game === game));
    const label = game ? `${fmtDate(game.date)} · ${title(game)}` : `${currentEventLabel() || "All games"} · ${state.board?.name || ""}`;
    const option = (value, text, selected) => { const o = h("option", { value }, text); if (selected) o.selected = true; return o; };
    return [
      h("h2", { class: "section" }, "Spray Charts"),
      h("div", { class: "controls" },
        h("select", { class: "control", "aria-label": "Player", onchange: e => { state.sprayPlayer = e.target.value; render(); } },
          option("", "Whole team", !player),
          players.map(p => option(p, `${p} (${all.filter(s => s.name === p).length})`, p === player))),
        h("select", { class: "control", "aria-label": "Game", onchange: e => { state.sprayGame = e.target.value; render(); } },
          option("", "All games", !game),
          gamesWith.map(g => option(g.id, `${fmtDate(g.date)} · ${title(g)}`, g === game)))),
      all.length
        ? sprayCard(player || "Team Spray Chart", label, dots)
        : h("div", { class: "card empty" }, "No balls in play have a location yet."),
    ];
  }

  // ---------- My Stats (the signed-in player's own numbers) ----------

  /// Is this stat line (or spray dot) you? Lines the app linked to an account match by account;
  /// unlinked ones by the name you go by, the same way the app links a typed-in name.
  function isMine(x) {
    if (x.member) return x.member === me();
    const mine = (state.profile?.name || "").trim().toLowerCase();
    return !!mine && String(x.name || "").trim().toLowerCase() === mine;
  }
  const counts = l => l.pa > 0 || l.r > 0 || l.crr > 0;

  /// Published games from the teams in `ids` (every team you're on for "All my teams").
  async function loadAllMyGames(ids = Object.keys(state.profile.teams || {})) {
    // Each team's links and renames apply to its own games, like on that team's pages.
    const lists = await Promise.all(ids.map(id => id === state.key ? state.games
      : Promise.all([
          listDocs(`teams/${id}/games`).then(ds => ds.map(d => { try { return JSON.parse(d.json); } catch { return null; } }).filter(Boolean)),
          listDocs(`teams/${id}/members`).then(ds => ds.map(d => ({ uid: d.id, name: d.name }))).catch(() => []),
          listDocs(`teams/${id}/links`).then(ds => ds.map(l => ({ ...l, id: l.name ? linkKey(l.name) : l.id }))).catch(() => []),
          listDocs(`teams/${id}/names`).then(ds => ds.map(r => ({ ...r, id: r.from ? linkKey(r.from) : r.id }))).catch(() => []),
        ]).then(([games, members, links, names]) => withMemberNames(games, members, links, names)).catch(() => [])));
    return lists.flat();
  }

  /// Your line in one game (summed, in case you were in it under two names).
  function myLine(g) {
    const ls = (g.lines || []).filter(l => isMine(l) && counts(l));
    if (!ls.length) return null;
    return Object.fromEntries(FIELDS.map(f => [f, ls.reduce((s, l) => s + (l[f] || 0), 0)]));
  }
  const sumLines = (name, lines) =>
    derive(Object.fromEntries([["name", name], ["g", lines.length], ...FIELDS.map(f => [f, lines.reduce((s, l) => s + l[f], 0)])]));
  const yearOf = g => String(g.date || "").slice(0, 4);

  /// Your pitching in `games` (only shown if you've pitched).
  function myPitching(games) {
    const mine = games.map(g => ({ ...g, pitching: (g.pitching || []).filter(isMine) })).filter(g => g.pitching.length);
    const rows = seasonPitching(mine);
    if (!rows.length) return [];
    const t = pitchDerive(rows.reduce((a, r) => ({ ...a, g: a.g + r.g, gs: a.gs + r.gs, w: a.w + r.w, l: a.l + r.l, outs: a.outs + r.outs, r: a.r + r.r }),
      { name: "Pitching", g: 0, gs: 0, w: 0, l: 0, outs: 0, r: 0 }));
    return [
      h("h2", { class: "section" }, "My Pitching"),
      h("div", { class: "card my-counts" }, [["G", t.g], ["GS", t.gs], ["W-L", `${t.w}-${t.l}`], ["IP", t.ip], ["R", t.r],
        ["ERA", t.era == null ? "–" : t.era.toFixed(2)]].map(([k, v]) => h("div", null, h("b", null, v), h("span", null, k)))),
    ];
  }

  // ---------- My Stats: the trend chart ----------

  const TREND = [
    { key: "avg", label: "AVG" }, { key: "obp", label: "OBP" }, { key: "slg", label: "SLG" }, { key: "ops", label: "OPS" },
  ];
  /// Which lines are showing (remembered on this device).
  function trendShown() {
    if (!state.myTrend) {
      try { state.myTrend = JSON.parse(storage.get("statbook.mytrend") || "null"); } catch { state.myTrend = null; }
      if (!state.myTrend || typeof state.myTrend !== "object") state.myTrend = { avg: true, obp: true, slg: true, ops: true };
    }
    return state.myTrend;
  }

  /// A player's AVG / OBP / SLG / OPS after each game (running totals), oldest game first: `lines[i]` is
  /// their line in `games[i]`. Used for you on My Stats and for anyone on Stats → Over Time.
  function trendChart(games, lines, heading = "Over Time") {
    const order = games.map((g, i) => i).sort((a, b) => (games[a].date || "").localeCompare(games[b].date || "") || String(games[a].id).localeCompare(String(games[b].id)));
    const run = Object.fromEntries(FIELDS.map(f => [f, 0]));
    const points = order.map(i => {
      for (const f of FIELDS) run[f] += lines[i][f] || 0;
      return { game: games[i], ...derive({ ...run }) };
    });
    const shown = trendShown();
    const on = TREND.filter(t => shown[t.key]);
    const toggle = t => h("button", { type: "button", class: `trend-chip s-${t.key}`, "aria-pressed": String(!!shown[t.key]),
      onclick: () => { shown[t.key] = !shown[t.key]; storage.set("statbook.mytrend", JSON.stringify(shown)); render(); } },
      h("span", { class: "trend-swatch", "aria-hidden": "true" }), t.label);

    // Drawn at the size it shows, so its text stays readable on a phone.
    const W = Math.round(Math.max(300, Math.min(940, (document.querySelector("main.wrap")?.clientWidth || window.innerWidth) - 66)));
    const H = W < 500 ? 220 : 260, L = 40, R = 66, T = 14, B = 26;
    const pw = W - L - R, ph = H - T - B, n = points.length;
    const max = Math.max(0.5, ...on.flatMap(t => points.map(p => p[t.key])));
    const step = max > 1.5 ? 0.5 : max > 0.8 ? 0.25 : 0.1;
    const top = Math.ceil(max / step - 1e-9) * step;
    const x = i => L + (n === 1 ? pw / 2 : (i * pw) / (n - 1));
    const y = v => T + ph - (v / top) * ph;
    const fmt = v => rate(v);
    const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => +(i * step).toFixed(3));
    const grid = ticks.map(v => `<line class="trend-grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>` +
      `<text class="trend-tick" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`).join("");
    const xLabels = [0, n - 1].filter((v, i, a) => a.indexOf(v) === i).map(i =>
      `<text class="trend-tick" x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : "end"}">${fmtDate(points[i].game.date).replace(/[<&>]/g, "")}</text>`).join("");
    const paths = on.map(t => `<path class="trend-line s-${t.key}" d="${points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[t.key]).toFixed(1)}`).join("")}"/>`).join("");
    // Each line's latest value at its end, nudged apart so they never overlap.
    const ends = on.map(t => ({ t, v: points[n - 1][t.key], y: y(points[n - 1][t.key]) })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 13);
    const endLabels = ends.map(e => `<circle class="trend-dot s-${e.t.key}" cx="${x(n - 1)}" cy="${y(e.v)}" r="3.5"/>` +
      `<text class="trend-end" x="${x(n - 1) + 8}" y="${e.y + 4}">${e.t.label} ${fmt(e.v)}</text>`).join("");

    const svg = h("div", { class: "trend-plot", svg: `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Running AVG, OBP, SLG and OPS by game">` +
      grid + xLabels + paths + endLabels +
      `<line class="trend-cross" x1="0" x2="0" y1="${T}" y2="${T + ph}" visibility="hidden"/>` +
      on.map(t => `<circle class="trend-hover s-${t.key}" r="4.5" cx="0" cy="0" visibility="hidden"/>`).join("") +
      `<rect class="trend-hit" x="${L}" y="${T}" width="${pw}" height="${ph}" fill="transparent"/></svg>` });
    const tip = h("div", { class: "trend-tip", role: "status", hidden: true });
    const plot = h("div", { class: "trend-wrap" }, svg, tip);
    // Hover / touch: snap to the nearest game and show every visible stat there.
    const show = e => {
      const box = plot.querySelector("svg").getBoundingClientRect();
      const px = ((e.clientX - box.left) / box.width) * W;
      const i = Math.max(0, Math.min(n - 1, Math.round(((px - L) / pw) * (n - 1))));
      const p = points[i];
      const cross = plot.querySelector(".trend-cross");
      cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
      for (const t of on) {
        const c = plot.querySelector(`.trend-hover.s-${t.key}`);
        c.setAttribute("cx", x(i)); c.setAttribute("cy", y(p[t.key])); c.setAttribute("visibility", "visible");
      }
      tip.replaceChildren(
        h("div", { class: "trend-tip-title" }, `${fmtDate(p.game.date)} · ${title(p.game)}`),
        h("div", { class: "muted small" }, `After ${i + 1} game${i ? "s" : ""}: ${p.h}-for-${p.ab}`),
        ...on.map(t => h("div", { class: "trend-tip-row" }, h("span", { class: `trend-swatch s-${t.key}`, "aria-hidden": "true" }), h("b", null, fmt(p[t.key])), h("span", null, t.label))));
      tip.hidden = false;
      const left = (x(i) / W) * box.width;
      tip.style.left = `${Math.min(Math.max(left - tip.offsetWidth / 2, 0), box.width - tip.offsetWidth)}px`;
    };
    const hide = () => {
      tip.hidden = true;
      for (const el of plot.querySelectorAll(".trend-cross, .trend-hover")) el.setAttribute("visibility", "hidden");
    };
    if (on.length) {
      plot.addEventListener("pointermove", show);
      plot.addEventListener("pointerdown", show);
      plot.addEventListener("pointerleave", e => { if (e.pointerType === "mouse") hide(); });   // a tap's readout stays up
    }

    return [
      h("h2", { class: "section" }, heading, h("span", { class: "rec" }, "running totals")),
      h("div", { class: "card pad trend-card" },
        h("div", { class: "trend-chips", role: "group", "aria-label": "Lines to show" }, TREND.map(toggle)),
        on.length ? plot : h("div", { class: "muted trend-empty" }, "Turn on a stat above to see it over time.")),
    ];
  }

  function myStatsView() {
    const myTeams = state.profile?.teams || {};
    const teamCount = Object.keys(myTeams).length;
    // Which teams: this one (the default), all of them, or one of your other teams.
    const scope = state.myScope === "all" ? (teamCount > 1 ? "all" : "")
      : state.myScope && state.myScope !== state.key && myTeams[state.myScope] ? state.myScope : "";
    const all = scope === "all";
    const other = scope && !all ? scope : null;
    if (scope && state.myAll == null) {
      state.myAll = "loading";
      loadAllMyGames(other ? [other] : undefined)
        .then(gs => { state.myAll = gs; })
        .catch(() => { state.myAll = null; state.myScope = ""; state.flash = "Couldn't load your other teams."; })
        .finally(() => { if (route().name === "me") render(); });
    }
    const loading = !!scope && !Array.isArray(state.myAll);
    const solo = scorer ? scorer.mySoloGames() : [];
    const source = scope ? [...(loading ? [] : state.myAll), ...(all ? solo : [])] : [...state.games, ...solo];
    const pool = source.filter(g => myLine(g))
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""));

    const years = [...new Set(pool.map(yearOf).filter(Boolean))];
    // The season picked in the header (a year only matters for "All seasons"). It's this team's, so another
    // team, or all of them, shows every season, broken down below.
    const event = scope ? "" : currentEvent();
    const year = !event && years.includes(state.myYear) ? state.myYear : "";
    const inYear = pool.filter(g => !year || yearOf(g) === year);
    const events = eventsOf(inYear);
    const games = inYear.filter(g => !event || eventKey(g) === event);
    const lines = games.map(myLine);
    const total = lines.length ? sumLines("Total", lines) : null;

    const option = (value, text, selected) => { const o = h("option", { value }, text); if (selected) o.selected = true; return o; };
    const pick = (key, value) => { state[key] = value; render(); };
    const controls = h("div", { class: "controls" },
      teamCount > 1 ? h("select", { class: "control", "aria-label": "Teams",
        onchange: e => { state.myScope = e.target.value; state.myAll = null; render(); } },
        option("", `${state.team?.name || "This team"} (this team)`, !scope), option("all", "All my teams", all),
        Object.entries(myTeams).filter(([id]) => id !== state.key).sort((a, b) => String(a[1]).localeCompare(String(b[1])))
          .map(([id, name]) => option(id, name || "Team", id === other))) : null,
      !event && years.length > 1 ? h("select", { class: "control", "aria-label": "Year", onchange: e => pick("myYear", e.target.value) },
        option("", "All years", !year), years.map(y => option(y, y, y === year))) : null);

    const heading = h("h2", { class: "section" }, "My Stats",
      h("span", { class: "rec" }, [state.profile?.name, total ? `${total.g} game${total.g === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ")));
    const tracked = scorer ? scorer.soloSection() : null;
    if (loading) return [heading, controls, h("div", { class: "card empty" }, "Loading your teams…"), tracked];
    if (!pool.length) {
      return [heading, controls, h("div", { class: "card empty" },
        h("p", null, "No stats for you yet."),
        h("p", { class: "small" }, "Your scorer links your account to your games in the Slow Pitch Book app (Teams → your team → Players → Link). ",
          `Games where you're listed as “${state.profile?.name || "your name"}” count too.`)), tracked];
    }
    if (!games.length) {
      return [heading, controls, h("div", { class: "card empty" },
        h("p", null, `No games for you in ${currentEventLabel() || "this season"}.`),
        h("p", { class: "small" }, "Tap the season at the top right to see another one, or All seasons.")), tracked];
    }

    const rateTile = (label, value) => h("div", { class: "card my-rate" }, h("b", null, rate(value)), h("span", null, label));
    const countTile = (label, value) => h("div", null, h("b", null, value), h("span", null, label));

    // Breakdown by season / tournament, or by year when no game has one.
    const seasonOf = events.length ? g => (g.event ? eventLabel({ name: g.event, kind: g.eventKind }) : "No season") : yearOf;
    // All my teams: each team's seasons on their own rows.
    const groupOf = all ? g => [g.isSolo ? "Tracked" : g.team, seasonOf(g)].filter(Boolean).join(" · ") : seasonOf;
    const groups = new Map();
    games.forEach((g, i) => { const k = groupOf(g); groups.set(k, [...(groups.get(k) || []), lines[i]]); });
    const breakdown = [...groups.entries()].map(([k, ls]) => sumLines(k, ls));
    if (breakdown.length > 1) breakdown.push(Object.assign(sumLines("Total", lines), { _total: true }));
    const columns = [{ key: "name", label: all ? "Team · Season" : events.length ? "Season" : "Year" }, { key: "g", label: "G", title: "Games" }, ...BATTING.slice(1)];

    const here = new Set(state.games.map(g => g.id));
    const logRows = games.map((g, i) => ({ ...derive(lines[i]), game: g }));
    const logColumns = [
      { key: "date", label: "Date", value: r => fmtDate(r.game.date) },
      { key: "name", label: "Game", value: r => {
        const text = [title(r.game), all ? r.game.team : ""].filter(Boolean).join(" · ");
        if (r.game.isSolo) return h("a", { href: `#/solo/${encodeURIComponent(r.game.id)}` }, `${text} (tracked)`);
        return here.has(r.game.id) ? h("a", { href: `#/game/${encodeURIComponent(r.game.id)}` }, text) : text;
      } },
      ...["ab", "r", "h", "b2", "b3", "hr", "rbi", "bb", "k"].map(k => BATTING.find(c => c.key === k)),
    ];

    const dots = [];
    for (const g of games) for (const s of g.spray || []) if (isMine(s)) dots.push(s);
    const label = [year, event ? (event === "none" ? "No season" : eventLabel(events.find(e => e.key === event))) : "", all ? "All my teams" : state.team?.name]
      .filter(Boolean).join(" · ");

    return [
      heading,
      controls,
      h("div", { class: "my-rates" },
        rateTile("AVG", total.avg), rateTile("OBP", total.obp), rateTile("SLG", total.slg), rateTile("OPS", total.ops)),
      games.length > 1 ? trendChart(games, lines) : null,
      h("div", { class: "card my-counts" },
        countTile("G", total.g), countTile("PA", total.pa), countTile("AB", total.ab), countTile("H", total.h),
        countTile("2B", total.b2), countTile("3B", total.b3), countTile("HR", total.hr), countTile("R", total.r),
        countTile("RBI", total.rbi), countTile("BB", total.bb), countTile("K", total.k), countTile("TB", total.tb)),
      h("h2", { class: "section" }, events.length ? "By Season & Tournament" : "By Year"),
      statsTable(columns, breakdown),
      h("h2", { class: "section" }, "Game Log"),
      statsTable(logColumns, logRows),
      ...myPitching(games),
      h("h2", { class: "section" }, "My Spray Chart"),
      dots.length ? sprayCard(state.profile?.name || "You", label, dots)
        : h("div", { class: "card empty" }, "None of your balls in play have a location yet."),
      h("div", { class: "legend" }, "AVG = H/AB · OBP = (H+BB)/(AB+BB+SF) · SLG = total bases/AB · OPS = OBP + SLG."),
      tracked,
    ];
  }

  // ---------- Render & refresh ----------

  function render() {
    if (!state.key) return homeView();
    if (state.themeDraft && route().name !== "team") { state.themeDraft = null; applyTheme(state.team?.theme || null); }
    const r = route();
    const y = window.scrollY;
    if (r.name === "score" && scorer?.fullScreen(r)) {
      app.replaceChildren(scorer.view(r));
      document.title = `Keep Score · ${state.team?.name || "Team"}`;
      return;
    }
    const views = { schedule: scheduleView, games: gamesView, stats: statsView, me: myStatsView, spray: sprayView, team: teamView };
    const content = r.name === "game" ? gameView(r.id) : r.name === "score" ? (scorer ? scorer.view(r) : gamesView())
      : r.name === "solo" ? (scorer ? scorer.soloGameView(r.id) : myStatsView()) : views[r.name]();
    app.replaceChildren(...shell(r.name === "game" || r.name === "score" ? "games" : r.name === "solo" ? "me" : r.name, content));
    document.querySelector(".tabs a.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    window.scrollTo(0, y);
    document.title = `${state.team?.name || "Team"} · Team Stats`;
  }

  async function refreshNow() {
    if (!state.key) return;
    try {
      const result = await load(state.key);
      if (result === false) return notMemberView();
    } catch (e) {
      state.flash = e.message;
    }
    render();
  }

  let timer = null;
  function startRefresh() {
    stopRefresh();
    if (DEMO) return;
    timer = setInterval(async () => {
      // Don't redraw under someone's fingers while they're filling in a form.
      if (document.visibilityState !== "visible" || !state.key || state.editing || route().name === "score") return;
      try {
        const result = await load(state.key);
        if (result === false) { stopRefresh(); return notMemberView(); }
        if (result === "changed") render();
      } catch { /* try again next time */ }
    }, REFRESH_MS);
  }
  function stopRefresh() { if (timer) clearInterval(timer); timer = null; }

  window.addEventListener("hashchange", () => { state.editing = null; render(); window.scrollTo(0, 0); });

  // ---------- Keeping score (scorer.js, on engine.js) ----------

  const scorer = window.StatScorer && window.StatEngine ? window.StatScorer({
    h, E: window.StatEngine, fs, DOCS, enc, fieldsOf, me, state, render, route, action, refreshNow, isManager, isLead, listDocs, saveLineup,
    Forbidden, fieldSVG, sprayCard, COLORS, ordinal, fmtDate, todayISO, DEMO, eventsOf, storage, statsTable, BATTING, derive, lineScore,
  }) : null;

  /// No connection when the page opened: show the games saved on this phone so scoring can carry on.
  function offlineStart() {
    const local = scorer ? scorer.recsForTeam(TEAM) : [];
    if (!TEAM || !local.length) return false;
    const rec = local[0];
    state.offline = true;
    state.key = TEAM;
    state.team = { name: rec.teamName, members: [me()], managers: [], scorers: [me()], editors: [] };
    state.members = rec.members || [];

    if (route().name !== "score") location.hash = "#/score";
    render();
    window.addEventListener("online", () => location.reload(), { once: true });
    return true;
  }

  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("sw.js").catch(() => { /* the site still works without it */ });
  }

  async function start() {
    // Open in the team's colors from last time while its data loads.
    if (TEAM && !DEMO) { try { applyTheme(JSON.parse(storage.get(`statbook.theme.${TEAM}`) || "null")); } catch { /* default colors */ } }
    if (!configured()) {
      return app.replaceChildren(panel(h("h1", null, "Team Stats"),
        h("p", null, "This site isn't set up yet: fill in public/config.js with your Firebase project ID and web API key.")));
    }
    try {
      // Coming back from the emailed sign-in link. Read from the address as it is now (not as the page opened):
      // once the link is used it's gone from there, so saving your name or finishing sign-in never tries it twice.
      const link = new URLSearchParams(location.search);
      if (!DEMO && link.get("mode") === "signIn" && link.get("oobCode")) {
        const code = link.get("oobCode");
        // Asked for from the home screen app (and opened here in Safari, as iPhones do).
        const handoff = standalone() ? null : link.get("handoff");
        history.replaceState(null, "", returnURL());
        const email = storage.get("statbook.pendingEmail");
        // Already signed in here as this person (the link was opened twice, or from another tab): carry on.
        // For the home screen app always use the link, so it gets the account the link was for.
        const someoneElse = email && session && email.toLowerCase() !== String(session.email || "").toLowerCase();
        if (handoff || someoneElse || !(await idToken())) {
          if (!email) return finishSignInView(code, "", handoff);
          try { await finishSignIn(email, code); } catch (e) { return signInView(e.message); }
        }
        if (handoff) return handoffDoneView(handoff);
      }
      if (!DEMO && !(await idToken())) {
        // The home screen app reopened while you were signing in over in Safari.
        if (handoffId() && await pickUpHandoff().catch(() => false)) return start();
        return handoffId() && standalone() ? waitForHandoffView(storage.get("statbook.pendingEmail")) : signInView();
      }

      app.replaceChildren(panel(h("p", null, "Loading…")));
      await loadProfile();
      if (!DEMO && !state.profile.name) return nameView();
      if (JOIN) return joinView();
      if (CLAIM) return claimView();
      if (!TEAM) return homeView();

      const ok = await load(TEAM);
      if (!ok) return notMemberView();
      if (!DEMO && !state.profile.teams[TEAM]) await addToMyTeams(TEAM, state.team.name);
      await scorer?.ready;
      render();
      startRefresh();
    } catch (e) {
      // Offline at the field: carry on with the games saved on this phone.
      if ((e instanceof TypeError || !navigator.onLine) && scorer) { await scorer.ready; if (offlineStart()) return; }
      app.replaceChildren(panel(h("h1", null, "Something went wrong"), h("p", null, e.message || "Couldn't reach the server."),
        h("button", { class: "btn", type: "button", onclick: () => location.reload() }, "Try Again")));
    }
  }

  start();
})();
