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
    schedule: [],         // [{ id, date, time, opponent, isHome, location, notes, availability }]
    members: [],          // [{ uid, name }]
    settings: null,       // { scorerCode, inviteCode } (managers)
    signature: "",
    updated: null,
    books: {},
    editing: null,        // schedule game being edited: id, "new", or null
    statsSort: { col: "avg", dir: -1 },
    statsTeam: "",
    sprayPlayer: "",
    sprayGame: "",
    event: storage.get("statbook.event") || "",
    gamePlayer: {},
    myScope: "",          // My Stats: "" = this team, "all" = every team you're on
    myAll: null,          // their games once loaded (or "loading")
    myYear: "",
    myEvent: "",
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

  /// The chosen filter, or "" if it no longer matches any game.
  function currentEvent() {
    if (!state.event) return "";
    if (state.event === "none") return state.games.some(g => !g.event) ? "none" : "";
    return state.games.some(g => eventKey(g) === state.event) ? state.event : "";
  }

  const inEvent = g => !currentEvent() || eventKey(g) === currentEvent();

  function currentEventLabel() {
    const key = currentEvent();
    if (!key) return "";
    if (key === "none") return "No season";
    const e = eventsOf(state.games).find(x => x.key === key);
    return e ? eventLabel(e) : "";
  }

  /// Season / tournament dropdown, or nothing when no game has one.
  function eventSelect() {
    const events = eventsOf(state.games);
    if (!events.length) return null;
    const key = currentEvent();
    const option = (value, text) => { const o = h("option", { value }, text); if (value === key) o.selected = true; return o; };
    const seasons = events.filter(e => e.kind !== "tournament");
    const tournaments = events.filter(e => e.kind === "tournament");
    return h("select", {
      class: "control", "aria-label": "Season or tournament",
      onchange: e => { state.event = e.target.value; storage.set("statbook.event", state.event || null); render(); },
    },
      option("", "All seasons & tournaments"),
      seasons.length ? h("optgroup", { label: "Seasons" }, seasons.map(e => option(e.key, e.name))) : null,
      tournaments.length ? h("optgroup", { label: "Tournaments" }, tournaments.map(e => option(e.key, e.name))) : null,
      state.games.some(g => !g.event) ? option("none", "No season") : null);
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

  /// Linked players show the name on their account now, so a rename never needs the app.
  function withMemberNames(games, members) {
    const names = new Map(members.map(m => [m.uid, m.name]));
    const named = x => (x.member && names.get(x.member) ? { ...x, name: names.get(x.member) } : x);
    return games.map(g => ({ ...g, lines: (g.lines || []).map(named), spray: (g.spray || []).map(named) }));
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
    for (const k of ["apiKey", "oobCode", "mode", "lang", "continueUrl", "tenantId"]) u.searchParams.delete(k);
    u.hash = "";
    return u.toString();
  }

  async function sendSignInLink(email) {
    await authCall("sendOobCode", { requestType: "EMAIL_SIGNIN", email, continueUrl: returnURL(), canHandleCodeInApp: true });
    storage.set("statbook.pendingEmail", email);
  }

  async function finishSignIn(email, oobCode) {
    const j = await authCall("signInWithEmailLink", { email, oobCode });
    saveSession({ uid: j.localId, email: j.email || email, idToken: j.idToken, refreshToken: j.refreshToken,
                  expires: Date.now() + Number(j.expiresIn || 3600) * 1000 });
    storage.set("statbook.pendingEmail", null);
    history.replaceState(null, "", returnURL());
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
  const isManager = () => DEMO || (state.team?.managers || []).includes(me());

  async function loadProfile() {
    if (DEMO) { state.profile = { name: "You", teams: {} }; return; }
    state.profile = (await getDoc(`users/${me()}`)) || { teams: {} };
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
    let team, games, schedule, members, settings = null;
    if (DEMO) {
      const d = await loadDemo();
      team = { name: d.board.name, members: d.members.map(m => m.uid), managers: ["demo-me"], editors: [] };
      games = d.games;
      schedule = state.schedule.length ? state.schedule : d.schedule.map(x => ({ ...x }));
      members = d.members;
      settings = { scorerCode: "DEMOCODE2026", inviteCode: "DEMOINVITE26" };
    } else {
      try { team = await getDoc(`teams/${teamId}`); } catch (e) { if (e instanceof Forbidden) return false; throw e; }
      if (!team) return false;
      [games, schedule, members] = await Promise.all([
        listDocs(`teams/${teamId}/games`).then(ds => ds.map(d => { try { return JSON.parse(d.json); } catch { return null; } }).filter(Boolean)),
        listDocs(`teams/${teamId}/schedule`),
        listDocs(`teams/${teamId}/members`).then(ds => ds.map(d => ({ uid: d.id, name: d.name }))),
      ]);
      if ((team.managers || []).includes(me())) settings = await getDoc(`teams/${teamId}/private/settings`).catch(() => null);
      // Keep "My teams" in step with the team's current name.
      if (state.profile.teams[teamId] !== team.name) addToMyTeams(teamId, team.name).catch(() => {});
    }
    games = withMemberNames(games, members);
    games.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    schedule.sort((a, b) => `${a.date} ${a.time || ""}`.localeCompare(`${b.date} ${b.time || ""}`));
    const signature = JSON.stringify([team, games, schedule, members, settings]);
    const changed = signature !== state.signature;
    Object.assign(state, { key: teamId, team, board: { name: team.name }, games, schedule, members, settings, signature, updated: new Date() });
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

  // Schedule & availability

  async function saveGame(id, game) {
    if (DEMO) {
      const i = state.schedule.findIndex(x => x.id === id);
      if (i >= 0) state.schedule[i] = { ...state.schedule[i], ...game };
      else state.schedule.push({ id: newCode(), ...game, availability: {} });
      return;
    }
    const fields = ["date", "time", "opponent", "isHome", "location", "notes", "updatedAt"];
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

  async function setRoles(members, managers) {
    if (DEMO) throw new Error("That isn't available in the demo.");
    await setDoc(`teams/${state.key}`, { name: state.team.name, members, managers, updatedAt: now() },
      { mask: ["name", "members", "managers", "updatedAt"], exists: true });
  }

  async function removeMember(uid) {
    if (DEMO) throw new Error("That isn't available in the demo.");
    await setRoles((state.team.members || []).filter(x => x !== uid), (state.team.managers || []).filter(x => x !== uid));
    await deleteDoc(`teams/${state.key}/members/${uid}`).catch(() => {});
  }

  async function renameTeam(name) {
    if (DEMO) throw new Error("That isn't available in the demo.");
    await setDoc(`teams/${state.key}`, { name, updatedAt: now() }, { mask: ["name", "updatedAt"], exists: true });
    if (state.settings?.inviteCode) {
      await setDoc(`invites/${state.settings.inviteCode}`, { teamName: name }, { mask: ["teamName"] }).catch(() => {});
    }
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
    await changeLists(state.key, { remove: { members: [me()], managers: [me()] } });
    await dropFromMyTeams(state.key);
  }

  /// Deletes the team and everything in it, for everyone.
  async function deleteTeam() {
    const t = state.key;
    for (const sub of ["schedule", "games", "books", "members"]) {
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
          app.replaceChildren(panel(
            h("h1", null, "Check your email"),
            h("p", null, `We sent a sign-in link to ${input.value.trim()}. Open it on this device to finish signing in. It may take a minute, and check spam if it doesn't show up.`),
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

  function finishSignInView(oobCode, message) {
    const input = h("input", { type: "email", placeholder: "you@email.com", autocomplete: "email", required: true, "aria-label": "Email" });
    const err = h("div", { class: "err", role: "alert" }, message || "");
    app.replaceChildren(panel(
      h("h1", null, "Finish signing in"),
      h("p", null, "Enter the email address the link was sent to."),
      h("form", {
        onsubmit: async e => {
          e.preventDefault();
          try { await finishSignIn(input.value.trim(), oobCode); start(); } catch (e2) { err.textContent = e2.message; }
        },
      }, input, h("button", { class: "btn", type: "submit" }, "Sign In"), err)));
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
          try { await saveName(name); start(); } catch (e2) { alert(e2.message); }
        },
      }, input, h("button", { class: "btn", type: "submit" }, "Continue"))));
    setTimeout(() => input.focus(), 50);
  }

  function homeView() {
    const teams = Object.entries(state.profile.teams || {}).sort((a, b) => a[1].localeCompare(b[1]));
    const code = h("input", { type: "text", placeholder: "ABCD-EFGH-JKLM", required: true, "aria-label": "Scorer code", autocapitalize: "characters" });
    app.replaceChildren(panel(
      h("h1", null, state.profile.name ? `Hi, ${state.profile.name.split(" ")[0]}` : "Your teams"),
      flashMessage(),
      teams.length
        ? [h("p", null, "Your teams"), h("div", { class: "team-list" }, teams.map(([id, name]) =>
            h("div", { class: "team-item" }, h("a", { href: `${SITE}?t=${id}` }, name || "Team"))))]
        : h("p", null, "You're not on a team yet. Ask your team's manager to send you the team's invite link, then open it to join."),
      // Teams start in the Slow Pitch Book app; its scorer code brings a team here and makes you its manager.
      h("details", { class: "fold" }, h("summary", null, "Scorers: add a team from the app"),
        h("p", { class: "or" }, "Teams are created in the Slow Pitch Book app. There, tap Teams → your team → Website & Scoring → Set Up Team on Website, or enter the team's scorer code here. You'll become the team's manager."),
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
      h("p", null, "You'll become this team's manager: you can invite teammates, add the schedule, and everyone you invite can see the stats your app publishes."),
      h("button", { class: "btn", type: "button", onclick: action(async () => {
        const id = await claimWithScorerCode(CLAIM);
        location.replace(`${SITE}?t=${id}#/team`);
      }, { after: () => {} }) }, "Become Manager"),
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
    const finals = state.games.filter(g => g.isFinal);
    const tab = (name, href, label) => h("a", { href, class: current === name ? "on" : null }, label);
    return [
      h("header", { class: "topbar" }, h("div", { class: "wrap" },
        h("div", { class: "brand" },
          h("img", { src: "apple-touch-icon.png", alt: "" }),
          h("div", null,
            h("h1", null, state.team?.name || "Team"),
            h("div", { class: "sub" }, `${state.members.length} player${state.members.length === 1 ? "" : "s"} · ${finals.length} game${finals.length === 1 ? "" : "s"} played`,
              DEMO ? " · " : "", DEMO ? h("span", { class: "pill demo" }, "Demo data") : null)),
          h("div", { class: "record" }, h("b", null, record(state.games)), h("span", { class: "sub" }, "Record"))),
        h("nav", { class: "tabs", "aria-label": "Sections" },
          tab("schedule", "#/", "Schedule"), tab("games", "#/games", "Games"), tab("stats", "#/stats", "Stats"),
          tab("me", "#/me", "My Stats"), tab("spray", "#/spray", "Spray"), tab("team", "#/team", "Team"),
          h("span", { class: "spacer" }),
          DEMO ? null : h("a", { class: "teams-link", href: SITE }, "My Teams")))),
      h("main", { class: "wrap" }, flashMessage(), content,
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
    const manager = isManager();
    return [
      h("h2", { class: "section" }, "Upcoming",
        manager && state.editing !== "new"
          ? h("button", { class: "btn small", type: "button", onclick: () => { state.editing = "new"; render(); } }, "+ Add Game")
          : null),
      state.editing === "new" ? gameForm(null) : null,
      upcoming.length
        ? upcoming.map(g => (state.editing === g.id ? gameForm(g) : scheduleCard(g, manager)))
        : (state.editing === "new" ? null : h("div", { class: "card empty" },
            manager ? "No games on the schedule yet. Tap Add Game to add the next one." : "No games on the schedule yet. Your manager adds them here.")),
      past.length ? h("details", { class: "fold past" },
        h("summary", null, `Past games (${past.length})`),
        past.slice(0, 20).map(g => (state.editing === g.id ? gameForm(g) : scheduleCard(g, manager, true)))) : null,
    ];
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
    const opp = g.opponent ? `${g.isHome ? "vs" : "@"} ${g.opponent}` : "Game";
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
          h("div", { class: "opp" }, opp),
          h("div", { class: "meta" }, [g.time ? fmtTime(g.time) : "Time TBD", g.isHome ? "Home" : "Away"].join(" · ")),
          g.location || typeof g.lat === "number" ? h("div", { class: "loc" },
            h("span", { class: "loc-name" }, "📍 ", g.location || "Pinned on the map"),
            h("span", { class: "loc-links" }, mapLinks(g).map(([label, href]) =>
              h("a", { class: "map-link", href, target: "_blank", rel: "noopener" }, label)))) : null,
          g.notes ? h("div", { class: "notes" }, g.notes) : null),
        manager ? h("div", { class: "sched-admin" },
          h("button", { class: "link-btn", type: "button", onclick: () => { state.editing = g.id; render(); } }, "Edit"),
          h("button", { class: "link-btn danger", type: "button", onclick: e => {
            if (confirm(`Delete ${opp} on ${fmtDate(g.date)}? Everyone's answers go with it.`)) action(() => deleteGame(g.id), { after: refreshNow })(e);
          } }, "Delete")) : null),
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
        who("No reply", noReply, "none")));
  }

  function gameForm(g) {
    const f = g || { date: todayISO(), time: "", opponent: "", isHome: false, location: "", notes: "" };
    const date = h("input", { type: "date", required: true, value: f.date, "aria-label": "Date" });
    const time = h("input", { type: "time", value: f.time || "", "aria-label": "Time" });
    const opponent = h("input", { type: "text", placeholder: "Opponent", maxlength: "80", value: f.opponent || "", "aria-label": "Opponent" });
    const side = h("select", { "aria-label": "Home or away" },
      h("option", { value: "away" }, "Away"), h("option", { value: "home" }, "Home"));
    side.value = f.isHome ? "home" : "away";
    const loc = h("input", { type: "text", placeholder: "Field / park", maxlength: "200", value: f.location || "", "aria-label": "Location" });
    const notes = h("textarea", { placeholder: "Notes (arrival time, jersey color…)", maxlength: "500", rows: "2", "aria-label": "Notes" }, f.notes || "");
    return h("form", {
      class: "card game-form",
      onsubmit: e => {
        e.preventDefault();
        action(async () => {
          await saveGame(g?.id, { date: date.value, time: time.value, opponent: opponent.value.trim(), isHome: side.value === "home",
                                  location: loc.value.trim(), notes: notes.value.trim() });
          state.editing = null;
        }, { after: refreshNow })(e);
      },
    },
      h("div", { class: "form-title" }, g ? "Edit game" : "Add a game"),
      h("div", { class: "row2" }, h("label", null, "Date", date), h("label", null, "Time", time)),
      h("div", { class: "row2" }, h("label", null, "Opponent", opponent), h("label", null, "Home or away", side)),
      h("label", null, "Location", loc),
      h("label", null, "Notes", notes),
      h("div", { class: "form-actions" },
        h("button", { class: "btn ghost", type: "button", onclick: () => { state.editing = null; render(); } }, "Cancel"),
        h("button", { class: "btn", type: "submit" }, g ? "Save" : "Add Game")));
  }

  function teamView() {
    const manager = isManager();
    const managers = new Set(state.team?.managers || []);
    const invite = state.settings?.inviteCode ? `${SITE}?join=${state.settings.inviteCode}` : "";
    const sorted = [...state.members].sort((a, b) => Number(managers.has(b.uid)) - Number(managers.has(a.uid)) || (a.name || "").localeCompare(b.name || ""));
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
          managers.has(m.uid) ? h("span", { class: "pill mgr" }, "Manager") : null,
          m.uid === me() ? h("span", { class: "you" }, "You") : null),
        manager && m.uid !== me() ? h("div", { class: "radmin" },
          h("button", { class: "link-btn", type: "button", onclick: action(() => setRoles(state.team.members,
            managers.has(m.uid) ? [...managers].filter(x => x !== m.uid) : [...managers, m.uid]), { after: refreshNow }) },
            managers.has(m.uid) ? "Remove manager" : "Make manager"),
          h("button", { class: "link-btn danger", type: "button", onclick: e => {
            if (confirm(`Remove ${m.name || "this player"} from ${state.team.name}?`)) action(() => removeMember(m.uid), { after: refreshNow })(e);
          } }, "Remove")) : null))),
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
            alert("You're the only manager. Make someone else a manager first, or delete the team.");
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
    const visitorsFirst = g.isHome ? [[them(g), g.them], [us(g), g.us]] : [[us(g), g.us], [them(g), g.them]];
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
          l.batter ? h("div", { class: "atbat" }, "At bat: ", h("b", null, l.batter)) : null),
        h("div", { class: "diamond" },
          h("div", { svg: diamondSVG(l) }),
          h("div", { class: "runners" },
            runners.length ? runners.map(([b, n]) => h("div", null, `${b}: ${n}`)) : "Bases empty"))));
  }

  function gamesView() {
    const live = state.games.filter(g => !g.isFinal);
    const row = g => h("a", { class: "game-row", href: `#/game/${encodeURIComponent(g.id)}` },
      h("span", { class: `badge ${g.isFinal ? (g.outcome || "T") : "LIVE"}` }, g.isFinal ? (g.outcome || "T") : "LIVE"),
      h("div", null,
        h("div", { class: "who" }, title(g)),
        h("div", { class: "when" }, [g.team, fmtDate(g.date)].filter(Boolean).join(" · "))),
      h("span", { class: "sc" }, `${g.us}–${g.them}`),
      h("span", { class: "chev", "aria-hidden": "true" }, "›"));
    const list = games => h("div", { class: "card games", style: "gap:0;overflow:hidden" },
      games.map((g, i) => [i ? h("div", { style: "height:1px;background:var(--line);margin-left:66px" }) : null, row(g)]));

    if (!state.games.length) {
      return [h("h2", { class: "section" }, "Games"),
        h("div", { class: "card empty" }, "No stats yet. Games kept in the Slow Pitch Book app show up here once the scorer links the app (Team tab).")];
    }
    // Live games first, then the rest grouped by season / tournament like the app (newest group first,
    // games with no season last). Without any seasons it's one plain list.
    const ordered = [...live, ...state.games.filter(g => g.isFinal)];
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
    const themRow = { name: them(g), runs: g.themByInning || [], r: g.them, h: "–" };
    const rows = g.isHome ? [themRow, usRow] : [usRow, themRow];
    return h("div", { class: "card scroll" }, h("table", { class: "stats line" },
      h("thead", null, h("tr", null, h("th", null, ""), innings.map(i => h("th", null, i)), h("th", { class: "r" }, "R"), h("th", null, "H"))),
      h("tbody", null, rows.map(r => h("tr", null,
        h("td", null, r.name),
        innings.map(i => h("td", null, r.runs[i - 1] ?? "")),
        h("td", { class: "r" }, r.r), h("td", null, r.h))))));
  }

  function gameView(id) {
    const g = state.games.find(x => x.id === id);
    if (!g) return [h("a", { class: "back", href: "#/games" }, "‹ All games"), h("div", { class: "card empty", style: "margin-top:12px" }, "That game isn't on the website anymore.")];
    if (g.isFinal) loadBook(g.id);

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
    return [
      h("a", { class: "back", href: "#/games" }, "‹ All games"),
      h("div", { class: "board game-head" },
        h("div", { class: "status" }, g.isFinal ? status : h("span", { class: "pill live" }, "Live")),
        h("div", { class: "teams" },
          h("div", null, h("div", { class: "tn" }, us(g)), h("div", { class: "big" }, g.us)),
          h("div", { class: "dash" }, "–"),
          h("div", null, h("div", { class: "tn" }, them(g)), h("div", { class: "big" }, g.them))),
        h("div", { class: "date" }, `${title(g)} · ${fmtDate(g.date)}`)),
      g.isFinal ? null : liveCard(g),
      h("h2", { class: "section" }, "Line Score"),
      lineScore(g),
      h("h2", { class: "section" }, "Batting"),
      lines.length ? statsTable(BATTING, totals ? [...lines, totals] : lines) : h("div", { class: "card empty" }, "No at-bats yet."),
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
      g.isFinal ? [
        h("h2", { class: "section" }, "Scorebook"),
        h("div", { class: "card book pad" },
          book && book.startsWith("data:")
            ? h("img", { src: book, alt: `Scorebook for ${title(g)} on ${fmtDate(g.date)}` })
            : h("div", { class: "note" }, book === "none" ? "The scorebook image isn't available for this game." : "Loading the scorebook…")),
      ] : null,
    ];
  }

  function statsView() {
    const teams = [...new Set(state.games.map(g => g.team).filter(Boolean))].sort();
    const team = teams.includes(state.statsTeam) ? state.statsTeam : "";
    const games = state.games.filter(g => (!team || g.team === team) && inEvent(g));
    const { col, dir } = state.statsSort;
    const rows = seasonLines(games).sort((a, b) => {
      if (col === "name") return a.name.localeCompare(b.name) * -dir;
      return (b[col] - a[col]) * -dir || b.ab - a.ab || a.name.localeCompare(b.name);
    });
    const total = rows.length ? derive(Object.fromEntries([["name", "Team"], ...FIELDS.map(f => [f, rows.reduce((s, r) => s + r[f], 0)])])) : null;
    if (total) { total._total = true; total.g = ""; }
    const columns = [BATTING[0], { key: "g", label: "G", title: "Games" }, ...BATTING.slice(1)];
    const finals = games.filter(g => g.isFinal).length;
    return [
      h("h2", { class: "section" }, currentEventLabel() || "Season Stats",
        h("span", { class: "rec" }, `${record(games)} · ${finals} game${finals === 1 ? "" : "s"}`)),
      h("div", { class: "controls" },
        eventSelect(),
        teams.length > 1
          ? h("select", { class: "control", "aria-label": "Team", onchange: e => { state.statsTeam = e.target.value; render(); } },
              h("option", { value: "" }, "All teams"),
              teams.map(t => { const o = h("option", { value: t }, t); if (t === team) o.selected = true; return o; }))
          : null),
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
    ];
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
        eventSelect(),
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

  /// Published games from every team you're on (for "All my teams").
  async function loadAllMyGames() {
    const ids = Object.keys(state.profile.teams || {});
    const lists = await Promise.all(ids.map(id => id === state.key ? state.games
      : listDocs(`teams/${id}/games`)
          .then(ds => ds.map(d => { try { return JSON.parse(d.json); } catch { return null; } }).filter(Boolean))
          .catch(() => [])));
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

  function myStatsView() {
    const teamCount = Object.keys(state.profile?.teams || {}).length;
    const all = state.myScope === "all" && teamCount > 1;
    if (all && state.myAll == null) {
      state.myAll = "loading";
      loadAllMyGames()
        .then(gs => { state.myAll = gs; })
        .catch(() => { state.myAll = null; state.myScope = ""; state.flash = "Couldn't load your other teams."; })
        .finally(() => { if (route().name === "me") render(); });
    }
    const loading = all && !Array.isArray(state.myAll);
    const source = all ? (loading ? [] : state.myAll) : state.games;
    const pool = source.filter(g => myLine(g))
      .sort((a, b) => (b.date || "").localeCompare(a.date || ""));

    const years = [...new Set(pool.map(yearOf).filter(Boolean))];
    const year = years.includes(state.myYear) ? state.myYear : "";
    const inYear = pool.filter(g => !year || yearOf(g) === year);
    const events = eventsOf(inYear);
    const event = state.myEvent === "none" ? (inYear.some(g => !g.event) ? "none" : "")
      : events.some(e => e.key === state.myEvent) ? state.myEvent : "";
    const games = inYear.filter(g => !event || eventKey(g) === event);
    const lines = games.map(myLine);
    const total = lines.length ? sumLines("Total", lines) : null;

    const option = (value, text, selected) => { const o = h("option", { value }, text); if (selected) o.selected = true; return o; };
    const pick = (key, value) => { state[key] = value; render(); };
    const controls = h("div", { class: "controls" },
      teamCount > 1 ? h("select", { class: "control", "aria-label": "Teams",
        onchange: e => { state.myScope = e.target.value; state.myAll = null; render(); } },
        option("", `${state.team?.name || "This team"} only`, !all), option("all", "All my teams", all)) : null,
      years.length > 1 ? h("select", { class: "control", "aria-label": "Year", onchange: e => pick("myYear", e.target.value) },
        option("", "All years", !year), years.map(y => option(y, y, y === year))) : null,
      events.length ? h("select", { class: "control", "aria-label": "Season or tournament", onchange: e => pick("myEvent", e.target.value) },
        option("", "All seasons & tournaments", !event),
        events.some(e => e.kind !== "tournament") ? h("optgroup", { label: "Seasons" },
          events.filter(e => e.kind !== "tournament").map(e => option(e.key, e.name, e.key === event))) : null,
        events.some(e => e.kind === "tournament") ? h("optgroup", { label: "Tournaments" },
          events.filter(e => e.kind === "tournament").map(e => option(e.key, e.name, e.key === event))) : null,
        inYear.some(g => !g.event) ? option("none", "No season", event === "none") : null) : null);

    const heading = h("h2", { class: "section" }, "My Stats",
      h("span", { class: "rec" }, [state.profile?.name, total ? `${total.g} game${total.g === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ")));
    if (loading) return [heading, controls, h("div", { class: "card empty" }, "Loading your teams…")];
    if (!pool.length) {
      return [heading, controls, h("div", { class: "card empty" },
        h("p", null, "No stats for you yet."),
        h("p", { class: "small" }, "Your scorer links your account to your games in the Slow Pitch Book app (Teams → your team → Players → Link). ",
          `Games where you're listed as “${state.profile?.name || "your name"}” count too.`))];
    }

    const rateTile = (label, value) => h("div", { class: "card my-rate" }, h("b", null, rate(value)), h("span", null, label));
    const countTile = (label, value) => h("div", null, h("b", null, value), h("span", null, label));

    // Breakdown by season / tournament, or by year when no game has one.
    const groupOf = events.length ? g => (g.event ? eventLabel({ name: g.event, kind: g.eventKind }) : "No season") : yearOf;
    const groups = new Map();
    games.forEach((g, i) => { const k = groupOf(g); groups.set(k, [...(groups.get(k) || []), lines[i]]); });
    const breakdown = [...groups.entries()].map(([k, ls]) => sumLines(k, ls));
    if (breakdown.length > 1) breakdown.push(Object.assign(sumLines("Total", lines), { _total: true }));
    const columns = [{ key: "name", label: events.length ? "Season" : "Year" }, { key: "g", label: "G", title: "Games" }, ...BATTING.slice(1)];

    const here = new Set(state.games.map(g => g.id));
    const logRows = games.map((g, i) => ({ ...derive(lines[i]), game: g }));
    const logColumns = [
      { key: "date", label: "Date", value: r => fmtDate(r.game.date) },
      { key: "name", label: "Game", value: r => {
        const text = [title(r.game), all ? r.game.team : ""].filter(Boolean).join(" · ");
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
      h("div", { class: "card my-counts" },
        countTile("G", total.g), countTile("PA", total.pa), countTile("AB", total.ab), countTile("H", total.h),
        countTile("2B", total.b2), countTile("3B", total.b3), countTile("HR", total.hr), countTile("R", total.r),
        countTile("RBI", total.rbi), countTile("BB", total.bb), countTile("K", total.k), countTile("TB", total.tb)),
      h("h2", { class: "section" }, events.length ? "By Season & Tournament" : "By Year"),
      statsTable(columns, breakdown),
      h("h2", { class: "section" }, "Game Log"),
      statsTable(logColumns, logRows),
      h("h2", { class: "section" }, "My Spray Chart"),
      dots.length ? sprayCard(state.profile?.name || "You", label, dots)
        : h("div", { class: "card empty" }, "None of your balls in play have a location yet."),
      h("div", { class: "legend" }, "AVG = H/AB · OBP = (H+BB)/(AB+BB+SF) · SLG = total bases/AB · OPS = OBP + SLG."),
    ];
  }

  // ---------- Render & refresh ----------

  function render() {
    if (!state.key) return homeView();
    const r = route();
    const y = window.scrollY;
    const views = { schedule: scheduleView, games: gamesView, stats: statsView, me: myStatsView, spray: sprayView, team: teamView };
    const content = r.name === "game" ? gameView(r.id) : views[r.name]();
    app.replaceChildren(...shell(r.name === "game" ? "games" : r.name, content));
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
      if (document.visibilityState !== "visible" || !state.key || state.editing) return;
      try {
        const result = await load(state.key);
        if (result === false) { stopRefresh(); return notMemberView(); }
        if (result === "changed") render();
      } catch { /* try again next time */ }
    }, REFRESH_MS);
  }
  function stopRefresh() { if (timer) clearInterval(timer); timer = null; }

  window.addEventListener("hashchange", () => { state.editing = null; render(); window.scrollTo(0, 0); });

  async function start() {
    if (!configured()) {
      return app.replaceChildren(panel(h("h1", null, "Team Stats"),
        h("p", null, "This site isn't set up yet: fill in public/config.js with your Firebase project ID and web API key.")));
    }
    try {
      // Coming back from the emailed sign-in link.
      if (!DEMO && params.get("mode") === "signIn" && params.get("oobCode")) {
        const email = storage.get("statbook.pendingEmail");
        if (!email) return finishSignInView(params.get("oobCode"));
        try { await finishSignIn(email, params.get("oobCode")); } catch (e) { history.replaceState(null, "", returnURL()); return signInView(e.message); }
      }
      if (!DEMO && !(await idToken())) return signInView();

      app.replaceChildren(panel(h("p", null, "Loading…")));
      await loadProfile();
      if (!DEMO && !state.profile.name) return nameView();
      if (JOIN) return joinView();
      if (CLAIM) return claimView();
      if (!TEAM) return homeView();

      const ok = await load(TEAM);
      if (!ok) return notMemberView();
      if (!DEMO && !state.profile.teams[TEAM]) await addToMyTeams(TEAM, state.team.name);
      render();
      startRefresh();
    } catch (e) {
      app.replaceChildren(panel(h("h1", null, "Something went wrong"), h("p", null, e.message || "Couldn't reach the server."),
        h("button", { class: "btn", type: "button", onclick: () => location.reload() }, "Try Again")));
    }
  }

  start();
})();
