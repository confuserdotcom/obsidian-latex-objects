// Property tests on random documents:  node fuzz.js [docs] [seed]
// Every finder and edit is checked against invariants and a brute-force reference, at every
// cursor position of thousands of seeded random notes built from the nastiest tokens.
// Deterministic: a failure prints its seed, document and cursor so it can be replayed.
const assert = require("assert");
const C = require("./main.js").core;

const DOCS = +process.argv[2] || 3000, SEED = +process.argv[3] || 20260927;
function rng(seed) { // mulberry32
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const TOKENS = ["$", "$", "$$", "\\", "\\$", "\\\\", "(", ")", "[", "]", "{", "}", "\\{", "\\}", "\\frac", "\\sqrt", "[n]", "\\alpha ", "\\mathbb", "\\begin{a}", "\\end{a}",
  "\\begin{b*}", "\\end{b*}", "\\left(", "\\right)", "\\left[", "\\right]", "\\left\\{", "\\right\\}", "\\left[\\!\\left[", "\\right] \\!\\right]", "\\left]\\!\\left]", "\\right[ \\!\\right[", "`", "```", "\n```\n", "\n````\n", "\n~~~ js\n", "\\big(", "\\Bigr)", "\\bigl[", "\\big]", "x", "yz", " ", " ", "é", "∀", "😀", "𝔸", "\n> ", "\n> > ", "\n> [!note]\n> ", "\n", "\n", "\n", "\n\n", "\n".repeat(30)];
function doc(r) {
  let s = "";
  const n = 1 + Math.floor(r() * (r() < 0.1 ? 400 : 40));
  for (let i = 0; i < n; i++) s += TOKENS[Math.floor(r() * TOKENS.length)];
  return s;
}

const at = (line, ch) => ({ line, ch });
const cmp = (p, q) => p.line - q.line || p.ch - q.ch;
const within = (lines, p) => p.line >= 0 && p.line < lines.length && p.ch >= 0 && p.ch <= lines[p.line].length;
const text = (lines, p, q) => (p.line === q.line ? lines[p.line].slice(p.ch, q.ch)
  : [lines[p.line].slice(p.ch), ...lines.slice(p.line + 1, q.line), lines[q.line].slice(0, q.ch)].join("\n"));
function apply(lines, changes) {
  const off = p => lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.ch;
  const cs = changes.map(c => [off(c.from), off(c.to), c.text]).sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < cs.length; i++) assert(cs[i][0] >= cs[i - 1][1], "overlapping changes");
  return cs.reverse().reduce((d, [f, t, s]) => d.slice(0, f) + s + d.slice(t), lines.join("\n"));
}

// Independent reference for pick: sort candidates by an explicit tuple.
function refPick(spans, pos, which) {
  const covering = spans.filter(s => cmp(s.a, pos) <= 0 && cmp(pos, s.b) < 0);
  const reach = s => (cmp(s.a, pos) > 0 ? s.a.line - pos.line : pos.line - s.b.line) <= C.CONFIG.seekLines;
  const below = spans.filter(s => cmp(s.a, pos) > 0 && reach(s)), above = spans.filter(s => cmp(s.b, pos) <= 0 && reach(s));
  if (which === "next") return below.sort((x, y) => cmp(x.a, y.a))[0] || null;
  if (which === "last") return above.sort((x, y) => cmp(y.b, x.b))[0] || null;
  if (covering.length) return covering.sort((x, y) => cmp(y.a, x.a))[0];
  const tuple = s => {
    const b = cmp(s.a, pos) > 0, p = b ? s.a : at(s.b.line, s.b.ch - 1);
    return [Math.abs(p.line - pos.line), Math.abs(p.ch - pos.ch), b ? 0 : 1];
  };
  const all = [...below, ...above].sort((x, y) => {
    const [tx, ty] = [tuple(x), tuple(y)];
    for (let i = 0; i < 3; i++) if (tx[i] !== ty[i]) return tx[i] - ty[i];
    return tx[2] === 0 ? cmp(x.a, y.a) : cmp(y.b, x.b);
  });
  return all[0] || null;
}

// only indentation / blockquote markers ("> ", "> > ") — not content (independent of main.js)
const quoteOnly = str => /^[ \t]*(>[ \t]*)*$/.test(str);

const stats = { docs: 0, spans: 0, picks: 0, ranges: 0, edits: 0 };
const r = rng(SEED);
let current = "";
try {
  for (let d = 0; d < DOCS; d++) {
    const src = doc(r), lines = src.split("\n");
    stats.docs++;
    // commands: inside maths, the name is \name, arguments in order and inside their command,
    // ending on a {…}; commands and arguments never cross
    current = `doc ${d} commands ${JSON.stringify(src)}`;
    const maths = C.mathSpans(lines), cmds = C.commandSpans(lines), args = cmds.flatMap(s => s.args);
    for (const s of cmds) {
      assert(maths.some(m => cmp(m.ae, s.a) <= 0 && cmp(s.b, m.bs) <= 0), "command outside maths");
      assert.strictEqual(text(lines, s.a, s.ae), "\\" + s.name, "command name");
      let prev = s.ae;
      for (const g of s.args) {
        assert(cmp(prev, g.a) <= 0 && cmp(g.a, g.ae) < 0 && cmp(g.ae, g.bs) <= 0 && cmp(g.bs, g.b) < 0, "argument out of order");
        assert.strictEqual(text(lines, g.a, g.ae) + text(lines, g.bs, g.b), g.opt ? "[]" : "{}", "argument delimiters");
        assert.strictEqual(g.cmd, s, "argument's command");
        prev = g.b;
      }
      if (s.args.length) assert(!s.args[s.args.length - 1].opt, "command ends on an optional argument");
      assert.deepStrictEqual(s.b, s.args.length ? s.args[s.args.length - 1].b : s.ae, "command end");
    }
    for (const list of [cmds, args]) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const [x, y] = [list[i], list[j]];
      const disjoint = cmp(x.b, y.a) <= 0 || cmp(y.b, x.a) <= 0;
      const nested = (cmp(x.a, y.a) <= 0 && cmp(y.b, x.b) <= 0) || (cmp(y.a, x.a) <= 0 && cmp(x.b, y.b) <= 0);
      assert(disjoint || nested, "crossing commands / arguments");
    }
    // %: from any delimiter, its partner leads back to it
    current = `doc ${d} partner ${JSON.stringify(src)}`;
    for (let l = 0; l < lines.length; l++) for (let ch = 0; ch < lines[l].length; ch++) {
      const d1 = C.delimAt(lines, at(l, ch));
      if (!d1) continue;
      assert(C.mayBeDelim(lines[l], ch), "mayBeDelim rejects a delimiter position");
      current = `doc ${d} partner @${l}:${ch} ${JSON.stringify(src)}`;
      const d2 = C.delimAt(lines, d1.there[0]);
      assert(d2, "partner is not a delimiter");
      assert.deepStrictEqual([d2.here, d2.there], [d1.there, d1.here], "partner does not lead back");
      stats.picks++;
    }
    for (const obj of ["math", "env", "paren", "brace", "square"]) {
      current = `doc ${d} ${obj} ${JSON.stringify(src)}`;
      const spans = C.SPANS[obj](lines);
      stats.spans += spans.length;

      // structure: ordered positions inside the doc, delimiters are what they claim to be
      for (const s of spans) {
        for (const p of [s.a, s.ae, s.bs, s.b]) assert(within(lines, p), "position outside the doc");
        assert(cmp(s.a, s.ae) < 0 && cmp(s.ae, s.bs) <= 0 && cmp(s.bs, s.b) < 0, "span out of order");
        const open = text(lines, s.a, s.ae), close = text(lines, s.bs, s.b);
        if (obj === "math") {
          const delim = s.kind === "display" ? "$$" : "$";
          assert(open === delim && close === delim, `math delimiters ${open} ${close}`);
          if (s.kind === "inline") assert(s.a.line === s.b.line, "inline maths across lines");
          const prev = lines[s.a.line][s.a.ch - 1];
          assert(prev !== "\\" || lines[s.a.line][s.a.ch - 2] === "\\", "escaped $ used as delimiter");
        } else if (obj === "env") {
          assert(open === "\\begin{" + s.name + "}" && close === "\\end{" + s.name + "}", "env names differ");
        } else {
          const iv = t => /^\\(left|right)([[\]])\s*\\!\s*\\\1\2$/.test(t);
          // the size: \left / \right, or any \big \Big \bigg \Bigg (l / r), or none
          const sz = /^\\(?:(left|right)|[bB]igg?[lr]?)\s*/, kind = t => { const m = sz.exec(t); return m ? (m[1] ? "left" : "big") : ""; };
          const bare = t => t.replace(sz, "");
          if (iv(open) || iv(close)) assert(iv(open) && iv(close) && open.startsWith("\\left") && close.startsWith("\\right"), `interval pair ${open}${close}`);
          else assert({ "(": ")", "[": "]", "{": "}", "\\{": "\\}" }[bare(open)] === bare(close) && kind(open) === kind(close), `bracket pair ${open}${close}`);
          const want = { paren: "(", brace: "{", square: "[" }[obj], first = iv(open) ? "[" : bare(open).replace("\\", "");
          assert(s.type === want && first === want, `${obj} got ${open}`);
        }
      }
      // no maths delimiter inside a ``` / ~~~ code block (fence state computed independently;
      // a fence line inside an open $$ block is maths text, not a fence)
      if (obj === "math") {
        const inFence = [];
        // CommonMark: a fence closes with the same character, at least as long, nothing after
        // it; a fence opened in a blockquote ends with the quote
        let fence = null;
        const displayOpenAt = r => spans.some(s => s.kind === "display" && s.a.line < r && r <= s.b.line);
        lines.forEach((ln, i) => {
          const q = /^[ \t]*((?:>[ \t]*)*)(.*)$/.exec(ln), depth = (q[1].match(/>/g) || []).length, f = /^(`{3,}|~{3,})(.*)$/.exec(q[2]);
          if (fence && depth < fence.depth) fence = null;
          if (fence) {
            inFence[i] = true;
            if (f && f[1][0] === fence.c && f[1].length >= fence.n && !f[2].trim()) fence = null;
            return;
          }
          const opens = f && !displayOpenAt(i) && !(f[1][0] === "`" && f[2].includes("`"));
          inFence[i] = !!opens;
          if (opens) fence = { c: f[1][0], n: f[1].length, depth };
        });
        for (const s of spans) assert(!inFence[s.a.line] && !inFence[s.b.line], "maths found inside a code block");
      }

      // any two spans are disjoint or nested (never crossing); maths never nest at all
      for (let i = 0; i < spans.length; i++) for (let j = i + 1; j < spans.length; j++) {
        const [x, y] = [spans[i], spans[j]];
        const disjoint = cmp(x.b, y.a) <= 0 || cmp(y.b, x.a) <= 0;
        const nested = (cmp(x.a, y.a) <= 0 && cmp(y.b, x.b) <= 0) || (cmp(y.a, x.a) <= 0 && cmp(x.b, y.b) <= 0);
        assert(disjoint || (obj !== "math" && nested), "crossing / overlapping spans");
      }

      // pick at EVERY cursor position, all three modes, against the reference
      for (let l = 0; l < lines.length; l++) for (let ch = 0; ch <= lines[l].length; ch++) {
        const pos = at(l, ch);
        for (const which of ["cur", "next", "last"]) {
          current = `doc ${d} ${obj} ${which} @${l}:${ch} ${JSON.stringify(src)}`;
          assert.strictEqual(C.pick(spans, pos, which), refPick(spans, pos, which));
          stats.picks++;
        }
      }

      // 3inB / 3ilB: brute force — hop count times to the closest span past the one counted
      // (starting at / ending before its edge, so nested ones are skipped); count 1 = pick
      for (let l = 0; l < lines.length; l++) for (let ch = 0; ch <= lines[l].length; ch += 3) {
        const pos = at(l, ch);
        for (const which of ["next", "last"]) for (let count = 1; count <= 3; count++) {
          current = `doc ${d} ${obj} ${count}${which} @${l}:${ch} ${JSON.stringify(src)}`;
          const fwd = which === "next", near = s => (fwd ? s.a.line - pos.line : pos.line - s.b.line) <= C.CONFIG.seekLines;
          let ref = null;
          for (let k = 0; k < count; k++) {
            const ok = spans.filter(s => near(s) && (fwd ? cmp(s.a, pos) > 0 && (!ref || cmp(s.a, ref.b) >= 0) : cmp(pos, s.b) >= 0 && (!ref || cmp(s.b, ref.a) <= 0)));
            ref = ok.reduce((m, s) => (!m || (fwd ? cmp(s.a, m.a) < 0 : cmp(s.b, m.b) > 0) ? s : m), null);
            if (!ref) break;
          }
          if (count === 1) assert.strictEqual(ref, C.pick(spans, pos, which));
          assert.deepStrictEqual(C.countPick(spans, lines, pos, which, true, count), ref && C.range(ref, lines, true));
          stats.picks++;
        }
      }

      // ]m / [m: brute force — sort every start, take the count-th after / before the cursor
      for (let l = 0; l < lines.length; l++) for (let ch = 0; ch <= lines[l].length; ch++) {
        const pos = at(l, ch), starts = spans.map(s => s.a).sort(cmp);
        for (const count of [1, 2, 3]) {
          current = `doc ${d} ${obj} jump x${count} @${l}:${ch} ${JSON.stringify(src)}`;
          const fwd = starts.filter(p => cmp(p, pos) > 0), back = starts.filter(p => cmp(p, pos) < 0).reverse();
          const want = [fwd, back].map(c => (c.length ? c[Math.min(count, c.length) - 1] : null));
          const got = [true, false].map(f => { const s = C.jump(spans, pos, f, count); return s && s.a; });
          assert.deepStrictEqual(got, want);
          stats.picks++;
        }
      }

      // grow: from what each object shows in visual mode, the result is strictly bigger and the
      // SMALLEST such one (brute force by size), and repeating always ends (no cycles)
      const view = r => (r.linewise ? { start: r.start, last: r.end } : (e => e && { start: r.start, last: e })(C.visualEnd(lines, r.start, r.end)));
      const size = v => [v.last.line - v.start.line, v.last.ch - v.start.ch];
      for (const inner of [true, false]) for (const s of spans) {
        current = `doc ${d} ${obj} grow ${inner} ${JSON.stringify(src)}`;
        let sel = view(C.range(s, lines, inner));
        for (let steps = 0; sel; steps++) {
          assert(steps <= spans.length, "grow never stops");
          const r = C.grow(spans, lines, sel, inner);
          const bigger = spans.map(x => view(C.range(x, lines, inner))).filter(v => v && cmp(v.start, sel.start) <= 0 && cmp(v.last, sel.last) >= 0 && (cmp(v.start, sel.start) || cmp(v.last, sel.last)));
          if (!r) { assert.strictEqual(bigger.length, 0, "grow missed a bigger one"); break; }
          const v = view(r);
          assert(v && cmp(v.start, sel.start) <= 0 && cmp(v.last, sel.last) >= 0 && (cmp(v.start, sel.start) || cmp(v.last, sel.last)), "grow is not bigger");
          for (const o of bigger) assert(cmp(o.start, v.start) <= 0 && cmp(o.last, v.last) >= 0, "grow skipped a smaller one");
          sel = v;
        }
      }

      // ranges: well-formed, inner inside around, linewise ranges cover whole lines
      for (const s of spans) {
        current = `doc ${d} ${obj} range ${JSON.stringify(src)}`;
        const inner = C.range(s, lines, true), around = C.range(s, lines, false);
        for (const g of [inner, around]) {
          assert(within(lines, g.start) && within(lines, g.end) && cmp(g.start, g.end) <= 0, "bad range");
          if (g.linewise) assert(g.start.ch === 0 && g.end.ch === lines[g.end.line].length, "linewise not whole lines");
        }
        assert(cmp(around.start, inner.start) <= 0 && cmp(inner.end, around.end) <= 0, "inner outside around");
        if (!inner.linewise) assert(cmp(s.ae, inner.start) <= 0 || inner.start.ch === 0, "inner starts before the opener");
        // visual end: inside the range and never on the low half of a surrogate pair
        for (const g of [inner, around]) {
          const e = C.visualEnd(lines, g.start, g.end);
          if (!e) continue;
          assert(cmp(g.start, e) <= 0 && cmp(e, g.end) < 0, "visual end outside the range");
          const c = lines[e.line].charCodeAt(e.ch), prev = lines[e.line].charCodeAt(e.ch - 1);
          assert(!(c >= 0xdc00 && c <= 0xdfff && prev >= 0xd800 && prev <= 0xdbff), "visual end splits a surrogate pair");
          // an astral character is only ever the last selected one when it is the only one
          if (c >= 0xd800 && c <= 0xdbff) assert.deepStrictEqual(e, g.start, "visual ends on an astral char after others");
        }
        stats.ranges += 2;
      }

      // edits apply cleanly (no overlap); star and inline toggle are their own inverse
      for (const s of spans) {
        current = `doc ${d} ${obj} edits ${JSON.stringify(src)}`;
        for (const f of [C.unwrapChanges, C.deleteChanges]) apply(lines, f(lines, s));
        if (obj === "math") {
          apply(lines, C.toggleChanges(lines, s));
          if (s.kind === "display") {
            const ch = C.alignChanges(lines, s);
            if (!ch) continue;
            const out = apply(lines, ch).split("\n");
            // in a quote / callout every line the align wrote keeps the > prefix
            const P = lines[s.a.line].slice(0, s.a.ch);
            if (/^[ \t]*(>[ \t]*)+$/.test(P)) {
              const start = out.indexOf(P + "\\begin{align}"), end = out.indexOf(P + "\\end{align}", start);
              assert(start > 0 && end > start, "align lines lost their prefix");
              for (let k = start; k <= end; k++) assert(out[k].startsWith(P.trimEnd()), "align line lost its > prefix");
            }
          }
          const inner = text(lines, s.ae, s.bs), line = lines[s.a.line];
          const inText = !quoteOnly(line.slice(0, s.a.ch)) || line.slice(s.b.ch).trim();
          if (s.kind === "inline" && inner && inner === inner.trim() && inText) {
            const once = apply(lines, C.toggleChanges(lines, s)).split("\n");
            const back = C.mathSpans(once).find(x => x.kind === "display" && cmp(x.a, s.a) === 0);
            if (back) assert.strictEqual(apply(once, C.toggleChanges(once, back)), src, "toggle twice changed the note");
          }
          // unwrap keeps the inside text
          const out = apply(lines, C.unwrapChanges(lines, s));
          for (const piece of text(lines, s.ae, s.bs).split("\n").filter(x => !quoteOnly(x))) assert(out.includes(piece), "unwrap lost text");
        }
        if (obj === "env") {
          const once = apply(lines, C.starChanges(s)).split("\n");
          const back = C.envSpans(once).find(x => cmp(x.a, s.a) === 0);
          assert(back, "starred env not found again");
          assert.strictEqual(apply(once, C.starChanges(back)), src, "star twice changed the note");
        }
        stats.edits++;
      }
    }
  }
} catch (e) {
  console.log(`FAIL  seed ${SEED}\n  ${current}\n  ${e.message.split("\n").slice(0, 6).join("\n  ")}`);
  process.exit(1);
}
console.log(`ok — ${stats.docs} docs, ${stats.spans} spans, ${stats.picks} picks, ${stats.ranges} ranges, ${stats.edits} edits checked (seed ${SEED})`);
