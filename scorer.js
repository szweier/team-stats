// Keeping score on the website: the same scoring flow as the Slow Pitch Book app, built on engine.js.
//
// Nothing tapped is ever only in memory. Every change is saved to this phone (IndexedDB) first, as a new
// revision of the whole game; uploading happens afterwards and retries until it works:
//   teams/{t}/scoring/{game}            the latest revision, who is scoring it, and its revision number
//   teams/{t}/scoring/{game}/revs/{n}   every revision, written once and never changed
//   teams/{t}/games/{game}              what the Games / Stats / Spray pages show (same shape the app publishes)
// All three go up in one all-or-nothing request. The latest revision is only accepted if nobody else saved
// the game in between, so two phones can't overwrite each other: the second one is told and chooses.

window.StatScorer = function (ctx) {
  "use strict";
  const { h, E, fs, DOCS, enc, fieldsOf, me, state, render, fieldSVG, COLORS, ordinal, fmtDate, todayISO, DEMO,
    eventsOf, storage, statsTable, BATTING, derive, lineScore } = ctx;
  const { OUT, FIRST, SECOND, THIRD, HOME } = E;
  const SVG_NS = "http://www.w3.org/2000/svg";

  // ---------- Saved on this phone (IndexedDB) ----------

  let dbPromise = null;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        if (!window.indexedDB) return reject(new Error("This browser can't save games on this phone."));
        const req = indexedDB.open("statbook-scoring", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("games", { keyPath: "id" });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error("This browser can't save games on this phone."));
      });
      dbPromise.catch(() => { dbPromise = null; });
    }
    return dbPromise;
  }
  async function idb(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction("games", mode);
      const req = fn(tx.objectStore("games"));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Couldn't save on this phone."));
    });
  }
  const putRec = rec => idb("readwrite", st => st.put(rec));
  const getRec = id => idb("readonly", st => st.get(id));
  const allRecs = () => idb("readonly", st => st.getAll());

  /// Games this phone has (any team), by id. Filled at start and kept current.
  const recs = new Map();
  let loaded = false, storageError = null;
  async function loadRecs() {
    try {
      for (const r of await allRecs()) recs.set(r.id, r);
      loaded = true;
      // Ask the browser not to clear this site's storage (it otherwise may after a week unused).
      navigator.storage?.persist?.().catch(() => {});
    } catch (e) {
      storageError = e.message || "This browser can't save games on this phone.";
    }
  }
  const teamRecs = teamId => [...recs.values()].filter(r => r.teamId === teamId);

  /// Applies `fn` to a copy of the game; if it changes something, saves it here as a new revision before anything else.
  async function change(rec, fn) {
    const before = { game: rec.game, rev: rec.rev, pending: rec.pending, savedAt: rec.savedAt };
    const g = structuredClone(rec.game);
    if (fn(g) === false) return false;
    rec.game = g;
    rec.rev += 1;
    rec.pending = [...rec.pending, { rev: rec.rev, json: JSON.stringify(g), at: Date.now() }];
    rec.savedAt = Date.now();
    try {
      await putRec(rec);
    } catch (e) {
      Object.assign(rec, before);
      alert("Couldn't save that on this phone, so it wasn't recorded. " + (e?.message || ""));
      return false;
    }
    scheduleSync(rec);
    return true;
  }

  // ---------- Uploading ----------

  const encFields = data => Object.fromEntries(Object.entries(data).map(([k, v]) => [k, enc(v)]));
  const syncing = new Set();
  const timers = new Map();
  let online = navigator.onLine;

  function scheduleSync(rec, delay = 300) {
    if (DEMO) return;
    clearTimeout(timers.get(rec.id));
    timers.set(rec.id, setTimeout(() => syncRec(rec).then(repaint), delay));
  }

  const isConflict = e => /precondition|already exists|ALREADY_EXISTS|FAILED_PRECONDITION|base version/i.test(e?.message || "");

  async function syncRec(rec) {
    if (DEMO || !rec.pending.length || rec.conflict || syncing.has(rec.id)) return;
    syncing.add(rec.id);
    repaint();
    try {
      while (rec.pending.length) {
        const chunk = rec.pending.slice(0, 200);
        const last = chunk[chunk.length - 1];
        const g = JSON.parse(last.json);
        const base = `${DOCS}/teams/${rec.teamId}/scoring/${rec.id}`;
        const at = Math.floor(Date.now() / 1000);
        const writes = chunk.map(p => ({
          update: { name: `${base}/revs/${p.rev}`, fields: encFields({ json: p.json, rev: p.rev, by: me(), at: Math.floor(p.at / 1000) }) },
          currentDocument: { exists: false },
        }));
        writes.push({
          update: { name: base, fields: encFields({ json: last.json, rev: last.rev, scorer: me(), scorerName: state.profile?.name || "",
            team: rec.teamName, opponent: g.opponent, date: g.date, isFinal: !!g.isFinal, updatedAt: at }) },
          // Only if nobody else saved this game since we last did (or it's new).
          currentDocument: rec.updateTime ? { updateTime: rec.updateTime } : { exists: false },
        });
        writes.push({
          update: { name: `${DOCS}/teams/${rec.teamId}/games/${rec.id}`,
            fields: encFields({ json: JSON.stringify(E.publishedGame(g)), date: g.date, updatedAt: at }) },
        });
        const res = await fs("POST", `${DOCS}:commit`, { body: { writes } });
        rec.updateTime = res?.writeResults?.[chunk.length]?.updateTime || rec.updateTime;
        rec.syncedRev = last.rev;
        rec.pending = rec.pending.slice(chunk.length);
        rec.syncedAt = Date.now();
        rec.error = null;
        await putRec(rec);
      }
      online = true;
    } catch (e) {
      if (e instanceof ctx.Forbidden) {
        // Refused: usually because another phone saved a newer revision (only newer ones are accepted).
        // If so, that's a clash to choose from; otherwise this account really can't score here anymore.
        const remote = await readRemote(rec.teamId, rec.id).catch(() => null);
        if (remote && (remote.updateTime !== rec.updateTime || remote.rev >= (rec.pending[0]?.rev ?? Infinity))) rec.conflict = { at: Date.now(), remote };
        else rec.error = "This account isn't allowed to score for this team anymore. Ask a manager to make you a Scorer.";
      }
      else if (isConflict(e)) rec.conflict = { at: Date.now() };
      else if (e instanceof TypeError || !navigator.onLine) online = false;   // no connection: try again soon
      else rec.error = e.message || "Upload failed. It will try again.";
      await putRec(rec).catch(() => {});
    } finally {
      syncing.delete(rec.id);
    }
  }

  function syncAll() {
    if (DEMO) return;
    for (const r of recs.values()) if (r.pending.length && !r.conflict) syncRec(r).then(repaint);
  }
  setInterval(syncAll, 15000);
  window.addEventListener("online", () => { online = true; syncAll(); repaint(); });
  window.addEventListener("offline", () => { online = false; repaint(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") syncAll(); });
  window.addEventListener("beforeunload", e => {
    if ([...recs.values()].some(r => r.pending.length && !DEMO)) { e.preventDefault(); e.returnValue = ""; }
  });

  function syncText(rec) {
    if (DEMO) return { cls: "demo", text: "Demo · saved on this device only" };
    if (rec.conflict) return { cls: "bad", text: "Another phone saved this game" };
    if (rec.error) return { cls: "bad", text: "Not uploading" };
    if (syncing.has(rec.id)) return { cls: "busy", text: "Uploading…" };
    const n = rec.pending.length;
    if (!n) return { cls: "ok", text: "Saved & uploaded" };
    return { cls: "wait", text: `${online ? "Saved on this phone" : "Offline · saved on this phone"} · ${n} to upload` };
  }

  /// Reads the online copy: { game, rev, scorer, scorerName, updateTime } or null.
  async function readRemote(teamId, id) {
    const d = await fs("GET", `teams/${teamId}/scoring/${id}`);
    if (!d) return null;
    const f = fieldsOf(d);
    return { game: JSON.parse(f.json), rev: f.rev, scorer: f.scorer, scorerName: f.scorerName, updatedAt: f.updatedAt, updateTime: d.updateTime };
  }

  // ---------- Small UI helpers ----------

  let paintScheduled = false;
  function repaint() {
    if (paintScheduled) return;
    paintScheduled = true;
    requestAnimationFrame(() => { paintScheduled = false; if (ctx.route().name === "score") render(); });
  }
  const ui = { id: null, step: "main", spot: null, fielder: null, sheet: null, inningCheck: null, breakAfter: null, ending: false };
  function resetTap() { ui.step = "main"; ui.spot = null; ui.fielder = null; }
  const btn = (label, onclick, cls = "", attrs = {}) => h("button", { type: "button", class: `sbtn ${cls}`, onclick, ...attrs }, label);
  const rules = () => {
    try { return { ...E.DEFAULT_RULES, ...JSON.parse(storage.get("statbook.rules") || "{}") }; } catch { return E.DEFAULT_RULES; }
  };
  const members = rec => (rec.teamId === state.key && state.members.length ? state.members : rec.members || []);
  /// A typed name that matches a teammate's links to their account, like the app.
  function linkedPlayer(rec, name) {
    const n = name.trim();
    const list = rec ? members(rec) : state.members;
    const links = (rec && rec.teamId !== state.key ? rec.links : state.links) || [];
    const key = n.toLowerCase();
    const viaLink = links.find(l => l.name.trim().toLowerCase() === key);
    const m = list.find(x => (x.name || "").trim().toLowerCase() === key) || (viaLink && list.find(x => x.uid === viaLink.uid));
    return m ? { id: E.newID(), name: m.name, member: m.uid } : { id: E.newID(), name: n };
  }
  const usName = g => g.team || "Us", themName = g => g.opponent || "Them";
  const gameTitle = g => (g.opponent ? `${g.isHome ? "vs" : "@"} ${g.opponent}` : "Game");

  function sheet(titleText, body, { onClose, wide } = {}) {
    const close = () => { ui.sheet = null; onClose?.(); render(); };
    return h("div", { class: "sheet-backdrop", onclick: e => { if (e.target === e.currentTarget) close(); } },
      h("div", { class: `sheet${wide ? " wide" : ""}`, role: "dialog", "aria-label": titleText },
        h("div", { class: "sheet-head" }, h("b", null, titleText), h("button", { type: "button", class: "link-btn", onclick: close }, "Close")),
        h("div", { class: "sheet-body" }, body)));
  }

  // ---------- The field you tap ----------

  function svgEl(tag, attrs, text) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    if (text != null) el.textContent = text;
    return el;
  }
  const BASE_SPOT = { 1: [0.212, 0.212], 2: [0, 0.424], 3: [-0.212, 0.212] };

  /// The field: tap anywhere to place the ball, tap a runner for a courtesy runner.
  function tapField({ marker, runners = {}, onTap, onRunner, compact, shrink }) {
    // While picking what happened, the field gives up room so every choice stays on screen.
    const svg = svgEl("svg", { viewBox: "-80 -114 160 118", class: `field tap-field${compact ? " compact" : ""}${shrink ? " shrink" : ""}` });
    svg.innerHTML = fieldSVG([]);
    if (marker) {
      const x = E.pointX(marker) * 100, y = -E.pointY(marker) * 100;
      svg.append(svgEl("circle", { cx: x, cy: y, r: 3.4, fill: "#fff", stroke: "#111", "stroke-width": 0.8 }),
        svgEl("circle", { cx: x, cy: y, r: 1.4, fill: "#d91f26" }));
    }
    for (const [base, label] of Object.entries(runners)) {
      const [bx, by] = BASE_SPOT[base];
      const g = svgEl("g", { class: "runner", "data-base": base });
      const w = Math.min(46, 4 + label.length * 2.6);
      g.append(svgEl("rect", { x: bx * 100 - w / 2, y: -by * 100 - 11, width: w, height: 7, rx: 3.5, fill: "#111", "fill-opacity": 0.8 }),
        svgEl("text", { x: bx * 100, y: -by * 100 - 7.5, "font-size": 4, "text-anchor": "middle", "dominant-baseline": "central",
          fill: "#fff", "font-weight": 700, "font-family": "ui-rounded, system-ui, sans-serif" }, label.length > 16 ? label.slice(0, 15) + "…" : label),
        svgEl("circle", { cx: bx * 100, cy: -by * 100, r: 3, fill: "#d9f23a", stroke: "#111", "stroke-width": 0.6 }));
      svg.append(g);
    }
    svg.addEventListener("click", ev => {
      const runner = ev.target.closest?.("[data-base]");
      if (runner && onRunner) return onRunner(Number(runner.getAttribute("data-base")));
      if (!onTap) return;
      const pt = svg.createSVGPoint();
      pt.x = ev.clientX; pt.y = ev.clientY;
      const p = pt.matrixTransform(svg.getScreenCTM().inverse());
      const x = p.x / 100, y = -p.y / 100;
      if (y < -0.05) return;
      const fp = E.fromXY(x, y);
      if (Math.abs(fp.angle) > 72 || fp.distance > 1.2) return;
      onTap(fp);
    });
    return svg;
  }

  // ---------- Who can score ----------

  // Demo: add &keeper to the address to see what a Scorekeeper sees.
  const demoKeeper = () => DEMO && new URLSearchParams(location.search).has("keeper");
  /// Managers (and the app's scorers) set lineups and start any game; Scorekeepers only keep the book.
  const isManagerHere = () => (DEMO ? !demoKeeper() : ctx.isLead() || (state.team?.editors || []).includes(me()));
  const isScorerHere = () => DEMO || ctx.isLead() ||
    ((state.team?.scorers || []).includes(me()) && (state.team?.members || []).includes(me()));

  // ---------- Games tab: scoring list ----------

  let remoteList = null, remoteFor = null, remoteLoading = false;
  async function loadRemoteList(teamId) {
    if (DEMO || remoteLoading) return;
    remoteLoading = true;
    try {
      const rows = await ctx.listDocs(`teams/${teamId}/scoring`, ["scorer", "scorerName", "rev", "isFinal", "date", "opponent", "updatedAt"]
        .map(f => ["mask.fieldPaths", f]));
      remoteList = rows; remoteFor = teamId;
    } catch { remoteList = remoteList || []; }
    remoteLoading = false;
    repaint();
  }

  function listView() {
    const teamId = state.key;
    if (remoteFor !== teamId) { remoteList = null; loadRemoteList(teamId); remoteFor = teamId; }
    const mine = teamRecs(teamId).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    const mineIDs = new Set(mine.map(r => r.id));
    const others = (remoteList || []).filter(r => !mineIDs.has(r.id) && !r.isFinal);
    const row = (href, top, sub, badge) => h("a", { class: "game-row", href },
      badge, h("div", null, h("div", { class: "who" }, top), h("div", { class: "when" }, sub)),
      h("span", { class: "chev", "aria-hidden": "true" }, "›"));
    const can = isScorerHere(), manager = isManagerHere();
    // Scheduled games from the past week through today, ready to score once a manager sets the lineup.
    const today = todayISO();
    const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
    const started = new Set([...mineIDs, ...(remoteList || []).map(r => r.id)]);
    const scheduled = can ? state.schedule.filter(g => g.date <= today && g.date >= weekAgo).sort((a, b) => b.date.localeCompare(a.date)) : [];
    return [
      h("a", { class: "back", href: "#/games" }, "‹ Games"),
      h("h2", { class: "section" }, "Keep Score",
        manager ? h("a", { class: "btn small", href: "#/score/new" }, "+ New Game") : null),
      scheduled.length ? [h("h2", { class: "section" }, "Scheduled games"),
        h("div", { class: "card games", style: "gap:0;overflow:hidden" }, scheduled.map(sg => {
          const has = (sg.lineup || []).length;
          const label = `${sg.opponent ? `${sg.isHome ? "vs" : "@"} ${sg.opponent}` : "Game"}`;
          const sub = [fmtDate(sg.date), has ? `Lineup set (${sg.lineup.length})` : "No lineup yet"].join(" · ");
          if (started.has(sg.id)) return row(`#/score/${encodeURIComponent(sg.id)}`, label, sub + " · started", h("span", { class: "badge LIVE" }, "LIVE"));
          return h("div", { class: "game-row" }, h("span", { class: "badge T" }, "▶"),
            h("div", null, h("div", { class: "who" }, label), h("div", { class: "when" }, sub)),
            has ? h("button", { class: "btn small", type: "button", onclick: ctx.action(async () => {
              const id = await startFromSchedule(sg);
              if (id) location.hash = `#/score/${encodeURIComponent(id)}`;
            }, { after: () => {} }) }, "Start")
              : manager ? h("a", { class: "btn small ghost", href: "#/" }, "Set Lineup") : h("span", { class: "muted small" }, "Waiting for a manager"));
        }))] : null,
      storageError ? h("div", { class: "notice" }, `${storageError} Scoring on this browser is turned off so nothing gets lost; try Safari or Chrome, not a private window.`) : null,
      !can ? h("div", { class: "card empty" }, "Only admins, managers and scorekeepers can keep score. An admin can give you a role on the Team tab.") : null,
      mine.length ? [h("h2", { class: "section" }, "On this phone"),
        h("div", { class: "card games", style: "gap:0;overflow:hidden" }, mine.map(r => {
          const g = r.game, s = E.state(g), sync = syncText(r);
          return row(`#/score/${r.id}`, gameTitle(g),
            [g.isFinal ? `Final ${E.outcome(g) || ""} ${s.runs}–${E.opponentTotal(g)}` : `${ordinal(s.inning)} inning · ${s.runs}–${E.opponentTotal(g)}`, fmtDate(g.date)].join(" · "),
            h("span", { class: `sync-dot ${sync.cls}`, title: sync.text }));
        }))] : null,
      others.length ? [h("h2", { class: "section" }, "Being scored on another phone"),
        h("div", { class: "card games", style: "gap:0;overflow:hidden" }, others.map(r =>
          row(`#/score/${r.id}`, `@ ${r.opponent || "Game"}`, `${r.scorerName || "Someone"} · ${fmtDate(r.date)}`,
            h("span", { class: "badge LIVE" }, "LIVE"))))] : null,
      can && !mine.length && !others.length && !scheduled.length ? h("div", { class: "card empty" },
        manager ? "No games being scored. Tap New Game, or set a lineup on a scheduled game." : "Nothing to score yet. Once a manager sets the lineup on today's game, it shows here.") : null,
      h("div", { class: "legend" }, "Every tap is saved on this phone first, then uploaded. If you lose signal, keep scoring: it uploads when you're back online. Adding this site to your Home Screen keeps your saved games safest."),
    ];
  }

  // ---------- New game ----------

  const draftNew = { opponent: "", isHome: false, date: null, eventKind: "", eventName: "", lineup: null, write: "" };

  function newGameView() {
    if (!isManagerHere()) return listView();
    if (storageError) return listView();
    const team = state.team?.name || "";
    if (!draftNew.date) draftNew.date = todayISO();
    if (!draftNew.lineup) {
      // Start with the team's players, linked to their accounts.
      draftNew.lineup = [...state.members].sort((a, b) => (a.name || "").localeCompare(b.name || ""))
        .map(m => ({ id: E.newID(), name: m.name || "Player", member: m.uid, on: true }));
      const last = [...state.games].filter(g => g.isFinal).sort((a, b) => (b.date || "").localeCompare(a.date || ""))[0];
      if (last?.event && !draftNew.eventName) { draftNew.eventName = last.event; draftNew.eventKind = last.eventKind || "season"; }
    }
    const on = draftNew.lineup.filter(p => p.on);
    const events = eventsOf(state.games);
    const opp = h("input", { type: "text", placeholder: "Opponent", maxlength: "80", value: draftNew.opponent, "aria-label": "Opponent",
      oninput: e => { draftNew.opponent = e.target.value; } });
    return [
      h("a", { class: "back", href: "#/score" }, "‹ Keep Score"),
      h("div", { class: "card game-form" },
        h("div", { class: "form-title" }, "New Game"),
        h("div", { class: "row2" },
          h("label", null, "Date", h("input", { type: "date", value: draftNew.date, onchange: e => { draftNew.date = e.target.value; } })),
          h("label", null, "We're", (() => {
            const s = h("select", { onchange: e => { draftNew.isHome = e.target.value === "home"; } },
              h("option", { value: "away" }, "Away (bat first)"), h("option", { value: "home" }, "Home (bat second)"));
            s.value = draftNew.isHome ? "home" : "away";
            return s;
          })())),
        h("label", null, `${team} vs`, opp),
        h("div", { class: "row2" },
          h("label", null, "Season or tournament", (() => {
            const s = h("select", { onchange: e => {
              const v = e.target.value;
              if (v === "") { draftNew.eventKind = ""; draftNew.eventName = ""; }
              else if (v === "new-season" || v === "new-tournament") { draftNew.eventKind = v.slice(4); draftNew.eventName = ""; }
              else { const ev = events.find(x => x.key === v); draftNew.eventKind = ev.kind; draftNew.eventName = ev.name; }
              render();
            } }, h("option", { value: "" }, "None"),
              events.map(ev => h("option", { value: ev.key }, ev.kind === "tournament" ? `${ev.name} (Tournament)` : ev.name)),
              h("option", { value: "new-season" }, "New season…"), h("option", { value: "new-tournament" }, "New tournament…"));
            const match = events.find(ev => ev.kind === draftNew.eventKind && ev.name === draftNew.eventName);
            s.value = match ? match.key : draftNew.eventKind ? `new-${draftNew.eventKind}` : "";
            return s;
          })()),
          draftNew.eventKind && !events.some(ev => ev.kind === draftNew.eventKind && ev.name === draftNew.eventName)
            ? h("label", null, draftNew.eventKind === "tournament" ? "Tournament name" : "Season name",
              h("input", { type: "text", maxlength: "60", value: draftNew.eventName, placeholder: draftNew.eventKind === "tournament" ? "Labor Day Classic" : "Fall 2026",
                oninput: e => { draftNew.eventName = e.target.value; } }))
            : h("span"))),

      ...lineupBuilder(draftNew),
      h("div", { class: "legend" }, "Checked players bat in this order; use the arrows to set it. Teammates are linked to their accounts (●), so their stats follow them. Fill-ins can be added here or during the game."),
      h("div", { class: "form-actions" },
        h("a", { class: "btn ghost", href: "#/score" }, "Cancel"),
        h("button", { class: "btn", type: "button", disabled: !on.length || null, onclick: async e => {
          e.currentTarget.disabled = true;
          const id = await startGame();
          if (id) location.hash = `#/score/${id}`;
          else e.currentTarget.disabled = false;
        } }, "Start Game")),
    ];
  }

  // ---------- Batting order picker (New Game, and a manager setting a scheduled game's lineup) ----------

  /// d = { lineup: [{ id, name, member?, on }], write: "" }. Checked players bat in this order.
  function lineupBuilder(d) {
    const L = d.lineup;
    const on = L.filter(p => p.on);
    const move = (i, k) => { const j = i + k; if (j < 0 || j >= L.length) return; [L[i], L[j]] = [L[j], L[i]]; render(); };
    const pastGames = state.games.filter(g => (g.lines || []).length).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    const addWriteIn = () => {
      const n = d.write.trim();
      if (!n) return;
      const p = linkedPlayer(null, n);
      const existing = p.member && L.find(x => x.member === p.member);
      if (existing) existing.on = true; else L.push({ ...p, on: true });
      d.write = "";
      render();
    };
    const writeIn = h("input", { type: "text", placeholder: "Add a fill-in or late arrival", maxlength: "80", value: d.write,
      "aria-label": "Add a player", oninput: e => { d.write = e.target.value; },
      onkeydown: e => { if (e.key === "Enter") { e.preventDefault(); addWriteIn(); } } });
    return [
      h("h2", { class: "section" }, `Batting order (${on.length})`,
        pastGames.length ? (() => {
          const sel = h("select", { class: "control", "aria-label": "Use a lineup from another game", onchange: e => {
            const g = pastGames.find(x => x.id === e.target.value);
            if (!g) return;
            // The order players appear in that game (bench and courtesy runners come after the lineup).
            const used = new Set();
            const next = g.lines.filter(l => l.pa > 0 || l.r > 0).map(l => {
              const m = l.member ? state.members.find(x => x.uid === l.member) : null;
              used.add(l.member || l.name.toLowerCase());
              return { id: E.newID(), name: m ? m.name : l.name, member: m ? m.uid : undefined, on: true };
            });
            for (const p of L) if (!used.has(p.member || p.name.toLowerCase())) next.push({ ...p, on: false });
            d.lineup = next;
            render();
          } }, h("option", { value: "" }, "Use a lineup from…"),
            pastGames.slice(0, 20).map(g => h("option", { value: g.id }, `${fmtDate(g.date)} ${g.opponent ? (g.isHome ? "vs " : "@ ") + g.opponent : ""}`)));
          return sel;
        })() : null),
      h("div", { class: "card lineup-list" }, L.map((p, i) => h("div", { class: `lineup-row${p.on ? "" : " off"}` },
        h("label", { class: "lineup-check" },
          h("input", { type: "checkbox", checked: p.on || null, onchange: e => { p.on = e.target.checked; render(); } }),
          h("span", { class: "order" }, p.on ? String(on.indexOf(p) + 1) : "–"),
          h("span", null, p.name, p.member ? h("span", { class: "linked", title: "Linked to their account" }, " ●") : null,
            p.note ? h("span", { class: "muted small" }, ` ${p.note}`) : null)),
        h("span", { class: "row-tools" },
          h("button", { type: "button", class: "icon-btn", "aria-label": `Move ${p.name} up`, onclick: () => move(i, -1) }, "↑"),
          h("button", { type: "button", class: "icon-btn", "aria-label": `Move ${p.name} down`, onclick: () => move(i, 1) }, "↓"))))),
      h("div", { class: "pin-search" }, writeIn, h("button", { class: "btn small", type: "button", onclick: addWriteIn }, "Add")),
    ];
  }

  /// A manager's lineup for a scheduled game: what they saved before, or who said they're coming.
  const lineupDrafts = new Map();
  function scheduleLineupEditor(sg, onDone) {
    if (!lineupDrafts.has(sg.id)) {
      const answers = sg.availability || {};
      const status = uid => answers[uid]?.status;
      let lineup;
      if ((sg.lineup || []).length) {
        const used = new Set(sg.lineup.map(p => p.member).filter(Boolean));
        lineup = [...sg.lineup.map(p => ({ id: E.newID(), name: p.name, member: p.member || undefined, on: true })),
          ...state.members.filter(m => !used.has(m.uid)).map(m => ({ id: E.newID(), name: m.name, member: m.uid, on: false }))];
      } else {
        const anyIn = state.members.some(m => status(m.uid) === "in");
        const rank = m => ({ in: 0, maybe: 1 }[status(m.uid)] ?? 2);
        lineup = [...state.members].sort((a, b) => rank(a) - rank(b) || (a.name || "").localeCompare(b.name || ""))
          .map(m => ({ id: E.newID(), name: m.name, member: m.uid, on: anyIn ? status(m.uid) === "in" : status(m.uid) !== "out",
            note: status(m.uid) ? `(${status(m.uid)})` : "" }));
      }
      lineupDrafts.set(sg.id, { lineup, write: "" });
    }
    const d = lineupDrafts.get(sg.id);
    const on = d.lineup.filter(p => p.on);
    return h("div", { class: "card game-form lineup-editor" },
      h("div", { class: "form-title" }, `Lineup · ${sg.opponent ? `${sg.isHome ? "vs" : "@"} ${sg.opponent}` : "Game"} · ${fmtDate(sg.date)}`),
      ...lineupBuilder(d),
      h("div", { class: "legend" }, "Checked players bat in this order. Whoever keeps score starts the game with this lineup; they can make subs and add late arrivals during it."),
      h("div", { class: "form-actions" },
        h("button", { class: "btn ghost", type: "button", onclick: () => { lineupDrafts.delete(sg.id); onDone(null); } }, "Cancel"),
        h("button", { class: "btn", type: "button", disabled: !on.length || null, onclick: ctx.action(async () => {
          await ctx.saveLineup(sg.id, on.map(p => (p.member ? { name: p.name.trim(), member: p.member } : { name: p.name.trim() })));
          lineupDrafts.delete(sg.id);
          onDone(true);
        }, { after: () => {} }) }, "Save Lineup")));
  }

  /// Starts (or reopens) the web-scored game for a scheduled game, with the lineup a manager set.
  async function startFromSchedule(sg) {
    if (recs.has(sg.id) || (remoteList || []).some(r => r.id === sg.id)) return sg.id;
    if (!DEMO) {
      try { if (await readRemote(state.key, sg.id)) return sg.id; } catch { /* offline: start here */ }
    }
    const last = [...state.games].filter(g => g.isFinal && g.event).sort((a, b) => (b.date || "").localeCompare(a.date || ""))[0];
    const g = {
      id: sg.id, date: sg.date, team: state.team?.name || "", opponent: sg.opponent || "",
      lineup: (sg.lineup || []).map(p => (p.member ? { id: E.newID(), name: memberName(p.member) || p.name, member: p.member } : { id: E.newID(), name: p.name })),
      bench: [], subs: {}, extras: [], plays: [], courtesySwaps: [], opponentRuns: {},
      isFinal: false, isHome: !!sg.isHome, isSolo: false,
      event: last ? { kind: last.eventKind || "season", name: last.event } : null,
    };
    if (!g.lineup.length) return null;
    return createGame(g);
  }
  const memberName = uid => state.members.find(m => m.uid === uid)?.name;

  async function startGame() {
    const L = draftNew.lineup.filter(p => p.on);
    if (!L.length) return null;
    const eventName = draftNew.eventName.trim();
    const g = {
      id: E.newID(), date: draftNew.date || todayISO(), team: state.team?.name || "", opponent: draftNew.opponent.trim(),
      lineup: L.map(p => (p.member ? { id: p.id, name: p.name, member: p.member } : { id: p.id, name: p.name })),
      bench: [], subs: {}, extras: [], plays: [], courtesySwaps: [], opponentRuns: {},
      isFinal: false, isHome: draftNew.isHome, isSolo: false,
      event: draftNew.eventKind && eventName ? { kind: draftNew.eventKind, name: eventName } : null,
    };
    const id = await createGame(g);
    if (id) Object.assign(draftNew, { opponent: "", isHome: false, date: null, eventKind: "", eventName: "", lineup: null, write: "" });
    return id;
  }

  async function createGame(g) {
    const rec = { id: g.id, teamId: state.key, teamName: state.team?.name || "", members: state.members.map(m => ({ uid: m.uid, name: m.name })),
      links: state.links || [], game: g, rev: 0, syncedRev: 0, pending: [], updateTime: null, conflict: null, error: null,
      createdAt: Date.now(), savedAt: Date.now() };
    recs.set(rec.id, rec);
    const ok = await change(rec, () => true);   // revision 1: saved here, then uploaded
    if (!ok) { recs.delete(rec.id); return null; }
    Object.assign(ui, { id: rec.id, sheet: null, inningCheck: null, breakAfter: null });
    resetTap();
    return rec.id;
  }

  // ---------- Opening a game (here, online, or someone else's) ----------

  const opening = new Map();   // id → { remote, error }
  async function openRemote(teamId, id) {
    if (opening.has(id)) return;
    opening.set(id, { loading: true });
    try {
      const remote = await readRemote(teamId, id);
      opening.set(id, { remote });
    } catch (e) {
      opening.set(id, { error: e.message || "Couldn't load that game." });
    }
    repaint();
  }

  async function adoptRemote(teamId, remote) {
    const rec = { id: remote.game.id, teamId, teamName: state.team?.name || remote.game.team,
      members: state.members.map(m => ({ uid: m.uid, name: m.name })), game: remote.game, rev: remote.rev, syncedRev: remote.rev,
      pending: [], updateTime: remote.updateTime, conflict: null, error: null, createdAt: Date.now(), savedAt: Date.now() };
    recs.set(rec.id, rec);
    await putRec(rec);
    // Claim it: the next upload names this account as the scorer (the other phone is told it lost the game).
    await change(rec, () => true);
    opening.delete(rec.id);
    render();
  }

  /// Checks once per opening whether someone else saved this game since this phone did.
  const checked = new Set();
  async function checkRemote(rec) {
    if (DEMO || checked.has(rec.id) || !rec.updateTime) return;
    checked.add(rec.id);
    try {
      const remote = await readRemote(rec.teamId, rec.id);
      if (remote && remote.updateTime !== rec.updateTime && remote.rev > rec.syncedRev) {
        rec.conflict = { at: Date.now(), remote };
        await putRec(rec);
        repaint();
      }
    } catch { /* offline: carry on; the upload will notice */ }
  }

  async function resolveConflict(rec, keep) {
    const remote = rec.conflict?.remote || await readRemote(rec.teamId, rec.id);
    if (!remote) { rec.conflict = null; rec.updateTime = null; await putRec(rec); syncRec(rec).then(repaint); return; }
    // Either way nothing is lost: the other phone's version is already in the game's history online, and
    // this phone's goes in too (then the one picked goes on top of it as the latest).
    rec.backups = [...(rec.backups || []), { at: Date.now(), json: JSON.stringify(rec.game) }].slice(-5);
    const mine = { rev: remote.rev + 1, json: JSON.stringify(rec.game), at: Date.now() };
    if (keep === "mine") {
      rec.rev = mine.rev;
      rec.pending = [mine];
    } else {
      rec.game = remote.game;
      rec.rev = remote.rev + 2;
      rec.pending = [mine, { rev: rec.rev, json: JSON.stringify(remote.game), at: Date.now() }];
    }
    rec.syncedRev = remote.rev;
    rec.updateTime = remote.updateTime;
    rec.conflict = null;
    rec.error = null;
    await putRec(rec);
    syncRec(rec).then(repaint);
    render();
  }

  // ---------- Live scoring ----------

  let wakeLock = null;
  async function keepAwake() {
    try { if (!wakeLock && navigator.wakeLock && document.visibilityState === "visible") { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => { wakeLock = null; }); } } catch { /* not supported */ }
  }
  document.addEventListener("visibilitychange", () => { if (ctx.route().name === "score" && ctx.route().id && ctx.route().id !== "new") keepAwake(); });

  function scoreView(id) {
    const rec = recs.get(id);
    if (!rec) {
      if (!loaded && !storageError) return [h("div", { class: "card empty" }, "Loading…")];
      if (storageError) return [h("a", { class: "back", href: "#/score" }, "‹ Keep Score"), h("div", { class: "notice" }, storageError)];
      if (DEMO) return [h("a", { class: "back", href: "#/score" }, "‹ Keep Score"), h("div", { class: "card empty" }, "That game isn't on this device.")];
      const o = opening.get(id);
      if (!o) { openRemote(state.key, id); return [h("div", { class: "card empty" }, "Loading the game…")]; }
      if (o.loading) return [h("div", { class: "card empty" }, "Loading the game…")];
      if (o.error || !o.remote) return [h("a", { class: "back", href: "#/score" }, "‹ Keep Score"), h("div", { class: "card empty" }, o.error || "That game isn't being scored on the website.")];
      const r = o.remote;
      const mineOnline = r.scorer === me();
      return [
        h("a", { class: "back", href: "#/score" }, "‹ Keep Score"),
        h("div", { class: "card pad" },
          h("h2", { class: "section", style: "margin-top:0" }, `${gameTitle(r.game)} · ${fmtDate(r.game.date)}`),
          h("p", null, mineOnline
            ? "You were scoring this game on another phone or browser. Continue here? That copy will stop uploading."
            : `${r.scorerName || "Someone else"} is scoring this game. Take over? Their phone stops uploading and they'll be told; nothing they scored is lost.`),
          isScorerHere()
            ? h("div", { class: "form-actions start" },
              h("button", { class: "btn", type: "button", onclick: ctx.action(() => adoptRemote(state.key, r), { after: () => render() }) }, mineOnline ? "Continue Here" : "Take Over Scoring"),
              h("a", { class: "btn ghost", href: `#/game/${encodeURIComponent(id)}` }, "Just Watch"))
            : h("a", { class: "btn", href: `#/game/${encodeURIComponent(id)}` }, "Watch the Game")),
      ];
    }
    if (ui.id !== id) { Object.assign(ui, { id, sheet: null, inningCheck: null, breakAfter: null }); resetTap(); }
    checkRemote(rec);
    keepAwake();
    return liveView(rec);
  }

  function liveView(rec) {
    const g = rec.game;
    const s = E.state(g);
    const batter = g.lineup[s.batterIndex];
    const today = E.codes(g, batter.id);
    const review = s.needsReview.size;
    const sync = syncText(rec);
    const runners = Object.fromEntries(Object.entries(s.bases).map(([b, id]) =>
      [b, s.runFor[id] ? `${E.nameFor(g, id)} (CR)` : E.nameFor(g, id)]));
    const them = E.opponentTotal(g);
    const cells = [
      h("div", { class: "sb-cell" }, h("span", { class: "k" }, "Inning"),
        h("b", null, h("small", null, g.isHome ? "▼" : "▲"), String(s.inning))),
      h("div", { class: "sb-cell" }, h("span", { class: "k" }, "Outs"),
        h("span", { class: "outs" }, [0, 1, 2].map(i => h("i", { class: i < s.outs ? "on" : null })))),
    ];
    const usCell = h("div", { class: "sb-cell" }, h("span", { class: "k" }, "Us"), h("b", null, String(s.runs)));
    const themCell = h("button", { type: "button", class: "sb-cell tap", onclick: () => { ui.sheet = { type: "opponent" }; render(); } },
      h("span", { class: "k" }, "Them ✎"), h("b", null, String(them)));
    cells.push(...(g.isHome ? [themCell, usCell] : [usCell, themCell]));

    const next = [];
    for (let i = 1; i < Math.min(4, g.lineup.length); i++) next.push((s.batterIndex + i) % g.lineup.length);

    const body = g.isFinal ? finalView(rec, s) : [
      h("div", { class: "scoreboard" }, cells),
      h("div", { class: "batter" },
        h("div", { class: "k" }, `Now batting · #${s.batterIndex + 1}`),
        h("div", { class: "name" }, batter.name),
        h("div", { class: "today" }, today ? `Today: ${today}` : "First trip up")),
      next.length ? h("div", { class: "upnext" }, next.map((idx, i) => h("div", { class: "card" },
        h("span", { class: "k" }, ["On deck", "In the hole", "Then"][i]),
        h("span", null, h("i", null, String(idx + 1)), g.lineup[idx].name)))) : null,
      review ? h("button", { type: "button", class: "review-badge", onclick: () => { ui.sheet = { type: "box" }; render(); } },
        `⚠ ${review} play${review === 1 ? "" : "s"} need review`) : null,
      tapField({
        marker: ui.spot, runners, shrink: ui.step !== "main",
        onTap: p => {
          ui.spot = p;
          ui.fielder = E.suggestedFielder(p);
          ui.step = !E.isFair(p) ? "out" : E.isOverFence(p) ? "overFence" : "inPlay";
          render();
        },
        onRunner: base => { ui.sheet = { type: "courtesy", base }; render(); },
      }),
      h("div", { class: "hint" }, hint(s)),
      controls(rec, g, s),
      lastPlay(rec, g),
    ];

    return h("div", { class: "scorer" },
      h("header", { class: "scorer-bar" },
        h("a", { class: "link-btn", href: "#/score", "aria-label": "Back to Keep Score" }, "‹"),
        h("div", { class: "scorer-title" }, h("b", null, gameTitle(g)), h("span", { class: `sync ${sync.cls}`, onclick: () => { ui.sheet = { type: "sync" }; render(); } }, sync.text)),
        h("button", { type: "button", class: "link-btn", "aria-label": "Undo", disabled: (!g.plays.length && !(g.courtesySwaps || []).length) || null,
          onclick: () => undo(rec) }, "↶"),
        h("button", { type: "button", class: "link-btn", "aria-label": "More", onclick: () => { ui.sheet = { type: "menu" }; render(); } }, "•••")),
      rec.conflict ? conflictBanner(rec) : null,
      rec.error ? h("div", { class: "notice" }, rec.error) : null,
      h("div", { class: "scorer-body" }, body),
      ui.breakAfter != null && ui.breakAfter === s.inning - 1 && !g.isFinal ? inningBreak(rec, g, s, ui.breakAfter) : null,
      ui.inningCheck ? inningCheckDialog(rec) : null,
      ui.sheet ? sheetView(rec, g, s) : null);
  }

  function hint(s) {
    switch (ui.step) {
      case "main": return Object.keys(s.bases).length ? "Tap where the ball went · tap a runner for a courtesy runner" : "Tap where the ball went";
      case "inPlay": return "Hit or out? · tap the field to move the spot";
      case "overFence": return "Over the fence";
      case "hit": return "What kind of hit?";
      case "out": return "How was the out made?";
      case "strikeout": return "Strike three how?";
    }
    return "";
  }

  function controls(rec, g, s) {
    const choose = (result, outType = null, fielder = null) => choosePlay(rec, g, s, result, outType, fielder);
    const back = to => btn("Back", () => { ui.step = to; render(); }, "soft");
    const cancel = () => btn("Cancel", () => { resetTap(); render(); }, "soft");
    const grid = (...kids) => h("div", { class: "btn-grid" }, ...kids);
    switch (ui.step) {
      case "main":
        return grid(btn("Strikeout", () => { ui.spot = null; ui.step = "strikeout"; render(); }, "big kout"),
          btn("Walk", () => { ui.spot = null; choose("walk"); }, "big walk"));
      case "inPlay":
        return h("div", { class: "btn-stack" },
          grid(btn("Hit", () => { ui.step = "hit"; render(); }, "big hit"), btn("Out", () => { ui.step = "out"; render(); }, "big out")),
          grid(btn("Error", () => choose("reachedOnError"), "mid err"),
            btn("FC", () => choose("fieldersChoice"), "mid fc", { disabled: !Object.keys(s.bases).length || null, title: "Needs a runner on base" })),
          cancel());
      case "overFence":
        return h("div", { class: "btn-stack" },
          grid(btn("Home Run", () => choose("homeRun"), "big hit"), btn("HR Out", () => choose("homeRunOut"), "big special")), cancel());
      case "hit":
        return h("div", { class: "btn-stack" },
          grid(...["single", "double", "triple", "homeRun"].map(r => btn(E.buttonTitle(r), () => choose(r), "mid hit"))), back("inPlay"));
      case "strikeout":
        return h("div", { class: "btn-stack" },
          grid(...["strikeoutLooking", "strikeoutSwinging", "strikeoutFoul"].map(r => btn(E.buttonTitle(r), () => choose(r), "mid kout"))), back("main"));
      case "out": {
        const sacFly = s.bases[THIRD] != null && s.outs < 2;
        const fielder = h("select", { class: "control", "aria-label": "Fielder", onchange: e => { ui.fielder = e.target.value || null; } },
          h("option", { value: "" }, "Fielder: —"), E.FIELDER_ORDER.map(f => h("option", { value: f }, `Fielder: ${f}`)));
        fielder.value = ui.fielder || "";
        return h("div", { class: "btn-stack" }, fielder,
          grid(...E.OUT_TYPE_ORDER.map(t => btn(E.OUT_TYPES[t].title, () => choose("out", t, ui.fielder), "mid out"))),
          grid(btn("HR Out", () => choose("homeRunOut"), "mid special"),
            sacFly ? btn("Sac Fly", () => choose("sacrificeFly", "fly", ui.fielder), "mid special") : null),
          back("inPlay"));
      }
    }
    return null;
  }

  function choosePlay(rec, g, s, result, outType, fielder) {
    const batter = g.lineup[s.batterIndex];
    const draft = E.defaultPlay(g, result, s, batter.id, outType, fielder, ui.spot, rules());
    // Anything that could have gone more than one way asks "What happened?", pre-filled with the usual advance.
    if (E.asksWhatHappened(result, s, ui.spot ? E.isOverFence(ui.spot) : false)) {
      ui.sheet = { type: "happened", draft, o: E.Outcome.make(g, s, draft, rules()) };
      render();
    } else {
      commit(rec, draft);
    }
  }

  async function commit(rec, play) {
    const before = { inning: E.state(rec.game).inning, plays: structuredClone(rec.game.plays), swaps: structuredClone(rec.game.courtesySwaps || []) };
    resetTap();
    ui.sheet = null;
    const ok = await change(rec, g => { g.plays.push(play); });
    if (ok) {
      navigator.vibrate?.(15);
      if (E.state(rec.game).inning > before.inning) ui.inningCheck = before;
    }
    render();
  }

  async function undo(rec) {
    resetTap();
    await change(rec, g => E.undo(g));
    if (ui.breakAfter != null && E.state(rec.game).inning <= ui.breakAfter) ui.breakAfter = null;
    render();
  }

  function lastPlay(rec, g) {
    const last = g.plays[g.plays.length - 1];
    if (!last) return null;
    const runners = E.runnerSummary(g, last);
    return h("div", { class: "card last-play" },
      h("div", null, h("b", null, E.describe(g, last)), runners ? h("div", { class: "muted small" }, runners) : null),
      btn("Edit", () => { openEdit(rec, g.plays.length - 1); }, "soft small"));
  }

  function conflictBanner(rec) {
    return h("div", { class: "notice conflict" },
      h("b", null, "This game was also saved from another phone."),
      h("p", null, "Pick which version to keep scoring. The other one isn't thrown away: it stays in the game's history."),
      h("div", { class: "form-actions start" },
        h("button", { class: "btn small", type: "button", onclick: ctx.action(() => resolveConflict(rec, "mine"), { after: () => render() }) }, "Keep This Phone's"),
        h("button", { class: "btn small ghost", type: "button", onclick: ctx.action(() => resolveConflict(rec, "theirs"), { after: () => render() }) }, "Use the Other One")));
  }

  function inningCheckDialog(rec) {
    const check = ui.inningCheck;
    return h("div", { class: "sheet-backdrop center" }, h("div", { class: "sheet dialog" },
      h("b", null, `End of the ${ordinal(check.inning)}?`), h("p", null, "That's 3 outs."),
      btn("Inning Over", () => { ui.breakAfter = check.inning; ui.inningCheck = null; render(); }, "big hit"),
      btn("Not Yet – Undo Last Play", async () => {
        ui.inningCheck = null;
        await change(rec, g => { g.plays = check.plays; g.courtesySwaps = check.swaps; });
        render();
      }, "soft")));
  }

  function scorePair(g, s) {
    const ours = [usName(g), s.runs], theirs = [themName(g), E.opponentTotal(g)];
    const [l, r] = g.isHome ? [theirs, ours] : [ours, theirs];   // visitors on the left, home team on the right
    const side = ([n, v]) => h("div", null, h("div", { class: "tn" }, n), h("div", { class: "big" }, String(v)));
    return h("div", { class: "teams" }, side(l), h("div", { class: "dash" }, "–"), side(r));
  }

  function inningBreak(rec, g, s, ended) {
    const due = [];
    for (let i = 0; i < Math.min(4, g.lineup.length); i++) due.push((s.batterIndex + i) % g.lineup.length);
    const runs = s.runsByInning[ended] || 0;
    return h("div", { class: "inning-break" }, h("div", { class: "ib-inner" },
      h("div", { class: "board game-head" },
        h("div", { class: "status" }, `End of ${ended}`), scorePair(g, s),
        h("div", { class: "date" }, `${runs} run${runs === 1 ? "" : "s"} that inning`)),
      h("div", { class: "card pad" },
        h("div", { class: "k" }, `Due up in the ${ordinal(ended + 1)}`),
        due.map((idx, i) => h("div", { class: "due-row" },
          h("i", { class: i === 0 ? "lead" : null }, String(idx + 1)),
          h("div", null, h("b", null, g.lineup[idx].name), E.codes(g, g.lineup[idx].id) ? h("div", { class: "muted small" }, E.codes(g, g.lineup[idx].id)) : null),
          i === 0 ? h("span", { class: "lead-tag" }, "Leading off") : null))),
      btn("Start Hitting", () => { ui.breakAfter = null; render(); }, "big hit"),
      btn("End Game", () => { ui.breakAfter = null; ui.sheet = { type: "end" }; render(); }, "soft danger")));
  }

  function finalView(rec, s) {
    const g = rec.game;
    const uploaded = !rec.pending.length && !DEMO;
    return [
      h("div", { class: "board game-head" }, h("div", { class: "status" }, `Final · ${{ W: "Win", L: "Loss", T: "Tie" }[E.outcome(g)] || ""}`), scorePair(g, s)),
      h("div", { class: "card pad" },
        h("p", { style: "margin-top:0" }, uploaded ? "This game is saved and on the website." : DEMO ? "Demo games stay on this device." : "Saved on this phone. It uploads as soon as there's a connection; keep this page open until it says Saved & uploaded."),
        h("div", { class: "form-actions start" },
          uploaded ? h("a", { class: "btn", href: `#/game/${encodeURIComponent(g.id)}`, onclick: () => ctx.refreshNow() }, "View Game") : null,
          btn("Box Score & Plays", () => { ui.sheet = { type: "box" }; render(); }, "soft"),
          btn("Reopen Game", async () => { await change(rec, x => { x.isFinal = false; }); render(); }, "soft"))),
    ];
  }

  // ---------- Sheets ----------

  function sheetView(rec, g, s) {
    const sh = ui.sheet;
    switch (sh.type) {
      case "happened": return happenedSheet(rec, g, s, sh);
      case "edit": return editSheet(rec, g, sh);
      case "courtesy": return courtesySheet(rec, g, s, sh.base);
      case "opponent": return opponentSheet(rec, g, s);
      case "menu": return menuSheet(rec, g);
      case "box": return boxSheet(rec, g);
      case "lineup": return lineupSheet(rec, g, sh);
      case "details": return detailsSheet(rec, g, sh);
      case "rules": return rulesSheet();
      case "end": return endSheet(rec, g);
      case "sync": return syncSheet(rec);
    }
    return null;
  }

  /// Out / 1st / 2nd / 3rd / Score for the batter and each runner, then outs, runs and RBIs.
  function outcomeRows(o) {
    const rule = E.Outcome.runRule(o);
    const problem = E.Outcome.problem(o);
    return h("div", { class: "outcome" },
      o.slots.map(sl => {
        const allowed = E.Outcome.options(o, sl);
        const current = E.Outcome.to(o, sl);
        const moot = E.Outcome.inningOver(o) && current !== OUT && current !== HOME;
        return h("div", { class: `oc-row${moot ? " moot" : ""}` },
          h("div", { class: "oc-name" }, h("b", null, sl.name), h("span", null, sl.start === 0 ? "batter" : `on ${E.BASE_LABEL[sl.start]}`),
            sl.forName ? h("span", null, `CR for ${sl.forName}`) : null),
          h("div", { class: "chips" }, E.BASES.map(b => h("button", {
            type: "button", class: `chip ${b === OUT ? "out" : b === HOME ? "score" : "base"}${current === b ? " on" : ""}`,
            disabled: !allowed.includes(b) || null,
            onclick: () => { E.Outcome.set(o, sl, b); render(); },
          }, b === sl.start && sl.start > 0 ? "Stay" : E.BASE_LABEL[b]))));
      }),
      h("div", { class: "card oc-sum" },
        h("div", { class: "oc-line" }, h("b", null, E.Outcome.summary(o)),
          h("span", { class: "stepper" },
            h("button", { type: "button", "aria-label": "One less RBI", onclick: () => { o.rbiOffset = Math.max(0, E.Outcome.rbi(o) - 1) - E.Outcome.autoRBI(o); render(); } }, "−"),
            h("span", null, `RBI ${E.Outcome.rbi(o)}`),
            h("button", { type: "button", "aria-label": "One more RBI", onclick: () => { o.rbiOffset = Math.min(4, E.Outcome.rbi(o) + 1) - E.Outcome.autoRBI(o); render(); } }, "+"))),
        rule.kind === "noRuns" ? h("div", { class: "muted small" }, `No runs count: ${rule.why}.`) : null,
        rule.kind === "timePlay" ? h("label", { class: "toggle" },
          h("input", { type: "checkbox", checked: o.runsBeatTheOut || null, onchange: e => { o.runsBeatTheOut = e.target.checked; render(); } }),
          "Runs crossed before the 3rd out") : null,
        problem ? h("div", { class: "problem" }, `⚠ ${problem}`) : null));
  }

  function happenedSheet(rec, g, s, sh) {
    const o = sh.o;
    return sheet("What happened?", [
      h("div", { class: "oc-head" }, h("b", null, E.detailTitle(sh.draft)), h("span", { class: "muted" }, `${s.outs} out${s.outs === 1 ? "" : "s"} before`)),
      outcomeRows(o),
      btn("Save Play", () => commit(rec, E.Outcome.apply(o, sh.draft)), "big save", { disabled: E.Outcome.problem(o) != null || null }),
    ], { onClose: () => {} });
  }

  // Edit any earlier play: result, where the ball went, and where everyone ended up.
  function openEdit(rec, index) {
    const g = rec.game;
    const existing = g.plays[index];
    const st = E.state(g, index);
    const batter = E.player(g, existing.batterID) || g.lineup[st.batterIndex];
    const o = E.Outcome.make(g, st, existing, rules());
    o.rbiOffset = existing.rbi - E.Outcome.autoRBI(o);   // keep any RBI tweak made when it was recorded
    ui.sheet = { type: "edit", index, st, batter, existing, result: existing.result, outType: existing.outType ?? null,
      fielder: existing.fielder ?? null, location: existing.location ?? null, o, confirmDelete: false };
    render();
  }

  function editSheet(rec, g, sh) {
    const hasBall = !["walk", "strikeoutLooking", "strikeoutSwinging", "strikeoutFoul"].includes(sh.result);
    const hasOutDetail = sh.result === "out" || sh.result === "sacrificeFly";
    const resetOutcome = () => {
      if (sh.result === "sacrificeFly") sh.outType = "fly";
      if (sh.result !== "out" && sh.result !== "sacrificeFly") { sh.outType = null; sh.fielder = null; }
      // A different result starts everyone over at its usual advance.
      const draft = E.defaultPlay(g, sh.result, sh.st, sh.batter.id, sh.outType, sh.fielder, sh.location, rules());
      sh.o = E.Outcome.make(g, sh.st, draft, rules());
    };
    const result = h("select", { class: "control", "aria-label": "Result", onchange: e => { sh.result = e.target.value; resetOutcome(); render(); } },
      E.RESULT_ORDER.map(r => h("option", { value: r }, E.resultTitle(r))));
    result.value = sh.result;
    const outType = h("select", { class: "control", "aria-label": "Out type", onchange: e => { sh.outType = e.target.value || null; sh.o.outType = sh.outType; render(); } },
      h("option", { value: "" }, "Type: —"), E.OUT_TYPE_ORDER.map(t => h("option", { value: t }, `Type: ${E.OUT_TYPES[t].title}`)));
    outType.value = sh.outType || "";
    const fielder = h("select", { class: "control", "aria-label": "Fielder", onchange: e => { sh.fielder = e.target.value || null; } },
      h("option", { value: "" }, "Fielder: —"), E.FIELDER_ORDER.map(f => h("option", { value: f }, `Fielder: ${f}`)));
    fielder.value = sh.fielder || "";
    const save = async () => {
      if (E.Outcome.problem(sh.o)) return;
      const play = { id: sh.existing.id, inning: sh.st.inning, batterID: sh.batter.id, result: sh.result, batterTo: sh.existing.batterTo,
        runners: [], rbi: 0, endsInning: !!sh.existing.endsInning,
        outType: hasOutDetail ? (sh.result === "sacrificeFly" ? "fly" : sh.outType) : null,
        fielder: hasOutDetail ? sh.fielder : null, location: hasBall ? sh.location : null };
      const saved = E.Outcome.apply(sh.o, play);
      ui.sheet = null;
      await change(rec, x => { if (sh.index >= x.plays.length) return false; x.plays[sh.index] = saved; E.renumberInnings(x); });
      render();
    };
    return sheet("Edit Play", [
      h("div", { class: "oc-head" }, h("b", null, `${sh.batter.name} · Inning ${sh.st.inning} · ${sh.st.outs} out${sh.st.outs === 1 ? "" : "s"}`)),
      result,
      hasBall ? [h("div", { class: "k" }, "Where the ball went"),
        tapField({ marker: sh.location, compact: true, onTap: p => {
          // Moving the spot updates a suggested fielder unless a different one was picked.
          if (hasOutDetail && (!sh.fielder || (sh.location && sh.fielder === E.suggestedFielder(sh.location)))) sh.fielder = E.suggestedFielder(p);
          sh.location = p; render();
        } }),
        sh.location ? btn("Clear Location", () => { sh.location = null; render(); }, "soft small") : h("div", { class: "muted small" }, "Tap the field to place the ball for the spray chart.")] : null,
      hasOutDetail ? h("div", { class: "row2" }, sh.result === "out" ? outType : h("span"), fielder) : null,
      h("div", { class: "k" }, "Where did everyone end up?"),
      outcomeRows(sh.o),
      btn("Save Play", save, "big save", { disabled: E.Outcome.problem(sh.o) != null || null }),
      sh.confirmDelete
        ? h("div", { class: "card pad" }, h("p", { style: "margin-top:0" }, "Delete this play? Plays after it stay put; any that no longer fit are flagged for review."),
          h("div", { class: "form-actions start" },
            btn("Delete", async () => { ui.sheet = null; await change(rec, x => E.deletePlay(x, sh.index)); render(); }, "soft danger"),
            btn("Keep It", () => { sh.confirmDelete = false; render(); }, "soft")))
        : btn("Delete This Play", () => { sh.confirmDelete = true; render(); }, "soft danger"),
    ]);
  }

  function courtesySheet(rec, g, s, base) {
    const current = s.bases[base];
    if (!current) { ui.sheet = null; return null; }
    const runningFor = s.runFor[current] ?? current;
    const onBase = new Set(Object.values(s.bases));
    const batterID = g.lineup[s.batterIndex].id;
    const inGame = [...g.lineup, ...(g.extras || [])].filter(p => !onBase.has(p.id) && p.id !== batterID);
    const inGameMembers = new Set(E.allPlayers(g).map(p => p.member).filter(Boolean));
    const teammates = members(rec).filter(m => !inGameMembers.has(m.uid));
    const pick = async runner => { ui.sheet = null; await change(rec, x => E.addCourtesyRunner(x, runner, base)); render(); };
    let typed = "";
    return sheet("Courtesy Runner", [
      h("p", null, "Running for ", h("b", null, E.nameFor(g, runningFor)), ` on ${E.BASE_LABEL[base]}. If they score, ${E.nameFor(g, runningFor)} gets the run (R) and the courtesy runner gets a CRR.`),
      h("div", { class: "k" }, "In this game"),
      h("div", { class: "pick-list" }, inGame.map(p => btn(p.name, () => pick(p), "soft"))),
      teammates.length ? [h("div", { class: "k" }, "Other teammates"),
        h("div", { class: "pick-list" }, teammates.map(m => btn(m.name, () => pick({ id: E.newID(), name: m.name, member: m.uid }), "soft")))] : null,
      h("div", { class: "k" }, "Someone else"),
      h("div", { class: "pin-search" },
        h("input", { type: "text", placeholder: "Name", maxlength: "80", oninput: e => { typed = e.target.value; },
          onkeydown: e => { if (e.key === "Enter" && typed.trim()) pick(linkedPlayer(rec, typed)); } }),
        btn("Use", () => { if (typed.trim()) pick(linkedPlayer(rec, typed)); }, "soft")),
    ]);
  }

  function opponentSheet(rec, g, s) {
    const lastPlay = g.plays.length ? g.plays[g.plays.length - 1].inning : 1;
    const last = Math.max(s.inning, lastPlay, ...Object.keys(g.opponentRuns || {}).map(Number), 1);
    const setRuns = (i, v) => change(rec, x => {
      const n = Math.max(0, Math.min(99, v));
      if ((x.opponentRuns[i] || 0) === n) return false;
      if (n) x.opponentRuns[i] = n; else delete x.opponentRuns[i];
    }).then(render);
    return sheet(g.opponent ? `${g.opponent} Runs` : "Opponent Runs", [
      ...Array.from({ length: last }, (_, k) => last - k).map(i => h("div", { class: "opp-row" },
        h("span", null, `Inning ${i}`),
        h("span", { class: "stepper" },
          h("button", { type: "button", "aria-label": `One less run in inning ${i}`, onclick: () => setRuns(i, (g.opponentRuns[i] || 0) - 1) }, "−"),
          h("b", null, String(g.opponentRuns[i] || 0)),
          h("button", { type: "button", "aria-label": `One more run in inning ${i}`, onclick: () => setRuns(i, (g.opponentRuns[i] || 0) + 1) }, "+")))),
      h("div", { class: "muted" }, `Total: ${E.opponentTotal(g)}`),
    ]);
  }

  function menuSheet(rec, g) {
    const go = type => () => { ui.sheet = { type }; render(); };
    return sheet("Game", h("div", { class: "menu-list" },
      btn("Box Score & Edit Plays", go("box"), "menu-item"),
      btn("Lineup & Subs", () => { ui.sheet = { type: "lineup", work: null }; render(); }, "menu-item"),
      btn("Opponent Runs", go("opponent"), "menu-item"),
      btn("Date, Opponent & Season", () => { ui.sheet = { type: "details", work: null }; render(); }, "menu-item"),
      btn("Runner Defaults", go("rules"), "menu-item"),
      btn("End Inning (run limit)", async () => {
        const inning = E.state(rec.game).inning;
        ui.sheet = null;
        await change(rec, x => E.endInning(x));
        if (E.state(rec.game).inning > inning) ui.breakAfter = inning;
        render();
      }, "menu-item", { disabled: !E.canEndInning(g) || null }),
      btn(g.isFinal ? "Reopen Game" : "End Game", g.isFinal ? async () => { ui.sheet = null; await change(rec, x => { x.isFinal = false; }); render(); } : go("end"), "menu-item danger")));
  }

  function endSheet(rec, g) {
    return sheet("End this game?", [
      h("p", null, "Make sure the opponent's runs are entered. You can reopen the game later."),
      h("p", { class: "muted" }, `${usName(g)} ${E.state(g).runs} – ${themName(g)} ${E.opponentTotal(g)}`),
      btn("End Game", async () => { ui.sheet = null; ui.breakAfter = null; await change(rec, x => { x.isFinal = true; }); render(); }, "big danger-solid"),
      btn("Opponent Runs", () => { ui.sheet = { type: "opponent" }; render(); }, "soft"),
    ]);
  }

  function boxSheet(rec, g) {
    const s = E.state(g);
    const lines = E.statLines(g).filter(l => l.pa > 0 || l.runs > 0 || l.courtesyRuns > 0)
      .map(l => derive(ctxLine(l)));
    const byInning = new Map();
    g.plays.forEach((p, i) => byInning.set(p.inning, [...(byInning.get(p.inning) || []), [p, i]]));
    return sheet("Box Score & Plays", [
      h("div", { class: "board game-head" }, scorePair(g, s)),
      lineScore(E.publishedGame(g)),
      lines.length ? statsTable(BATTING, lines) : null,
      h("div", { class: "k" }, "Plays · tap to edit"),
      h("div", { class: "card pbp" }, [...byInning.entries()].map(([inn, plays]) => [
        h("div", { class: "inn" }, `${ordinal(inn)} inning`),
        plays.map(([p, i]) => h("button", { type: "button", class: `play play-btn${s.needsReview.has(p.id) ? " review" : ""}`, onclick: () => openEdit(rec, i) },
          h("div", null, s.needsReview.has(p.id) ? "⚠ " : "", E.describe(g, p)),
          E.runnerSummary(g, p) ? h("div", { class: "r" }, E.runnerSummary(g, p)) : null)),
      ])),
      s.needsReview.size ? h("div", { class: "muted small" }, "⚠ marks plays whose runners no longer match the bases (usually after an earlier play was edited). Open them to fix where everyone ended up.") : null,
    ], { wide: true });
  }
  const ctxLine = l => ({ name: l.player.name, pa: l.pa, ab: l.ab, r: l.runs, crr: l.courtesyRuns, h: l.hits, b1: l.singles, b2: l.doubles,
    b3: l.triples, hr: l.homeRuns, rbi: l.rbi, bb: l.walks, sf: l.sacFlies, roe: l.roe, fc: l.fieldersChoices, kl: l.kLooking,
    ks: l.kSwinging, kf: l.kFoul, hro: l.hrOuts, go: l.groundOuts, fo: l.flyOuts, lo: l.lineOuts, po: l.popOuts, dp: l.doublePlays, tp: l.triplePlays });

  function lineupSheet(rec, g, sh) {
    if (!sh.work) {
      const ran = new Set((g.courtesySwaps || []).map(x => x.runnerID));
      sh.work = { lineup: structuredClone(g.lineup), bench: structuredClone(g.bench || []), extras: structuredClone((g.extras || []).filter(p => ran.has(p.id))),
        subs: { ...(g.subs || {}) }, add: "", subFor: null, subName: "" };
    }
    const w = sh.work;
    const batted = new Set(g.plays.map(p => p.batterID));
    const finished = g.isFinal;
    const manager = isManagerHere();
    const move = (i, d) => { const j = i + d; if (j < 0 || j >= w.lineup.length) return; [w.lineup[i], w.lineup[j]] = [w.lineup[j], w.lineup[i]]; render(); };
    const inGame = new Set([...w.lineup, ...w.bench].map(p => p.member).filter(Boolean));
    const available = members(rec).filter(m => !inGame.has(m.uid));
    const addPlayer = p => { w.lineup.push(p); w.add = ""; render(); };
    const substitute = newPlayer => {
      const i = w.lineup.findIndex(p => p.id === w.subFor);
      if (i < 0) return;
      const target = w.lineup[i];
      w.lineup[i] = newPlayer;
      if (batted.has(target.id)) { w.bench.push(target); w.subs[target.id] = newPlayer.id; }
      w.subFor = null; w.subName = "";
      render();
    };
    const canSave = w.lineup.length && [...w.lineup, ...w.bench, ...w.extras].every(p => p.name.trim());
    const nameInput = p => (manager ? h("input", { type: "text", value: p.name, maxlength: "80", "aria-label": "Name", oninput: e => { p.name = e.target.value; } })
      : h("span", { class: "lineup-name" }, p.name));
    return sheet(finished ? "Fix Lineup" : "Lineup & Subs", [
      h("div", { class: "k" }, "Batting order"),
      h("div", { class: "card lineup-list" }, w.lineup.map((p, i) => h("div", { class: "lineup-row" },
        h("span", { class: "order" }, String(i + 1)), nameInput(p),
        h("span", { class: "row-tools" },
          manager ? h("button", { type: "button", class: "icon-btn", "aria-label": "Move up", onclick: () => move(i, -1) }, "↑") : null,
          manager ? h("button", { type: "button", class: "icon-btn", "aria-label": "Move down", onclick: () => move(i, 1) }, "↓") : null,
          !finished ? h("button", { type: "button", class: "link-btn", onclick: () => { w.subFor = p.id; w.subName = ""; render(); } }, "Sub") : null,
          manager && !batted.has(p.id) ? h("button", { type: "button", class: "link-btn danger", onclick: () => { w.lineup.splice(i, 1); render(); } }, "Remove") : null)))),
      manager ? null : h("div", { class: "muted small" }, "A manager sets the batting order. You can sub someone in or add a late arrival at the bottom."),
      w.subFor ? h("div", { class: "card pad" },
        h("b", null, `Sub in for ${w.lineup.find(p => p.id === w.subFor)?.name}`),
        h("p", { class: "muted small" }, "They take this spot in the batting order. Both players keep their own stats."),
        available.length ? h("div", { class: "pick-list" }, available.map(m => btn(m.name, () => substitute({ id: E.newID(), name: m.name, member: m.uid }), "soft"))) : null,
        h("div", { class: "pin-search" },
          h("input", { type: "text", placeholder: "New player's name", maxlength: "80", value: w.subName, oninput: e => { w.subName = e.target.value; } }),
          btn("Sub In", () => { if (w.subName.trim()) substitute(linkedPlayer(rec, w.subName)); }, "soft"),
          btn("Cancel", () => { w.subFor = null; render(); }, "soft"))) : null,
      !finished ? [h("div", { class: "k" }, "Add a late arrival"),
        available.length ? h("div", { class: "pick-list" }, available.map(m => btn(`+ ${m.name}`, () => addPlayer({ id: E.newID(), name: m.name, member: m.uid }), "soft"))) : null,
        h("div", { class: "pin-search" },
          h("input", { type: "text", placeholder: "Name", maxlength: "80", value: w.add, oninput: e => { w.add = e.target.value; } }),
          btn("Add", () => { if (w.add.trim()) addPlayer(linkedPlayer(rec, w.add)); }, "soft"))] : null,
      w.bench.length ? [h("div", { class: "k" }, "Subbed out"), h("div", { class: "card lineup-list" }, w.bench.map(p => h("div", { class: "lineup-row" }, nameInput(p))))] : null,
      w.extras.length ? [h("div", { class: "k" }, "Courtesy runners"), h("div", { class: "card lineup-list" }, w.extras.map(p => h("div", { class: "lineup-row" }, nameInput(p))))] : null,
      btn("Save Lineup", async () => {
        if (!canSave) return;
        const clean = ps => ps.map(p => ({ ...p, name: p.name.trim() }));
        const fixedExtras = new Map(clean(w.extras).map(p => [p.id, p]));
        ui.sheet = null;
        await change(rec, x => {
          x.lineup = clean(w.lineup);
          x.bench = clean(w.bench);
          x.subs = w.subs;
          x.extras = (x.extras || []).map(p => fixedExtras.get(p.id) || p);
        });
        render();
      }, "big save", { disabled: !canSave || null }),
    ]);
  }

  function detailsSheet(rec, g, sh) {
    if (!sh.work) sh.work = { opponent: g.opponent, isHome: g.isHome, date: g.date, kind: g.event?.kind || "", name: g.event?.name || "" };
    const w = sh.work;
    const side = h("select", { onchange: e => { w.isHome = e.target.value === "home"; } },
      h("option", { value: "away" }, "Away (bat first)"), h("option", { value: "home" }, "Home (bat second)"));
    side.value = w.isHome ? "home" : "away";
    const kind = h("select", { onchange: e => { w.kind = e.target.value; render(); } },
      h("option", { value: "" }, "None"), h("option", { value: "season" }, "Season"), h("option", { value: "tournament" }, "Tournament"));
    kind.value = w.kind;
    return sheet("Date, Opponent & Season", h("div", { class: "game-form plain" },
      h("label", null, "Date", h("input", { type: "date", value: w.date, onchange: e => { w.date = e.target.value; } })),
      h("label", null, "Opponent", h("input", { type: "text", maxlength: "80", value: w.opponent, oninput: e => { w.opponent = e.target.value; } })),
      h("label", null, "We're", side),
      h("div", { class: "row2" }, h("label", null, "Season or tournament", kind),
        w.kind ? h("label", null, "Name", h("input", { type: "text", maxlength: "60", value: w.name, oninput: e => { w.name = e.target.value; } })) : h("span")),
      btn("Save", async () => {
        ui.sheet = null;
        await change(rec, x => {
          x.opponent = w.opponent.trim(); x.isHome = w.isHome; x.date = w.date || x.date;
          x.event = w.kind && w.name.trim() ? { kind: w.kind, name: w.name.trim() } : null;
        });
        render();
      }, "big save")));
  }

  function rulesSheet() {
    const r = rules();
    const set = (k, v) => { storage.set("statbook.rules", JSON.stringify({ ...rules(), [k]: v })); render(); };
    const toggle = (k, label, note) => h("label", { class: "toggle block" },
      h("input", { type: "checkbox", checked: r[k] || null, onchange: e => set(k, e.target.checked) }),
      h("span", null, h("b", null, label), h("span", { class: "muted small" }, note)));
    return sheet("Runner Defaults", [
      h("p", { class: "muted" }, "Where runners start in “What happened?”. You can always move anyone before saving."),
      toggle("secondScoresOnSingle", "Runner on 2nd scores on a single", "Otherwise they stop at 3rd."),
      toggle("twoOutsRunOnContact", "Two outs: runners take an extra base", "Runners are moving on contact with two outs."),
    ]);
  }

  function syncSheet(rec) {
    const sync = syncText(rec);
    return sheet("Saving & uploading", [
      h("p", null, h("b", null, sync.text)),
      h("p", null, "Every tap is saved on this phone the moment you make it, then uploaded. Closing the page, losing signal or a dead battery won't lose anything already tapped; it uploads next time this page is open with a connection."),
      h("ul", { class: "muted small" },
        h("li", null, `Revision ${rec.rev} saved on this phone${rec.syncedRev ? `, ${rec.syncedRev} uploaded` : ""}.`),
        rec.syncedAt ? h("li", null, `Last upload: ${new Date(rec.syncedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}.`) : null,
        h("li", null, "Every revision is kept online too, so any earlier version can be brought back.")),
      !DEMO && rec.pending.length ? btn("Upload Now", () => { rec.error = null; syncRec(rec).then(() => render()); }, "soft") : null,
    ]);
  }

  // ---------- Startup ----------

  const ready = loadRecs().then(() => { syncAll(); });

  return {
    ready, isScorerHere, isManagerHere, recsForTeam: teamRecs, scheduleLineupEditor, startFromSchedule,
    view(r) {
      if (!r.id) return listView();
      if (r.id === "new") return newGameView();
      return scoreView(r.id);
    },
    /// Live scoring is full screen (no tabs); the list and new game sit inside the team pages.
    fullScreen: r => !!r.id && r.id !== "new" && (recs.has(r.id)),
    /// Something still waiting to upload (shown on the Games tab).
    waiting: teamId => teamRecs(teamId).filter(x => x.pending.length || x.conflict).length,
  };
};
