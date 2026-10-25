// Team stats website for Slow Pitch Book.
//
// The app publishes each game to Firestore under statbooks/{boardKey}, where boardKey is the SHA-256
// of "slowpitchbook:" + the team password (see Publisher.swift). Teammates type the same password
// here; the page computes the same key and reads that team's games. Nothing else is needed.

(() => {
  "use strict";

  const cfg = window.STATBOOK_CONFIG || {};
  const DEMO = new URLSearchParams(location.search).has("demo");
  const REFRESH_MS = 20000;
  const app = document.getElementById("app");

  const storage = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) {
      try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ }
    },
  };

  const state = {
    key: null,
    board: null,          // { name }
    games: [],            // PublishedGame objects, newest first
    signature: "",        // last data loaded, to skip re-rendering when nothing changed
    updated: null,
    books: {},            // game id -> data URL, "none", or "loading"
    statsSort: { col: "avg", dir: -1 },
    statsTeam: "",
    sprayPlayer: "",
    sprayGame: "",
    event: storage.get("statbook.event") || "",   // season / tournament filter ("" = all, "none" = no season)
    gamePlayer: {},       // game id -> player shown on that game's spray chart
  };

  // ---------- Small DOM helper (text always goes in as text, never as HTML) ----------

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "svg") el.innerHTML = v;   // only SVG this file builds from numbers
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

  /// Season totals by player name, like the app's Season screen (a game counts if they batted or scored).
  function seasonLines(games) {
    const by = new Map();
    for (const g of games) {
      for (const l of g.lines || []) {
        if (!(l.pa > 0 || l.r > 0 || l.crr > 0)) continue;
        const name = String(l.name || "").trim();
        const key = name.toLowerCase();
        const s = by.get(key) || Object.fromEntries([["name", name], ["g", 0], ...FIELDS.map(f => [f, 0])]);
        s.g += 1;
        for (const f of FIELDS) s[f] += l[f] || 0;
        by.set(key, s);
      }
    }
    return [...by.values()].map(derive);
  }

  function record(games) {
    let w = 0, l = 0, t = 0;
    for (const g of games) {
      if (g.outcome === "W") w++; else if (g.outcome === "L") l++; else if (g.outcome === "T") t++;
    }
    return t ? `${w}-${l}-${t}` : `${w}-${l}`;
  }

  // ---------- Data ----------

  async function boardKey(password) {
    // Same as the app: trim spaces/tabs (Swift's .whitespaces), SHA-256, lowercase hex.
    const text = "slowpitchbook:" + password.replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, "");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
  }

  const configured = () => DEMO || (cfg.projectId && cfg.apiKey && !/^YOUR-/.test(cfg.projectId) && !/^YOUR-/.test(cfg.apiKey));

  async function firestore(path, query) {
    const url = new URL(`https://firestore.googleapis.com/v1/projects/${encodeURIComponent(cfg.projectId)}/databases/(default)/documents/${path}`);
    url.searchParams.set("key", cfg.apiKey);
    for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, v);
    const res = await fetch(url, { cache: "no-store" });
    if (res.status === 404 || res.status === 403) return null;
    if (!res.ok) throw new Error(`The stats server answered ${res.status}.`);
    return res.json();
  }

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

  /// Loads the board and all its games. Returns false when no team matches the key.
  async function load(key) {
    let board, games;
    if (DEMO) {
      const d = await loadDemo();
      board = d.board;
      games = d.games;
    } else {
      const doc = await firestore(`statbooks/${key}`);
      if (!doc) return false;
      board = { name: doc.fields?.name?.stringValue || "Team Stats" };
      games = [];
      let pageToken;
      do {
        const page = await firestore(`statbooks/${key}/games`, { pageSize: 300, pageToken });
        for (const d of page?.documents || []) {
          try { games.push(JSON.parse(d.fields.json.stringValue)); } catch { /* skip a damaged game */ }
        }
        pageToken = page?.nextPageToken;
      } while (pageToken);
    }
    games.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    const signature = JSON.stringify([board, games]);
    const changed = signature !== state.signature;
    Object.assign(state, { key, board, games, signature, updated: new Date() });
    return changed ? "changed" : "same";
  }

  async function loadBook(id) {
    if (state.books[id]) return;
    state.books[id] = "loading";
    try {
      const doc = DEMO ? null : await firestore(`statbooks/${state.key}/books/${encodeURIComponent(id)}`);
      const jpeg = doc?.fields?.jpeg?.stringValue;
      state.books[id] = jpeg ? `data:image/jpeg;base64,${jpeg}` : "none";
    } catch {
      state.books[id] = "none";
    }
    if (route().name === "game" && route().id === id) render();
  }

  // ---------- Routing ----------

  function route() {
    const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
    if (parts[0] === "game" && parts[1]) return { name: "game", id: decodeURIComponent(parts[1]) };
    if (parts[0] === "stats") return { name: "stats" };
    if (parts[0] === "spray") return { name: "spray" };
    return { name: "games" };
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

  // ---------- Views ----------

  function lockView(message) {
    const input = h("input", {
      type: "password", placeholder: "Team password", autocomplete: "current-password",
      "aria-label": "Team password", required: true,
    });
    const err = h("div", { class: "err", role: "alert" }, message || "");
    const button = h("button", { class: "btn", type: "submit" }, "Open Stats");
    const form = h("form", {
      onsubmit: async e => {
        e.preventDefault();
        if (!input.value.trim()) return;
        button.disabled = true;
        button.textContent = "Opening…";
        err.textContent = "";
        try {
          const key = await boardKey(input.value);
          const ok = await load(key);
          if (!ok) {
            err.textContent = "That password didn't match a team. Check with your scorer.";
          } else {
            storage.set("statbook.key", key);
            render();
            startRefresh();
            return;
          }
        } catch (e2) {
          err.textContent = e2.message || "Couldn't reach the stats server.";
        }
        button.disabled = false;
        button.textContent = "Open Stats";
      },
    }, input, button, err);
    app.replaceChildren(h("div", { class: "lock" }, h("div", { class: "panel" },
      h("img", { src: "apple-touch-icon.png", alt: "" }),
      h("h1", null, "Team Stats"),
      h("p", null, configured()
        ? "Enter the team password from your scorer."
        : "This site isn't set up yet: fill in public/config.js with your Firebase project ID and web API key."),
      configured() ? form : null)));
    if (configured()) setTimeout(() => input.focus(), 50);
  }

  function shell(current, content) {
    const finals = state.games.filter(g => g.isFinal);
    const tab = (name, href, label) => h("a", { href, class: current === name ? "on" : null }, label);
    const signOut = () => {
      storage.set("statbook.key", null);
      Object.assign(state, { key: null, board: null, games: [], signature: "", books: {} });
      stopRefresh();
      location.hash = "";
      lockView();
    };
    return [
      h("header", { class: "topbar" }, h("div", { class: "wrap" },
        h("div", { class: "brand" },
          h("img", { src: "apple-touch-icon.png", alt: "" }),
          h("div", null,
            h("h1", null, state.board?.name || "Team Stats"),
            h("div", { class: "sub" }, `${finals.length} game${finals.length === 1 ? "" : "s"} played`,
              DEMO ? " · " : "", DEMO ? h("span", { class: "pill demo" }, "Demo data") : null)),
          h("div", { class: "record" }, h("b", null, record(state.games)), h("span", { class: "sub" }, "Record"))),
        h("nav", { class: "tabs", "aria-label": "Sections" },
          tab("games", "#/", "Games"), tab("stats", "#/stats", "Season Stats"), tab("spray", "#/spray", "Spray Charts"),
          h("span", { class: "spacer" }),
          h("button", { class: "link", type: "button", onclick: signOut }, "Sign out")))),
      h("main", { class: "wrap" }, content,
        h("div", { class: "foot" },
          state.updated ? `Updated ${state.updated.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} · ` : "",
          "Refreshes automatically during games")),
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
        h("div", { class: "card empty" }, "No games published yet. They'll show up here as soon as the scorer starts one.")];
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
    if (!g) return [h("a", { class: "back", href: "#/" }, "‹ All games"), h("div", { class: "card empty", style: "margin-top:12px" }, "That game isn't on the website anymore.")];
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
      h("a", { class: "back", href: "#/" }, "‹ All games"),
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
      h("div", { class: "legend" }, "Tap a column to sort. Players are matched by name across games. AVG = H/AB · OBP = (H+BB)/(AB+BB+SF) · SLG = total bases/AB."),
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

  // ---------- Render & refresh ----------

  function render() {
    if (!state.key) return lockView();
    const r = route();
    const y = window.scrollY;
    const content = r.name === "game" ? gameView(r.id) : r.name === "stats" ? statsView() : r.name === "spray" ? sprayView() : gamesView();
    app.replaceChildren(...shell(r.name === "game" ? "games" : r.name, content));
    window.scrollTo(0, y);
    document.title = `${state.board?.name || "Team"} Stats`;
  }

  let timer = null;
  function startRefresh() {
    stopRefresh();
    if (DEMO) return;
    timer = setInterval(async () => {
      if (document.visibilityState !== "visible" || !state.key) return;
      try { if ((await load(state.key)) === "changed") render(); } catch { /* try again next time */ }
    }, REFRESH_MS);
  }
  function stopRefresh() { if (timer) clearInterval(timer); timer = null; }

  window.addEventListener("hashchange", () => { render(); window.scrollTo(0, 0); });

  async function start() {
    if (!configured()) return lockView();
    const saved = DEMO ? "demo" : storage.get("statbook.key");
    if (!saved) return lockView();
    app.replaceChildren(h("div", { class: "lock" }, h("div", { class: "panel" }, h("p", null, "Loading stats…"))));
    try {
      const ok = await load(saved);
      if (!ok) { storage.set("statbook.key", null); return lockView("The team password changed. Enter the new one."); }
      render();
      startRefresh();
    } catch (e) {
      lockView(e.message || "Couldn't reach the stats server.");
    }
  }

  start();
})();
