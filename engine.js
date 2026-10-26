// Scoring rules for Slow Pitch Book: the same game model and rules as the iOS app (Models.swift,
// GameEngine.swift, PlayOutcomeView.swift), so a game scored on the website gives the same book,
// stats and runner defaults as one scored in the app. Pure logic: no page, storage or network code,
// so it can be tested on its own (node) and checked against the app's own results.
//
// Bases are numbers: 0 out, 1 first, 2 second, 3 third, 4 home (scored). A game is a plain object:
//   { id, date ("yyyy-MM-dd"), team, opponent, lineup: [Player], bench: [Player], subs: { id: id },
//     extras: [Player], plays: [Play], courtesySwaps: [Swap], opponentRuns: { inning: runs },
//     isFinal, isHome, isSolo, event: { kind: "season"|"tournament", name } | null }
//   Player { id, name, member? }   Play { id, inning, batterID, result, batterTo, runners: [{ playerID, from, to }],
//   rbi, endsInning, outType?, fielder?, location?: { angle, distance } }
//   Swap { id, beforePlay, base, originalID, runnerID }

(function (root) {
  "use strict";

  const OUT = 0, FIRST = 1, SECOND = 2, THIRD = 3, HOME = 4;
  const BASES = [OUT, FIRST, SECOND, THIRD, HOME];
  const ON_BASE = [FIRST, SECOND, THIRD];
  const BASE_LABEL = ["Out", "1st", "2nd", "3rd", "Score"];

  const newID = () => (root.crypto?.randomUUID ? root.crypto.randomUUID() : require("crypto").randomUUID()).toUpperCase();

  // ---------- Players ----------

  const statKey = p => (p.member ? "m:" + p.member : "n:" + String(p.name || "").trim().toLowerCase());

  // ---------- Results ----------

  const RESULTS = {
    single: { code: "1B", title: "Single", hit: 1 },
    double: { code: "2B", title: "Double", hit: 2 },
    triple: { code: "3B", title: "Triple", hit: 3 },
    homeRun: { code: "HR", title: "Home Run", hit: 4 },
    walk: { code: "BB", title: "Walk" },
    reachedOnError: { code: "E", title: "Reached on Error" },
    fieldersChoice: { code: "FC", title: "Fielder's Choice" },
    out: { code: "OUT", title: "Out", batterOut: true },
    homeRunOut: { code: "HRO", title: "HR Out", batterOut: true },
    sacrificeFly: { code: "SF", title: "Sac Fly", batterOut: true },
    strikeoutLooking: { code: "KL", title: "Strikeout looking", batterOut: true, button: "Looking" },
    strikeoutSwinging: { code: "KS", title: "Strikeout swinging", batterOut: true, button: "Swinging" },
    strikeoutFoul: { code: "KF", title: "Strikeout (foul strike 3)", batterOut: true, button: "Foul Ball" },
  };
  const RESULT_ORDER = Object.keys(RESULTS);
  const isHit = r => !!RESULTS[r].hit;
  /// Walks and sac flies don't count as at-bats.
  const isAtBat = r => r !== "walk" && r !== "sacrificeFly";
  const batterIsOut = r => !!RESULTS[r].batterOut;
  const totalBases = r => RESULTS[r].hit || 0;
  const isStrikeout = r => r === "strikeoutLooking" || r === "strikeoutSwinging" || r === "strikeoutFoul";
  const resultCode = r => RESULTS[r].code;
  const resultTitle = r => RESULTS[r].title;
  const buttonTitle = r => RESULTS[r].button || RESULTS[r].title;
  function defaultBatterBase(r) {
    switch (r) {
      case "single": case "walk": case "reachedOnError": case "fieldersChoice": return FIRST;
      case "double": return SECOND;
      case "triple": return THIRD;
      case "homeRun": return HOME;
      default: return OUT;
    }
  }

  const OUT_TYPES = {
    fly: { code: "F", title: "Fly" }, line: { code: "L", title: "Line" },
    ground: { code: "G", title: "Ground" }, pop: { code: "P", title: "Pop" },
  };
  const OUT_TYPE_ORDER = ["fly", "line", "ground", "pop"];

  /// Scorebook position numbers (10-player slow pitch: LF 7, LC 8, RF 9, RC 10; CF shares 8).
  const FIELDERS = { P: 1, C: 2, "1B": 3, "2B": 4, "3B": 5, SS: 6, LF: 7, LC: 8, CF: 8, RF: 9, RC: 10 };
  const FIELDER_ORDER = ["P", "C", "1B", "2B", "3B", "SS", "LF", "LC", "CF", "RC", "RF"];

  // ---------- Field points (angle from center field in degrees, distance in fence units) ----------

  const rad = d => d * Math.PI / 180;
  const pointX = p => p.distance * Math.sin(rad(p.angle));
  const pointY = p => p.distance * Math.cos(rad(p.angle));
  const fromXY = (x, y) => ({ angle: Math.atan2(x, y) * 180 / Math.PI, distance: Math.sqrt(x * x + y * y) });
  const isFair = p => Math.abs(p.angle) <= 45;
  const isOverFence = p => isFair(p) && p.distance > 1.0;
  const POSITION_SPOTS = [["P", 0, 0.19], ["1B", 0.23, 0.30], ["2B", 0.11, 0.47], ["SS", -0.11, 0.47], ["3B", -0.23, 0.30],
    ["LF", -0.425, 0.654], ["LC", -0.149, 0.766], ["RC", 0.149, 0.766], ["RF", 0.425, 0.654]];
  /// Nearest fielder to a spot (pre-fills who made the play).
  function suggestedFielder(p) {
    if (p.distance < 0.09) return "C";
    const x = pointX(p), y = pointY(p);
    let best = null, bestD = Infinity;
    for (const [f, fx, fy] of POSITION_SPOTS) {
      const d = (fx - x) * (fx - x) + (fy - y) * (fy - y);
      if (d < bestD) { bestD = d; best = f; }
    }
    return best || "SS";
  }

  // ---------- Plays ----------

  const runsScored = p => (p.batterTo === HOME ? 1 : 0) + p.runners.filter(m => m.to === HOME).length;
  const outsRecorded = p => (p.batterTo === OUT ? 1 : 0) + p.runners.filter(m => m.to === OUT).length;

  /// A caught fly that lets a runner score is a sac fly; if nobody scores it's a plain fly out.
  /// (Not on a double play, and not when the catch is the 3rd out, since no run can score then.)
  function normalizedForSacrifice(play, outsBefore) {
    const p = { ...play, runners: play.runners.map(m => ({ ...m })) };
    const runnerScored = p.runners.some(m => m.to === HOME);
    const inningEnded = outsBefore + outsRecorded(p) >= 3;
    if (p.result === "out" && p.outType === "fly" && p.batterTo === OUT && runnerScored && outsRecorded(p) === 1 && !inningEnded) {
      p.result = "sacrificeFly";
    } else if (p.result === "sacrificeFly" && !runnerScored) {
      p.result = "out";
      p.outType = "fly";
    }
    if (p.result === "sacrificeFly") p.rbi = Math.max(p.rbi, p.runners.filter(m => m.to === HOME).length);
    return p;
  }

  /// Scorebook code, e.g. "F-LF", "G-SS", "SF-RF".
  function bookCode(p) {
    if (p.result === "out") {
      if (p.outType && p.fielder) return `${OUT_TYPES[p.outType].code}-${p.fielder}`;
      if (p.outType) return OUT_TYPES[p.outType].code + "O";
      if (p.fielder) return `OUT-${p.fielder}`;
      return "OUT";
    }
    if (p.result === "sacrificeFly") return p.fielder ? `SF-${p.fielder}` : "SF";
    return resultCode(p.result);
  }

  /// Paper-scorebook mark in the diamond: "6-3", "7", "L6", "P4", "K", "ꓘ".
  function scorebookMark(p) {
    switch (p.result) {
      case "out": {
        if (!p.fielder) return p.outType ? OUT_TYPES[p.outType].code + "O" : "OUT";
        const n = FIELDERS[p.fielder];
        if (p.outType === "ground") return p.fielder === "1B" ? "3U" : `${n}-3`;
        if (p.outType === "line") return `L${n}`;
        if (p.outType === "pop") return `P${n}`;
        return `${n}`;
      }
      case "sacrificeFly": return p.fielder ? `SF${FIELDERS[p.fielder]}` : "SF";
      case "homeRunOut": return "HRO";
      case "strikeoutSwinging": return "K";
      case "strikeoutLooking": return "ꓘ";
      case "strikeoutFoul": return "KF";
      default: return null;
    }
  }

  function cornerMark(p) {
    const o = outsRecorded(p);
    if (o === 3) return "TP";
    if (o === 2) return "DP";
    if (p.result === "reachedOnError") return "E";
    if (p.result === "fieldersChoice") return "FC";
    return null;
  }

  /// Which entry to circle in the 1B / 2B / 3B / HR / SF / BB column.
  const CIRCLED = { single: 0, double: 1, triple: 2, homeRun: 3, sacrificeFly: 4, walk: 5 };
  const circledLabel = p => (p.result in CIRCLED ? CIRCLED[p.result] : null);

  /// Readable description, e.g. "Fly out to LF".
  function detailTitle(p) {
    if (p.result === "out") {
      const base = p.outType ? `${OUT_TYPES[p.outType].title} out` : "Out";
      return p.fielder ? `${base} to ${p.fielder}` : base;
    }
    if (p.result === "sacrificeFly") return p.fielder ? `Sac Fly to ${p.fielder}` : "Sac Fly";
    return resultTitle(p.result);
  }

  /// How a ball in play shows on a spray chart (null without a location).
  function sprayKind(p) {
    if (!p.location) return null;
    switch (p.result) {
      case "homeRun": return "hr";
      case "single": case "double": case "triple": return "hit";
      case "out": case "homeRunOut": case "sacrificeFly": return "out";
      case "reachedOnError": case "fieldersChoice": return "other";
      default: return null;
    }
  }

  // ---------- Game state (rebuilt from the play log, so undo / edit is just changing the log) ----------

  const allPlayers = g => [...g.lineup, ...(g.bench || []), ...(g.extras || [])];
  const player = (g, id) => allPlayers(g).find(p => p.id === id) || null;
  const nameFor = (g, id) => player(g, id)?.name ?? "?";

  /// Follows substitutions to whoever holds that spot in the order now.
  function currentID(g, id) {
    let x = id, hops = 0;
    while (g.subs && g.subs[x] && hops < 50) { x = g.subs[x]; hops++; }
    return x;
  }

  const sameBases = (a, b) => {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every(k => a[k] === b[k]);
  };

  function applySwaps(g, index, s) {
    for (const sw of g.courtesySwaps || []) {
      if (sw.beforePlay !== index) continue;
      if (s.bases[sw.base] !== sw.originalID) continue;
      s.bases[sw.base] = sw.runnerID;
      const credited = s.runFor[sw.originalID] ?? sw.originalID;
      delete s.runFor[sw.originalID];
      s.runFor[sw.runnerID] = credited;
    }
  }

  /// State before play number `count` (after the first `count` plays and any courtesy swaps made then).
  /// bases: { 1|2|3: playerID }   runFor: { courtesy runner: batter they run for }
  function state(g, count = g.plays.length) {
    const s = { inning: 1, outs: 0, bases: {}, batterIndex: 0, runs: 0, runsByInning: {}, runFor: {},
      runEvents: [], moveCredit: {}, needsReview: new Set() };
    if (!g.lineup.length) return s;
    g.plays.slice(0, count).forEach((play, i) => {
      if (g.isSolo) {
        if (play.batterTo === HOME) s.runEvents.push({ playID: play.id, runner: play.batterID, credited: play.batterID });
        s.runs += runsScored(play);
        return;
      }
      applySwaps(g, i, s);

      const recorded = {};
      for (const m of play.runners) if (!(m.from in recorded)) recorded[m.from] = m.playerID;
      if (!sameBases(recorded, s.bases) || s.outs + outsRecorded(play) > 3) s.needsReview.add(play.id);

      const credits = {};
      for (const [runner, batter] of Object.entries(s.runFor)) {
        if (play.runners.some(m => m.playerID === runner)) credits[runner] = batter;
      }
      if (Object.keys(credits).length) s.moveCredit[play.id] = credits;

      if (play.batterTo === HOME) s.runEvents.push({ playID: play.id, runner: play.batterID, credited: play.batterID });
      for (const m of play.runners) {
        if (m.to === HOME) s.runEvents.push({ playID: play.id, runner: m.playerID, credited: s.runFor[m.playerID] ?? m.playerID });
      }
      for (const m of play.runners) if (m.to === HOME || m.to === OUT) delete s.runFor[m.playerID];

      s.runs += runsScored(play);
      s.runsByInning[s.inning] = (s.runsByInning[s.inning] || 0) + runsScored(play);
      s.outs += outsRecorded(play);

      const holder = currentID(g, play.batterID);
      const idx = g.lineup.findIndex(p => p.id === holder);
      s.batterIndex = idx >= 0 ? (idx + 1) % g.lineup.length : (s.batterIndex + 1) % g.lineup.length;

      if (s.outs >= 3 || play.endsInning) {
        s.inning += 1;
        s.outs = 0;
        s.bases = {};
        s.runFor = {};
      } else {
        const next = {};
        for (const m of play.runners) if (ON_BASE.includes(m.to)) next[m.to] = m.playerID;
        if (ON_BASE.includes(play.batterTo)) next[play.batterTo] = play.batterID;
        s.bases = next;
      }
    });
    applySwaps(g, count, s);
    return s;
  }

  /// Re-derives each play's inning after an edit or delete changes where innings end.
  function renumberInnings(g) {
    for (let i = 0; i < g.plays.length; i++) g.plays[i].inning = state(g, i).inning;
  }

  function deletePlay(g, index) {
    if (index < 0 || index >= g.plays.length) return;
    g.plays.splice(index, 1);
    for (const sw of g.courtesySwaps || []) if (sw.beforePlay > index) sw.beforePlay -= 1;
    renumberInnings(g);
  }

  /// True when the last play is in the current inning (so the inning can be closed early).
  const canEndInning = g => g.plays.length > 0 && g.plays[g.plays.length - 1].inning === state(g).inning;

  const opponentTotal = g => Object.values(g.opponentRuns || {}).reduce((a, b) => a + b, 0);

  /// W / L / T once the game is final.
  function outcome(g) {
    if (!g.isFinal || g.isSolo) return null;
    const us = state(g).runs, them = opponentTotal(g);
    return us > them ? "W" : us < them ? "L" : "T";
  }

  const codes = (g, playerID) => g.plays.filter(p => p.batterID === playerID).map(p => resultCode(p.result)).join(", ");

  const DEFAULT_RULES = { secondScoresOnSingle: true, twoOutsRunOnContact: true };

  /// Where a runner on `b` usually ends up for `result`.
  function defaultDestination(b, result, bases, outs = 0, rules = DEFAULT_RULES) {
    if (isHit(result)) {
      let advance = totalBases(result);
      if (rules.twoOutsRunOnContact && outs === 2) advance += 1;
      if (rules.secondScoresOnSingle && result === "single" && b === SECOND) return HOME;
      return Math.min(b + advance, HOME);
    }
    if (result === "sacrificeFly") return b === THIRD ? HOME : b;
    if (result === "fieldersChoice") {
      // Forced runners move up; the lead forced runner is the one put out.
      const forced = [];
      for (const x of ON_BASE) { if (bases[x] == null) break; forced.push(x); }
      if (!forced.length) {
        // Nobody forced (a lone runner on 2nd or 3rd): the lead runner is the one put out.
        const lead = [...ON_BASE].reverse().find(x => bases[x] != null);
        return b === lead ? OUT : b;
      }
      if (!forced.includes(b)) return b;
      return b === forced[forced.length - 1] ? OUT : Math.min(b + 1, HOME);
    }
    if (result === "walk" || result === "reachedOnError") {
      const forced = b === FIRST ? true
        : b === SECOND ? bases[FIRST] != null
        : b === THIRD ? bases[FIRST] != null && bases[SECOND] != null : false;
      return forced ? Math.min(b + 1, HOME) : b;
    }
    return b;
  }

  const basesDescending = bases => Object.keys(bases).map(Number).sort((a, b) => b - a);

  /// A play with the standard runner advance for its result, as it would be saved without adjusting.
  function defaultPlay(g, result, s, batterID, outType = null, fielder = null, location = null, rules = DEFAULT_RULES) {
    // Batter makes the 3rd out: runners are stranded where they are.
    const thirdOut = s.outs === 2 && batterIsOut(result);
    let moves = basesDescending(s.bases).map(base => ({
      playerID: s.bases[base], from: base,
      to: thirdOut ? base : defaultDestination(base, result, s.bases, s.outs, rules),
    }));
    const batterTo = defaultBatterBase(result);
    const outs = (batterTo === OUT ? 1 : 0) + moves.filter(m => m.to === OUT).length;
    // If the play ends the inning (an FC for the 3rd out, say), no runs score on it.
    if (s.outs + outs >= 3) moves = moves.map(m => (m.to === HOME ? { ...m, to: m.from } : m));
    const runs = (batterTo === HOME ? 1 : 0) + moves.filter(m => m.to === HOME).length;
    const rbi = result === "reachedOnError" || (batterTo === OUT && outs >= 2) ? 0 : runs;
    const hasOutDetail = result === "out" || result === "sacrificeFly";
    return {
      id: newID(), inning: s.inning, batterID, result, batterTo, runners: moves, rbi, endsInning: false,
      outType: hasOutDetail ? (result === "sacrificeFly" ? "fly" : outType) : null,
      fielder: hasOutDetail ? fielder : null,
      location: location || null,
    };
  }

  /// Errors, FCs and inside-the-park home runs always ask "What happened?" (the batter can take extra
  /// bases or be thrown out); other hits ask with runners on, and outs when runners could advance or be
  /// doubled up. Walks, strikeouts, homers over the fence, HR outs, a sac fly with only a runner on 3rd
  /// and the 3rd out by the batter only go one way.
  function asksWhatHappened(result, s, overFence) {
    const occupied = Object.keys(s.bases).map(Number);
    switch (result) {
      case "reachedOnError": case "fieldersChoice": return true;
      case "homeRun": return !overFence;
      case "single": case "double": case "triple": return occupied.length > 0;
      case "sacrificeFly": return occupied.some(b => b !== THIRD) && s.outs < 2;
      case "out": return occupied.length > 0 && s.outs < 2;
      default: return false;
    }
  }

  /// What the runners (and batter, if unusual) did, e.g. "Mike → 3rd, Joe scored".
  function runnerSummary(g, play) {
    const parts = [...play.runners].sort((a, b) => b.from - a.from).flatMap(m => {
      if (m.to === m.from) return [];
      const n = nameFor(g, m.playerID);
      if (m.to === HOME) return [`${n} scored`];
      if (m.to === OUT) return [`${n} out`];
      return [`${n} → ${BASE_LABEL[m.to]}`];
    });
    if (play.batterTo === HOME && play.result !== "homeRun") parts.push("batter scored");
    if (isHit(play.result) && play.batterTo === OUT) parts.push("batter out on bases");
    return parts.length ? parts.join(", ") : null;
  }

  function describe(g, play) {
    let s = `${nameFor(g, play.batterID)} – ${detailTitle(play)}`;
    const o = outsRecorded(play);
    if (o === 2) s += " (DP)";
    if (o >= 3) s += " (TP)";
    if (play.rbi > 0) s += `, ${play.rbi} RBI`;
    if (play.endsInning) s += " (inning ended)";
    return s;
  }

  // ---------- Stat lines ----------

  const FIELDS = ["pa", "ab", "runs", "courtesyRuns", "hits", "singles", "doubles", "triples", "homeRuns", "rbi", "walks",
    "sacFlies", "roe", "fieldersChoices", "kLooking", "kSwinging", "kFoul", "hrOuts", "groundOuts", "flyOuts",
    "lineOuts", "popOuts", "doublePlays", "triplePlays"];
  const emptyLine = p => Object.assign({ player: p }, Object.fromEntries(FIELDS.map(f => [f, 0])));

  function record(l, p) {
    l.pa += 1;
    const o = outsRecorded(p);
    if (o === 2) l.doublePlays += 1;
    if (o >= 3) l.triplePlays += 1;
    if (isAtBat(p.result)) l.ab += 1;
    l.rbi += p.rbi;
    switch (p.result) {
      case "single": l.hits++; l.singles++; break;
      case "double": l.hits++; l.doubles++; break;
      case "triple": l.hits++; l.triples++; break;
      case "homeRun": l.hits++; l.homeRuns++; break;
      case "walk": l.walks++; break;
      case "reachedOnError": l.roe++; break;
      case "fieldersChoice": l.fieldersChoices++; break;
      case "out":
        if (p.outType === "ground") l.groundOuts++;
        else if (p.outType === "fly") l.flyOuts++;
        else if (p.outType === "line") l.lineOuts++;
        else if (p.outType === "pop") l.popOuts++;
        break;
      case "homeRunOut": l.hrOuts++; break;
      case "sacrificeFly": l.sacFlies++; break;
      case "strikeoutLooking": l.kLooking++; break;
      case "strikeoutSwinging": l.kSwinging++; break;
      case "strikeoutFoul": l.kFoul++; break;
    }
  }

  function statLines(g) {
    const players = allPlayers(g);
    const lines = new Map(players.map(p => [p.id, emptyLine(p)]));
    for (const p of g.plays) { const l = lines.get(p.batterID); if (l) record(l, p); }
    for (const e of state(g).runEvents) {
      const c = lines.get(e.credited); if (c) c.runs += 1;
      if (e.runner !== e.credited) { const r = lines.get(e.runner); if (r) r.courtesyRuns += 1; }
    }
    const extraIDs = new Set((g.extras || []).map(p => p.id));
    return players.map(p => lines.get(p.id)).filter(l => !extraIDs.has(l.player.id) || l.courtesyRuns > 0);
  }

  function totals(g) {
    const t = emptyLine({ id: "team", name: "Team" });
    for (const l of statLines(g)) for (const f of FIELDS) t[f] += l[f];
    return t;
  }

  // ---------- Scorebook ----------

  /// Everything a paper scorebook shows: per batter, per inning, each trip to the plate.
  function book(g) {
    const s = state(g);
    const entries = {};   // batterID → inning → [entry]
    const outsInInning = {};
    const st = state(g);  // for runFor credits
    g.plays.forEach(p => {
      // Runners first (lead runner first), so a force / double play numbers the outs in order.
      for (const m of [...p.runners].sort((a, b) => b.from - a.from)) {
        const credited = st.moveCredit[p.id]?.[m.playerID] ?? m.playerID;
        const list = entries[credited]?.[p.inning];
        if (!list || !list.length) continue;
        const last = list[list.length - 1];
        last.final = m.to;
        if (m.to === OUT) {
          outsInInning[p.inning] = (outsInInning[p.inning] || 0) + 1;
          last.outNumber = outsInInning[p.inning];
        } else {
          last.farthest = Math.max(last.farthest, m.to);
        }
        if (credited !== m.playerID) last.courtesyRunner = nameFor(g, m.playerID);
      }
      const e = { id: p.id, code: bookCode(p), rbi: p.rbi, final: p.batterTo, batterOutOnPlay: batterIsOut(p.result),
        courtesyRunner: null, mark: scorebookMark(p), corner: cornerMark(p), circled: circledLabel(p),
        farthest: p.batterTo === OUT ? OUT : p.batterTo, outNumber: null, endsInning: false };
      if (p.batterTo === OUT) {
        outsInInning[p.inning] = (outsInInning[p.inning] || 0) + 1;
        e.outNumber = outsInInning[p.inning];
      }
      e.endsInning = (outsInInning[p.inning] || 0) >= 3 || !!p.endsInning;
      ((entries[p.batterID] ||= {})[p.inning] ||= []).push(e);
    });
    const lastInning = Math.max(...g.plays.map(p => p.inning), ...Object.keys(g.opponentRuns || {}).map(Number), 1);
    return { innings: Array.from({ length: lastInning }, (_, i) => i + 1), entries, currentInning: s.inning, runsByInning: s.runsByInning };
  }

  // ---------- What the website shows (same shape the app publishes) ----------

  function publishedLine(l) {
    const out = { name: l.player.name };
    if (l.player.member) out.member = l.player.member;
    return Object.assign(out, {
      pa: l.pa, ab: l.ab, r: l.runs, crr: l.courtesyRuns, h: l.hits, b1: l.singles, b2: l.doubles, b3: l.triples,
      hr: l.homeRuns, rbi: l.rbi, bb: l.walks, sf: l.sacFlies, roe: l.roe, fc: l.fieldersChoices,
      kl: l.kLooking, ks: l.kSwinging, kf: l.kFoul, hro: l.hrOuts, go: l.groundOuts, fo: l.flyOuts,
      lo: l.lineOuts, po: l.popOuts, dp: l.doublePlays, tp: l.triplePlays,
    });
  }

  function publishedGame(g) {
    const s = state(g);
    const innings = book(g).innings;
    const lastInning = innings[innings.length - 1] || 1;
    const out = { id: g.id, date: g.date, team: g.team, opponent: g.opponent, isFinal: !!g.isFinal, isHome: !!g.isHome };
    if (g.event) { out.event = g.event.name; out.eventKind = g.event.kind; }
    out.us = s.runs;
    out.them = opponentTotal(g);
    const oc = outcome(g);
    if (oc) out.outcome = oc;
    out.usByInning = Array.from({ length: lastInning }, (_, i) => s.runsByInning[i + 1] || 0);
    out.themByInning = Array.from({ length: lastInning }, (_, i) => (g.opponentRuns || {})[i + 1] || 0);
    out.lines = statLines(g).map(publishedLine);
    out.totals = publishedLine(totals(g));
    out.spray = g.plays.flatMap(p => {
      const kind = sprayKind(p);
      if (!kind) return [];
      const d = { name: nameFor(g, p.batterID) };
      const m = player(g, p.batterID)?.member;
      if (m) d.member = m;
      return [Object.assign(d, { angle: p.location.angle, distance: p.location.distance, kind })];
    });
    out.plays = g.plays.map(p => {
      const r = { inning: p.inning, text: describe(g, p) };
      const rs = runnerSummary(g, p);
      if (rs) r.runners = rs;
      return r;
    });
    if (!g.isFinal) {
      const live = { inning: s.inning, outs: s.outs, batter: g.lineup.length ? g.lineup[s.batterIndex].name : "" };
      for (const [b, key] of [[FIRST, "first"], [SECOND, "second"], [THIRD, "third"]]) {
        if (s.bases[b] != null) live[key] = nameFor(g, s.bases[b]);
      }
      out.live = live;
    }
    return out;
  }

  // ---------- "What happened?" (where the batter and each runner ended up) ----------

  /// Starts from `play` (a fresh default or a recorded play); runners come from the bases in `s`.
  function makeOutcome(g, s, play, rules = DEFAULT_RULES) {
    const slots = [{ id: play.batterID, name: nameFor(g, play.batterID), start: 0, forName: null }];
    const dest = { [play.batterID]: play.batterTo };
    for (const base of Object.keys(s.bases).map(Number).sort((a, b) => a - b)) {
      const id = s.bases[base];
      slots.push({ id, name: nameFor(g, id), start: base, forName: s.runFor[id] ? nameFor(g, s.runFor[id]) : null });
      const recorded = play.runners.find(m => m.playerID === id)?.to;
      dest[id] = recorded ?? defaultDestination(base, play.result, s.bases, s.outs, rules);
    }
    return { result: play.result, outType: play.outType, outsBefore: s.outs, slots, dest, rbiOffset: 0, runsBeatTheOut: true };
  }

  const oTo = (o, slot) => o.dest[slot.id] ?? (slot.start === 0 ? defaultBatterBase(o.result) : slot.start);

  function oOptions(o, slot) {
    if (slot.start === 0) {
      if (batterIsOut(o.result)) return [OUT];
      if (o.result === "walk") return [FIRST];
      if (isHit(o.result)) return [OUT, FIRST, SECOND, THIRD, HOME];
      return [FIRST, SECOND, THIRD, HOME];
    }
    return BASES.filter(b => b === OUT || b >= slot.start);
  }

  const oOuts = o => o.slots.filter(sl => oTo(o, sl) === OUT).length;
  const oInningOver = o => o.outsBefore + oOuts(o) >= 3;
  /// Fly, line and pop outs (and sac flies): the catch takes away every force.
  const oCaught = o => o.result === "sacrificeFly" || (o.result === "out" && ["fly", "line", "pop"].includes(o.outType));
  function oForcedStarts(o) {
    if (oCaught(o) || ["walk", "homeRunOut", "strikeoutLooking", "strikeoutSwinging", "strikeoutFoul"].includes(o.result)) return new Set();
    const starts = new Set();
    for (const base of [1, 2, 3]) {
      if (!o.slots.some(sl => sl.start === base)) break;
      starts.add(base);
    }
    return starts;
  }

  /// { kind: "counts" } | { kind: "noRuns", why } | { kind: "timePlay" }
  function oRunRule(o) {
    if (!oInningOver(o) || !o.slots.some(sl => oTo(o, sl) === HOME)) return { kind: "counts" };
    if (oCaught(o)) return oOuts(o) === 1 ? { kind: "noRuns", why: "the catch was the 3rd out" } : { kind: "timePlay" };
    if (oTo(o, o.slots[0]) === OUT && batterIsOut(o.result)) return { kind: "noRuns", why: "the batter was out before reaching 1st" };
    const forced = oForcedStarts(o);
    if (o.slots.some(sl => sl.start !== 0 && oTo(o, sl) === OUT && forced.has(sl.start))) {
      return { kind: "noRuns", why: "the 3rd out was a force out" };
    }
    return { kind: "timePlay" };
  }

  function oRunsCount(o) {
    const r = oRunRule(o);
    return r.kind === "counts" ? true : r.kind === "noRuns" ? false : o.runsBeatTheOut;
  }

  /// Where a player goes in the book: a run that doesn't count leaves them stranded.
  function oFinal(o, slot) {
    const b = oTo(o, slot);
    if (b !== HOME || oRunsCount(o)) return b;
    return slot.start === 0 ? THIRD : slot.start;
  }

  const oRuns = o => o.slots.filter(sl => oFinal(o, sl) === HOME).length;
  /// No RBI on an error or when the batter hits into a double / triple play.
  const oAutoRBI = o => (o.result === "reachedOnError" || (oTo(o, o.slots[0]) === OUT && oOuts(o) >= 2) ? 0 : oRuns(o));
  const oRBI = o => Math.min(4, Math.max(0, oAutoRBI(o) + o.rbiOffset));

  function oProblem(o) {
    if (o.outsBefore + oOuts(o) > 3) return "That's more than 3 outs.";
    if (oInningOver(o)) return null;   // once the 3rd out is made, where the others stopped doesn't matter
    const movers = o.slots.filter(sl => oTo(o, sl) !== OUT);
    for (let i = 0; i + 1 < movers.length; i++) {
      const a = oTo(o, movers[i]), b = oTo(o, movers[i + 1]);
      if (b <= a && !(a === HOME && b === HOME)) return "Runners can't pass each other or share a base.";
    }
    return null;
  }

  function oSummary(o) {
    const parts = [];
    const outs = oOuts(o), runs = oRuns(o);
    if (outs === 1) parts.push("1 out");
    else if (outs === 2) parts.push("Double play");
    else if (outs >= 3) parts.push("Triple play");
    if (runs > 0) parts.push(`${runs} run${runs === 1 ? "" : "s"}`);
    if (oInningOver(o)) parts.push("Inning over");
    return parts.length ? parts.join(" · ") : "Nobody out, nobody scored";
  }

  /// Sets one player's base, then nudges the others so nobody passes or shares a base:
  /// runners ahead move up, players behind fall back (never behind where they started).
  function oSet(o, slot, b) {
    o.dest[slot.id] = b;
    o.rbiOffset = 0;
    const i = o.slots.findIndex(sl => sl.id === slot.id);
    if (b === OUT || i < 0) return;

    let limit = b;
    for (const ahead of o.slots.slice(i + 1)) {
      if (oTo(o, ahead) === OUT) continue;
      if (limit === HOME) o.dest[ahead.id] = HOME;
      else if (oTo(o, ahead) <= limit) o.dest[ahead.id] = Math.min(limit + 1, HOME);
      limit = oTo(o, ahead);
    }

    limit = b;
    for (const behind of o.slots.slice(0, i).reverse()) {
      if (oTo(o, behind) === OUT) continue;
      if (limit === HOME) break;
      const lowest = Math.max(behind.start, 1);
      if (oTo(o, behind) >= limit && limit - 1 >= lowest) o.dest[behind.id] = limit - 1;
      limit = oTo(o, behind);
    }
  }

  /// `play` with this outcome's batter, runners and RBIs filled in.
  function oApply(o, play) {
    const p = { ...play };
    p.batterTo = oFinal(o, o.slots[0]);
    p.runners = o.slots.slice(1).map(sl => ({ playerID: sl.id, from: sl.start, to: oFinal(o, sl) }));
    p.rbi = oRBI(o);
    return normalizedForSacrifice(p, o.outsBefore);
  }

  const Outcome = {
    make: makeOutcome, to: oTo, options: oOptions, outs: oOuts, inningOver: oInningOver, runRule: oRunRule,
    final: oFinal, runs: oRuns, autoRBI: oAutoRBI, rbi: oRBI, problem: oProblem, summary: oSummary, set: oSet, apply: oApply,
  };

  // ---------- Editing helpers used by the scoring screen ----------

  /// Adds a courtesy runner for whoever is on `base` now (recorded before the next play).
  function addCourtesyRunner(g, runner, base) {
    const current = state(g).bases[base];
    if (!current || current === runner.id) return false;
    if (!player(g, runner.id)) (g.extras ||= []).push(runner);
    (g.courtesySwaps ||= []).push({ id: newID(), beforePlay: g.plays.length, base, originalID: current, runnerID: runner.id });
    return true;
  }

  /// Undo the most recent action: a courtesy runner put in after the last play, an early inning end, or the last play.
  function undo(g) {
    const swaps = g.courtesySwaps || [];
    for (let i = swaps.length - 1; i >= 0; i--) {
      if (swaps[i].beforePlay === g.plays.length) { swaps.splice(i, 1); return true; }
    }
    if (!g.plays.length) return false;
    const last = g.plays[g.plays.length - 1];
    if (last.endsInning) last.endsInning = false;
    else g.plays.pop();
    return true;
  }

  function endInning(g) {
    if (!canEndInning(g)) return false;
    g.plays[g.plays.length - 1].endsInning = true;
    return true;
  }

  const api = {
    OUT, FIRST, SECOND, THIRD, HOME, BASES, ON_BASE, BASE_LABEL,
    RESULTS, RESULT_ORDER, OUT_TYPES, OUT_TYPE_ORDER, FIELDERS, FIELDER_ORDER, DEFAULT_RULES,
    newID, statKey, isHit, isAtBat, batterIsOut, isStrikeout, totalBases, resultCode, resultTitle, buttonTitle, defaultBatterBase,
    pointX, pointY, fromXY, isFair, isOverFence, suggestedFielder,
    runsScored, outsRecorded, normalizedForSacrifice, bookCode, scorebookMark, cornerMark, circledLabel, detailTitle, sprayKind,
    allPlayers, player, nameFor, currentID, state, renumberInnings, deletePlay, canEndInning, opponentTotal, outcome, codes,
    defaultDestination, defaultPlay, asksWhatHappened, runnerSummary, describe,
    statLines, totals, book, publishedGame, Outcome, addCourtesyRunner, undo, endInning,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.StatEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
