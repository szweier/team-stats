// The paper scorebook, box score sheet and text report for a game scored on the website, drawn the way the
// Slow Pitch Book app draws them (ScorebookView.swift, StatSheetView.swift, Game.report()), plus turning them
// into images to share. Built on engine.js; everything is drawn as SVG.

window.StatBook = (function () {
  "use strict";
  const E = window.StatEngine;
  const OUT = 0, FIRST = 1, SECOND = 2, THIRD = 3, HOME = 4;

  const PAPER = "#fcfcf7", GRID = "#8c99ad", INK = "#12173d", BAND = "#e6ebf2", STRIPE = "#f2f4f7";
  const HAND = "Noteworthy, 'Bradley Hand', 'Marker Felt', 'Segoe Print', 'Comic Sans MS', cursive";
  const SANS = "ui-rounded, 'SF Pro Rounded', system-ui, -apple-system, 'Segoe UI', sans-serif";
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmt = n => (Number.isInteger(n) ? n : n.toFixed(2));
  const text = (x, y, s, { size = 12, font = SANS, weight = 600, fill = INK, anchor = "middle", base = "central" } = {}) =>
    `<text x="${fmt(x)}" y="${fmt(y)}" font-size="${size}" font-family="${font}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}" dominant-baseline="${base}">${esc(s)}</text>`;
  const rect = (x, y, w, h, extra = "") => `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" ${extra}/>`;
  const line = (x1, y1, x2, y2, stroke = GRID, width = 0.6, extra = "") =>
    `<line x1="${fmt(x1)}" y1="${fmt(y1)}" x2="${fmt(x2)}" y2="${fmt(y2)}" stroke="${stroke}" stroke-width="${width}" ${extra}/>`;
  const fitName = (s, max) => (String(s).length > max ? String(s).slice(0, max - 1) + "…" : String(s));
  const dateText = d => { const [y, m, dd] = String(d || "").split("-").map(Number); return y ? new Date(y, m - 1, dd).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : ""; };
  const title = g => (g.opponent ? `${g.isHome ? "vs" : "@"} ${g.opponent}` : "Game");

  // ---------- Scorebook ----------

  const NAME_W = 116, CELL = 78, TOTAL_W = 32, HEAD_H = 24, TOP = 40, TEAM_H = 52;
  const LABELS = ["1B", "2B", "3B", "HR", "SF", "BB"];

  /// One inning box: the diamond, the 1B…BB column, and what happened on this trip.
  function cell(x, y, w, h, e) {
    const out = [];
    const labelX = x + w - 16;
    const cx = x + (w - 16) / 2, cy = y + h / 2 + 3;
    const rad = Math.min(w - 16, h) * 0.27;
    const pt = { [FIRST]: [cx + rad, cy], [SECOND]: [cx, cy - rad], [THIRD]: [cx - rad, cy], [HOME]: [cx, cy + rad] };
    const home = pt[HOME];
    const labelY = i => y + 4 + ((h - 8) / LABELS.length) * (i + 0.5);
    const diamond = `${fmt(home[0])},${fmt(home[1])} ${pt[FIRST].map(fmt)} ${pt[SECOND].map(fmt)} ${pt[THIRD].map(fmt)}`;
    out.push(line(labelX, y, labelX, y + h, GRID, 0.5, 'stroke-opacity="0.5"'));
    LABELS.forEach((l, i) => out.push(text(labelX + 8, labelY(i), l, { size: 7, weight: 500, fill: GRID })));
    out.push(`<polygon points="${diamond}" fill="none" stroke="${GRID}" stroke-opacity="0.55" stroke-width="0.6"/>`);
    if (!e) return out.join("");

    const pen = `stroke="${INK}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"`;
    if (e.circled != null) {
      const cy2 = labelY(e.circled);
      out.push(`<ellipse cx="${fmt(labelX + 8)}" cy="${fmt(cy2)}" rx="7" ry="5.5" fill="none" stroke="${INK}" stroke-width="1.2"/>`);
    }
    // Base path up to the last base reached safely; a filled diamond for a run.
    const reached = [FIRST, SECOND, THIRD, HOME].filter(b => e.farthest !== OUT && b <= e.farthest);
    if (reached.length) out.push(`<polyline points="${[home, ...reached.map(b => pt[b])].map(p => p.map(fmt).join(",")).join(" ")}" ${pen}/>`);
    if (e.final === HOME) out.push(`<polygon points="${diamond}" fill="${INK}" fill-opacity="0.8" ${pen.replace('fill="none"', "")}/>`);
    // Thrown out on the bases: half a line toward the next base, with an X.
    if (e.final === OUT && !e.batterOutOnPlay && e.farthest !== OUT) {
      const from = pt[e.farthest], next = pt[Math.min(e.farthest + 1, HOME)];
      const mid = [(from[0] + next[0]) / 2, (from[1] + next[1]) / 2];
      out.push(`<polyline points="${from.map(fmt)} ${mid.map(fmt)}" ${pen}/>`);
      out.push(`<path d="M${fmt(mid[0] - 4)},${fmt(mid[1] - 4)}L${fmt(mid[0] + 4)},${fmt(mid[1] + 4)}M${fmt(mid[0] + 4)},${fmt(mid[1] - 4)}L${fmt(mid[0] - 4)},${fmt(mid[1] + 4)}" stroke="${INK}" stroke-width="1.8" stroke-linecap="round"/>`);
    }
    if (e.mark) out.push(text(cx, cy, e.mark, { size: e.mark.length <= 2 ? 21 : 15, font: HAND, weight: 700 }));
    if (e.corner) out.push(text(x + 12, y + 10, e.corner, { size: 12, font: HAND, weight: 700 }));
    if (e.outNumber) {
      out.push(`<circle cx="${fmt(labelX - 9)}" cy="${fmt(y + 10)}" r="6.5" fill="none" stroke="${INK}" stroke-width="1.1"/>`);
      out.push(text(labelX - 9, y + 10.5, String(e.outNumber), { size: 9, weight: 700 }));
    }
    for (let k = 0; k < Math.min(e.rbi, 4); k++) out.push(`<circle cx="${fmt(x + 7 + k * 7)}" cy="${fmt(y + h - 7)}" r="2.5" fill="${INK}"/>`);
    if (e.courtesyRunner) out.push(text(cx, y + 6, `CR ${e.courtesyRunner}`, { size: 7 }));
    if (e.endsInning) out.push(line(labelX - 2, y + h - 18, labelX - 20, y + h - 1, INK, 2, 'stroke-linecap="round"'));
    return out.join("");
  }

  /// The whole game as a paper scorebook (SVG). Returns { svg, width, height }.
  function scorebook(g) {
    const book = E.book(g);
    const played = book.innings[book.innings.length - 1] || 1;
    const innings = Array.from({ length: Math.max(played, 7) }, (_, i) => i + 1);
    // An inning gets a column per time through the order (batting around adds a "cont." column).
    const cols = innings.flatMap(inning => {
      const passes = Math.max(1, ...Object.values(book.entries).map(byInning => (byInning[inning] || []).length));
      return Array.from({ length: passes }, (_, pass) => ({ inning, pass, passes }));
    });
    const lines = new Map(E.statLines(g).map(l => [l.player.id, l]));
    const rows = [...g.lineup.map((p, i) => ({ number: String(i + 1), p, sub: false })), ...(g.bench || []).map(p => ({ number: "", p, sub: true }))];
    const width = NAME_W + cols.length * CELL + TOTAL_W * 4;
    const height = TOP + HEAD_H + rows.length * CELL + TEAM_H * 2;
    const s = E.state(g);
    const out = [rect(0, 0, width, height, `fill="${PAPER}"`)];
    out.push(text(10, 22, `${g.team ? g.team + " " : ""}${g.opponent ? title(g) : ""}`, { size: 22, font: HAND, weight: 700, anchor: "start" }));
    out.push(text(width - 10, 22, `${dateText(g.date)}     ${s.runs}–${E.opponentTotal(g)}`, { size: 20, font: HAND, weight: 700, anchor: "end" }));
    // Header row.
    let x = 0, y = TOP;
    const head = (label, w, anchor = "middle") => {
      out.push(rect(x, y, w, HEAD_H, `fill="none" stroke="${GRID}" stroke-width="0.6"`));
      out.push(text(anchor === "start" ? x + 6 : x + w / 2, y + HEAD_H / 2, label, { size: 11, fill: GRID, anchor }));
      x += w;
    };
    head("NAME", NAME_W, "start");
    cols.forEach(c => head(c.pass === 0 ? String(c.inning) : `${c.inning} cont.`, CELL));
    ["AB", "R", "H", "RBI"].forEach(l => head(l, TOTAL_W));
    // A row per batter.
    y = TOP + HEAD_H;
    for (const r of rows) {
      x = 0;
      out.push(rect(x, y, NAME_W, CELL, `fill="none" stroke="${GRID}" stroke-width="0.6"`));
      out.push(text(x + 6, y + 14, r.number, { size: 10, fill: GRID, anchor: "start" }));
      out.push(text(x + 18, y + 15, fitName(r.p.name, 13), { size: 19, font: HAND, weight: 700, anchor: "start" }));
      out.push(text(x + 6, y + CELL - 8, r.sub ? "Sub (out)" : "Sub", { size: 8, fill: GRID, weight: 500, anchor: "start" }));
      x += NAME_W;
      for (const c of cols) {
        const trips = book.entries[r.p.id]?.[c.inning] || [];
        out.push(cell(x, y, CELL, CELL, c.pass < trips.length ? trips[c.pass] : null));
        out.push(rect(x, y, CELL, CELL, `fill="none" stroke="${GRID}" stroke-width="0.6"`));
        x += CELL;
      }
      const l = lines.get(r.p.id);
      for (const v of [l?.ab, l?.runs, l?.hits, l?.rbi]) {
        out.push(rect(x, y, TOTAL_W, CELL, `fill="none" stroke="${GRID}" stroke-width="0.6"`));
        out.push(text(x + TOTAL_W / 2, y + CELL / 2, v ?? "", { size: 16, font: HAND, weight: 700 }));
        x += TOTAL_W;
      }
      y += CELL;
    }
    // Runs by inning: visitors on top, home team underneath.
    const team = (name, runsFor, total) => {
      x = 0;
      out.push(rect(x, y, NAME_W, TEAM_H, `fill="none" stroke="${GRID}" stroke-width="0.6"`));
      out.push(text(x + 6, y + TEAM_H / 2, fitName(name, 12), { size: 20, font: HAND, weight: 700, anchor: "start" }));
      x += NAME_W;
      for (const c of cols.filter(c => c.pass === 0)) {
        const w = CELL * c.passes;
        out.push(rect(x, y, w, TEAM_H, `fill="none" stroke="${GRID}" stroke-width="0.6"`));
        if (c.inning <= played) out.push(text(x + w / 2, y + TEAM_H / 2, runsFor(c.inning), { size: 30, font: HAND, weight: 700 }));
        x += w;
      }
      out.push(rect(x, y, TOTAL_W * 4, TEAM_H, `fill="none" stroke="${GRID}" stroke-width="0.6"`));
      out.push(text(x + TOTAL_W * 2, y + TEAM_H / 2, total, { size: 30, font: HAND, weight: 700 }));
      y += TEAM_H;
    };
    const ours = () => team(g.team || "Us", i => book.runsByInning[i] || 0, s.runs);
    const theirs = () => team(g.opponent || "Them", i => (g.opponentRuns || {})[i] || 0, E.opponentTotal(g));
    if (g.isHome) { theirs(); ours(); } else { ours(); theirs(); }
    return { width, height, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${out.join("")}</svg>` };
  }

  // ---------- Box score sheet ----------

  function boxScore(g) {
    const s = E.state(g);
    const played = E.book(g).innings.slice(-1)[0] || 1;
    const innings = Array.from({ length: Math.max(played, 7) }, (_, i) => i + 1);
    const lines = E.statLines(g).filter(l => l.pa > 0 || l.runs > 0 || l.courtesyRuns > 0);
    const totals = E.totals(g);
    const COLS = [["AB", "ab"], ["R", "runs"], ["H", "hits"], ["2B", "doubles"], ["3B", "triples"], ["HR", "homeRuns"], ["RBI", "rbi"], ["BB", "walks"], ["K", null]];
    const NW = 140, C = 36, RH = 30, PAD = 12;
    const width = Math.max(NW + innings.length * C + 3 * C, NW + COLS.length * C) + PAD * 2;
    const out = [];
    let y = PAD;
    out.push(text(PAD, y + 12, "Box Score", { size: 18, weight: 700, anchor: "start" }));
    out.push(text(width - PAD, y + 12, `${dateText(g.date)}${E.outcome(g) ? "  ·  " + E.outcome(g) : ""}`, { size: 13, weight: 600, anchor: "end" }));
    y += 32;
    // Line score.
    const head = (labels, widths) => {
      let x = PAD;
      out.push(rect(PAD, y, width - PAD * 2, RH, `fill="${BAND}"`));
      labels.forEach((l, i) => { out.push(text(i === 0 ? x + 8 : x + widths[i] / 2, y + RH / 2, l, { size: 12, weight: 700, anchor: i === 0 ? "start" : "middle" })); x += widths[i]; });
      y += RH;
    };
    const lsW = [NW, ...innings.map(() => C), C, C, C];
    head(["", ...innings.map(String), "R", "H", "E"], lsW);
    const lsRow = (name, runs, r, hcount, i) => {
      let x = PAD;
      if (i % 2) out.push(rect(PAD, y, width - PAD * 2, RH, `fill="${STRIPE}"`));
      [fitName(name, 16), ...innings.map(n => (n <= played ? String(runs(n)) : "")), String(r), hcount, ""].forEach((v, k) => {
        out.push(text(k === 0 ? x + 8 : x + lsW[k] / 2, y + RH / 2, v, { size: 13, weight: k === 0 || k === innings.length + 1 ? 700 : 500, anchor: k === 0 ? "start" : "middle" }));
        x += lsW[k];
      });
      y += RH;
    };
    const rowsLS = [[g.team || "Us", n => s.runsByInning[n] || 0, s.runs, String(totals.hits)], [g.opponent || "Them", n => (g.opponentRuns || {})[n] || 0, E.opponentTotal(g), ""]];
    (g.isHome ? rowsLS.reverse() : rowsLS).forEach((r, i) => lsRow(...r, i));
    y += 16;
    // Batting.
    const bW = [NW, ...COLS.map(() => C)];
    head(["Batting", ...COLS.map(c => c[0])], bW);
    const val = (l, c) => (c[1] ? l[c[1]] : l.kLooking + l.kSwinging + l.kFoul);
    [...lines, { ...totals, player: { name: "Team" }, _total: true }].forEach((l, i) => {
      let x = PAD;
      if (l._total) out.push(line(PAD, y, width - PAD, y, INK, 1));
      else if (i % 2) out.push(rect(PAD, y, width - PAD * 2, RH, `fill="${STRIPE}"`));
      [fitName(l.player.name, 16), ...COLS.map(c => String(val(l, c) || (l._total ? val(l, c) : "–")))].forEach((v, k) => {
        out.push(text(k === 0 ? x + 8 : x + bW[k] / 2, y + RH / 2, v, { size: 13, weight: l._total || k === 0 ? 700 : 500, anchor: k === 0 ? "start" : "middle", fill: v === "–" ? GRID : INK }));
        x += bW[k];
      });
      y += RH;
    });
    // Pitching.
    const pitchers = E.pitchingLines(g);
    if (pitchers.length) {
      y += 16;
      const pCols = [["IP", l => E.inningsText(l.outs)], ["R", l => String(l.runs)], ["ERA", l => (l.outs ? E.era(l.runs, l.outs).toFixed(2) : "–")], ["DEC", l => l.decision || ""]];
      const pW = [NW, ...pCols.map(() => C + 12)];
      head(["Pitching", ...pCols.map(c => c[0])], pW);
      pitchers.forEach((l, i) => {
        let x = PAD;
        if (i % 2) out.push(rect(PAD, y, width - PAD * 2, RH, `fill="${STRIPE}"`));
        [fitName(l.player.name, 16), ...pCols.map(c => c[1](l))].forEach((v, k) => {
          out.push(text(k === 0 ? x + 8 : x + pW[k] / 2, y + RH / 2, v, { size: 13, weight: k === 0 ? 700 : 500, anchor: k === 0 ? "start" : "middle" }));
          x += pW[k];
        });
        y += RH;
      });
    }
    y += PAD;
    return { width, height: y, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${y}" width="${width}" height="${y}">${rect(0, 0, width, y, `fill="${PAPER}"`)}${out.join("")}</svg>` };
  }

  // ---------- Text report (like the app's Text / CSV share) ----------

  function report(g) {
    const s = E.state(g), bk = E.book(g);
    const oc = E.outcome(g);
    let out = `${g.team ? g.team + " " : ""}${title(g)} — ${dateText(g.date)}\n`;
    out += `Score: ${s.runs}–${E.opponentTotal(g)}${oc ? ` (${oc})` : ""}\n`;
    const usLine = "Us:   " + bk.innings.map(i => s.runsByInning[i] || 0).join(" ") + "\n";
    const themLine = "Them: " + bk.innings.map(i => (g.opponentRuns || {})[i] || 0).join(" ") + "\n";
    out += `We were the ${g.isHome ? "home" : "away"} team\n` + (g.isHome ? themLine + usLine : usLine + themLine) + "\n";
    const H = ["PA", "AB", "R", "CRR", "H", "1B", "2B", "3B", "HR", "RBI", "BB", "SF", "K"];
    const row = l => [l.pa, l.ab, l.runs, l.courtesyRuns, l.hits, l.singles, l.doubles, l.triples, l.homeRuns, l.rbi, l.walks, l.sacFlies, l.kLooking + l.kSwinging + l.kFoul];
    out += "Player," + H.join(",") + "\n";
    for (const l of [...E.statLines(g), E.totals(g)]) out += [l.player.name, ...row(l)].join(",") + "\n";
    const pitchers = E.pitchingLines(g);
    if (pitchers.length) {
      out += "\nPitcher,IP,R,ERA,Decision\n";
      for (const l of pitchers) out += [l.player.name, E.inningsText(l.outs), l.runs, l.outs ? E.era(l.runs, l.outs).toFixed(2) : "", l.decision || ""].join(",") + "\n";
    }
    out += "\nPLAYS\n";
    for (const p of g.plays) {
      const r = E.runnerSummary(g, p);
      out += `Inn ${p.inning}: ${E.describe(g, p)}${r ? ` (${r})` : ""}\n`;
    }
    return out;
  }

  // ---------- Images and sharing ----------

  /// SVG text → PNG blob (2× for sharp text).
  function png({ svg, width, height }, scale = 2) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = Math.round(width * scale); c.height = Math.round(height * scale);
        const ctx = c.getContext("2d");
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0, width, height);
        c.toBlob(b => (b ? resolve(b) : reject(new Error("Couldn't make the image."))), "image/png");
      };
      img.onerror = () => reject(new Error("Couldn't make the image."));
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    });
  }

  /// Shares a file with the phone's share sheet, or downloads it where sharing files isn't supported.
  async function shareFile(blob, filename, titleText) {
    const file = new File([blob], filename, { type: blob.type });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: titleText }); return; } catch (e) { if (e.name === "AbortError") return; }
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  async function shareText(textBody, titleText) {
    if (navigator.share) {
      try { await navigator.share({ text: textBody, title: titleText }); return; } catch (e) { if (e.name === "AbortError") return; }
    }
    try { await navigator.clipboard.writeText(textBody); alert("Copied the report."); }
    catch { await shareFile(new Blob([textBody], { type: "text/plain" }), "report.txt", titleText); }
  }

  const fileBase = g => `${(g.team || "Game").replace(/[^\w ]+/g, "")} ${g.opponent ? title(g).replace(/[^\w @]+/g, "") : ""} ${g.date || ""}`.replace(/\s+/g, " ").trim();

  // ---------- On the page ----------

  /// The drawn scorebook (or box score) with buttons to share it as a picture or as text.
  function panel(g) {
    const el = (tag, attrs = {}, ...kids) => {
      const n = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) k.startsWith("on") ? n.addEventListener(k.slice(2), v) : n.setAttribute(k, v);
      n.append(...kids.filter(k => k != null));
      return n;
    };
    let showing = "book";
    const paper = el("div", { class: "paper-scroll" });
    const draw = () => (showing === "book" ? scorebook(g) : boxScore(g));
    const tabs = [["book", "Scorebook"], ["box", "Box Score"]].map(([k, label]) =>
      el("button", { type: "button", class: "seg-btn book-tab", "aria-pressed": String(k === showing), onclick: () => { showing = k; show(); } }, label));
    const show = () => {
      const d = draw();
      paper.innerHTML = d.svg;
      paper.classList.toggle("wide", showing === "book");
      tabs.forEach((b, i) => { const on = ["book", "box"][i] === showing; b.setAttribute("aria-pressed", String(on)); b.classList.toggle("on", on); });
    };
    const busy = async (btn, fn) => {
      const was = btn.textContent;
      btn.disabled = true; btn.textContent = "Preparing…";
      try { await fn(); } catch (e) { alert(e.message || "Couldn't share that."); } finally { btn.disabled = false; btn.textContent = was; }
    };
    const shareImage = el("button", { type: "button", class: "btn small", onclick: e => busy(e.currentTarget, async () =>
      shareFile(await png(draw()), `${fileBase(g)} ${showing === "book" ? "Scorebook" : "Box Score"}.png`, title(g))) }, "Share Picture");
    const shareReport = el("button", { type: "button", class: "btn small ghost", onclick: e => busy(e.currentTarget, () => shareText(report(g), title(g))) }, "Share as Text");
    show();
    return el("div", { class: "card paper-book" },
      el("div", { class: "seg" }, ...tabs),
      paper,
      el("div", { class: "paper-actions" }, shareImage, shareReport));
  }

  return { scorebook, boxScore, report, png, shareFile, shareText, fileBase, panel };
})();
