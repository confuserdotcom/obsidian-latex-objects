// Real Vim text objects for maths, LaTeX environments, brackets and commands — they work with every
// operator (d c y > gU …), in visual mode and with `.` repeat:
//   im am   inm anm   ilm alm    maths   $…$ / $$…$$        (m = maths)
//   iM aM   inM anM   ilM alM    display $$…$$ only (skips the $…$ on the way)
//   ie ae   ine ane   ile ale    \begin{…} … \end{…}
//   ib ab   inb anb   ilb alb    ( )  \left( \right)          (n = next, l = last)
//   iB aB   inB anB   ilB alB    { }  \{ \}  \left\{ \right\}
//   ir ar   inr anr   ilr alr    [ ]  \left[ \right]  ⟦a; b⟧ intervals
//   ic ac   inc anc   ilc alc    \name{…}[…]{…}: ic = one argument (on the name: the first), ac = the command
// Every object SEEKS like mini.ai: the one around the cursor, else the CLOSEST one above or
// below, within 50 lines. In visual mode, repeating one (vie ie ie) grows to the enclosing one.
//   ]m [m   ]M [M   ]e [e   ]( [(   ]{ [{   jump to the next / previous maths, \begin, ( ), { } (counts, d]m …)
//   ; ,   repeat the last of those jumps (, the other way) until an f F t T takes them back
//   ]c [c   ]a [a   ]C [C   next / previous command, argument (lands inside), command by name (asks for it)
//   %   on \begin \end, \left \right, $ $$: to the partner (marked while the cursor is on one); else Vim's %
// Counts: 3iB = 3rd enclosing, 3inB / 3ilB = 3rd next / previous at the same level (nested
// ones skipped), with operators too (d2iB, and . replays it). In visual with a selection,
// inB / ilB step INTO it (first / last block inside), iB steps back out.
//   ds cs on b B r ( ) { } [ ] c    surround that seeks, knows \left \right, and dsc / csc commands
// y > gU … flash what they hit for a moment. Plus editing commands (unwrap, delete, toggle,
// align, rename, star, size; delete / rename / wrap in a command) to bind to keys or call
// from a vimrc with :obcommand.
//
// Works with Obsidian's built-in Vim mode and with the Vim Motions plugin; ds / cs on brackets
// need Vim Motions (they extend its surround). Keymaps registered from Lua or a vimrc cancel a
// pending operator and only know fixed delimiter pairs, so this registers straight into the
// CodeMirror Vim engine:
//
//   d i n m ──► CM Vim keymap "inm" ──► motion "latexObj" {obj:'math', inner, which:'next'}
//                                           │ spans(lines) ─► pick(cur/next/last) ─► range()
//                                           ▼
//                        [start, end]  (+ linewise flags) ──► Vim runs d / c / y / visual
//
// Vim Motions rebuilds its keymap on config reload, which can drop ours: register() is
// idempotent and re-runs after every reload, on every note switch and when a setting changes.
// All positions are {line, ch} (0-based, UTF-16 — the same units CodeMirror and Obsidian use).

// eslint-disable-next-line @typescript-eslint/no-require-imports -- no bundler: main.js is the plugin, loaded as CommonJS
const obsidian = (() => { try { return require("obsidian"); } catch { return {}; } })(); // node tests
const { Plugin = class {}, PluginSettingTab = class {}, Setting = class {}, Notice = class {} } = obsidian;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- no bundler: Obsidian provides @codemirror/* at runtime
const cm6 = name => { try { return require(name); } catch { return null; } }; // null under node
const CMState = cm6("@codemirror/state"), CMView = cm6("@codemirror/view");

// ─── Pure finders ─────────────────────────────────────────────────────────────
// A span: { kind, a, ae, bs, b } = opener start, opener end, closer start, closer end
// (ends exclusive). Inside is [ae, bs), whole thing is [a, b).

const cmp = (p, q) => p.line - q.line || p.ch - q.ch;
const at = (line, ch) => ({ line, ch });

// $…$ and $$…$$. "$$" pair over the whole note (1st with 2nd …; see closesInParagraph); a backslash escapes the
// next character; $ inside ``` fences and `inline code` is text; inline $ never spans lines.
function mathSpans(lines) {
  const out = [];
  let open = null, fence = null;
  for (let r = 0; r < lines.length; r++) {
    const line = lines[r];
    // a fence closes with the same character, at least as long, or when its blockquote / callout ends
    const quotes = (prefixOf(line).match(/>/g) || []).length, f = /^(`{3,}|~{3,})(.*)$/.exec(line.slice(prefixOf(line).length));
    if (fence && quotes < fence.quotes) fence = null;
    if (fence) {
      if (f && f[1][0] === fence.c && f[1].length >= fence.len && blank(f[2])) fence = null;
      continue;
    }
    if (!open && f && !(f[1][0] === "`" && f[2].includes("`"))) { fence = { c: f[1][0], len: f[1].length, quotes }; continue; }
    let iopen = -1;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === "\\") { i++; continue; }
      if (c === "`" && !open && iopen < 0) {
        const e = line.indexOf("`", i + 1);
        if (e > 0) i = e;
        continue;
      }
      if (c !== "$") continue;
      if (line[i + 1] === "$") {
        // "$a$$b$": the first $ closes the open $a$, the second opens $b$
        if (!open && iopen >= 0) { out.push({ kind: "inline", a: at(r, iopen), ae: at(r, iopen + 1), bs: at(r, i), b: at(r, i + 1) }); iopen = -1; continue; }
        if (open) { out.push({ kind: "display", a: open, ae: at(open.line, open.ch + 2), bs: at(r, i), b: at(r, i + 2) }); open = null; }
        else if ((onlyPrefix(line.slice(0, i)) && blank(line.slice(i + 2))) || closesInParagraph(lines, r, i + 2)) open = at(r, i);
        // "Soit $$ ok": the empty inline maths Latex Suite leaves while you type, not a $$ opener
        else out.push({ kind: "inline", a: at(r, i), ae: at(r, i + 1), bs: at(r, i + 1), b: at(r, i + 2) });
        iopen = -1;
        i++;
      } else if (!open) {
        if (iopen >= 0) { out.push({ kind: "inline", a: at(r, iopen), ae: at(r, iopen + 1), bs: at(r, i), b: at(r, i + 1) }); iopen = -1; }
        else iopen = i;
      }
    }
  }
  return out;
}

// A $$ that isn't alone on its line opens display maths only if a $$ closes it before the
// paragraph ends (blank line or heading) — else it is an empty $…$.
function closesInParagraph(lines, r, i) {
  for (let k = r; k < lines.length; k++) {
    const l = lines[k];
    if (k > r && (onlyPrefix(l) || /^[>\s]*#{1,6}\s/.test(l))) return false;
    for (let j = k === r ? i : 0; j < l.length; j++) {
      if (l[j] === "\\") j++;
      else if (l[j] === "$" && l[j + 1] === "$") return true;
    }
  }
  return false;
}

// \begin{x} … \end{x}, matched by name (a stray \end is skipped).
function envSpans(lines) {
  const out = [], stack = [], re = /\\(begin|end)\{([^}]*)\}/g;
  lines.forEach((line, r) => {
    for (const m of line.matchAll(re)) {
      const s = at(r, m.index), e = at(r, m.index + m[0].length);
      if (m[1] === "begin") { stack.push({ name: m[2], a: s, ae: e }); continue; }
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].name !== m[2]) continue;
        const o = stack[k];
        stack.length = k;
        out.push({ kind: "env", name: o.name, a: o.a, ae: o.ae, bs: s, b: e });
        break;
      }
    }
  });
  return out;
}

// (), [] and {}, typed "(" "[" "{" for ib / ir / iB; stray closers are skipped.
const PAIR = { ")": "(", "]": "[", "}": "{" };
// \left( … \right) is one bracket (so ib never takes the \right), and so are the interval
// snippets icc ico ioc ioo: \left[\!\left[ a; b \right]\!\right] and their ]…[ variants.
// \{ … \} (sets) and \left\{ … \right\} are braces for iB; each closes only its own kind.
// \big( … \big) (and \Big \bigg \Bigg, \bigl \bigr) is one bracket too, like \left( \right).
// A null kind is the opener's own bracket after the size: "\left(", "\big(".
const OPENERS = [[/\\left([[\]])\s*\\!\s*\\left\1/y, "⟦"], [/\\left\s*\\\{/y, "\\left\\{"], [/\\[bB]igg?l?\s*\\\{/y, "\\big\\{"], [/\\\{/y, "\\{"],
  [/\\left\s*([([{])/y, null, "\\left"], [/\\[bB]igg?l?\s*([([])/y, null, "\\big"]];
const CLOSERS = [[/\\right([[\]])\s*\\!\s*\\right\1/y, "⟦"], [/\\right\s*\\\}/y, "\\left\\{"], [/\\[bB]igg?r?\s*\\\}/y, "\\big\\{"], [/\\\}/y, "\\{"],
  [/\\right\s*([)\]}])/y, null, "\\left"], [/\\[bB]igg?r?\s*([)\]])/y, null, "\\big"]];
const TYPE = { "⟦": "[", "\\left\\{": "{", "\\big\\{": "{", "\\{": "{" };
const sticky = (re, line, i) => { re.lastIndex = i; return re.exec(line); };
function bracketSpans(lines) {
  const out = [], stack = [];
  const close = (c, r, i, end) => {
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k].c !== c) continue;
      const o = stack[k];
      stack.length = k;
      out.push({ kind: "bracket", type: o.t, a: o.a, ae: o.ae, bs: at(r, i), b: at(r, end) });
      return;
    }
  };
  lines.forEach((line, r) => {
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === "\\") {
        const o = OPENERS.map(([re, k, pre]) => [sticky(re, line, i), k, pre]).find(([m]) => m);
        const q = !o && CLOSERS.map(([re, k, pre]) => [sticky(re, line, i), k, pre]).find(([m]) => m);
        if (o) { const [m, k, pre] = o; stack.push({ c: k || pre + m[1], t: TYPE[k] || m[1], a: at(r, i), ae: at(r, i + m[0].length) }); i += m[0].length - 1; }
        else if (q) { const [m, k, pre] = q; close(k || pre + PAIR[m[1]], r, i, i + m[0].length); i += m[0].length - 1; }
        else i++;
        continue;
      }
      if (c === "(" || c === "[" || c === "{") { stack.push({ c, t: c, a: at(r, i), ae: at(r, i + 1) }); continue; }
      if (PAIR[c]) close(PAIR[c], r, i, i + 1);
    }
  });
  return out;
}

// \name{…}[…]{…} inside maths: { kind: "command", name, a, ae, bs, b, args }, bs = b so that
// ac (range around) is the whole command; args are argument spans { kind: "arg", opt, a, ae,
// bs, b, cmd } shaped like a bracket span. Only braced groups count, a […] only when a {…}
// follows it (\sqrt[n]{x} yes, \mathbb{R}[x] no). The sized delimiters and \begin \end are
// other objects', not commands.
const NOT_COMMANDS = /^(begin|end|left|right|middle|[bB]igg?[lrm]?)$/;
// The first non-space position from p before `end`, newlines and a "> " line prefix included.
function skipSpace(lines, p, end) {
  for (let r = p.line; r <= end.line; r++) {
    const line = lines[r], to = r === end.line ? end.ch : line.length;
    for (let i = r === p.line ? p.ch : prefixOf(line).length; i < to; i++) if (!/\s/.test(line[i])) return at(r, i);
  }
  return null;
}
// Where each { or [ group from p to `end` ends ("line:ch" → position after its closer), in
// one pass; one that doesn't close is missing. Braces nest; \x is skipped; a […] ends at the
// first ] at its own brace depth and never takes a } it didn't open.
function groupEnds(lines, p, end) {
  const ends = new Map(), braces = [], squares = []; // squares[d]: the open [ at brace depth d
  for (let r = p.line; r <= end.line; r++) {
    const line = lines[r], to = r === end.line ? end.ch : line.length;
    for (let i = r === p.line ? p.ch : 0; i < to; i++) {
      const c = line[i];
      if (c === "\\") { i++; continue; }
      if (c === "{") braces.push(r + ":" + i);
      else if (c === "[") (squares[braces.length] = squares[braces.length] || []).push(r + ":" + i);
      else if (c === "]") { for (const k of squares[braces.length] || []) ends.set(k, at(r, i + 1)); squares[braces.length] = []; }
      else if (c === "}") {
        squares[braces.length] = []; // a [ inside this group never closes now
        if (braces.length) ends.set(braces.pop(), at(r, i + 1));
        else squares.length = 0; // an unopened }: nothing before it can close past it
      }
    }
  }
  return ends;
}
function commandSpans(lines) {
  const out = [];
  for (const m of mathSpans(lines)) {
    const end = m.bs, ends = groupEnds(lines, m.ae, end);
    for (let r = m.ae.line; r <= end.line; r++) {
      const line = lines[r], to = r === end.line ? end.ch : line.length;
      for (let i = r === m.ae.line ? m.ae.ch : 0; i < to; i++) {
        if (line[i] !== "\\") continue;
        const name = /^[A-Za-z]+/.exec(line.slice(i + 1, to));
        if (!name) { i++; continue; }
        const a = at(r, i), ae = at(r, i + 1 + name[0].length);
        i = ae.ch - 1; // carry on inside the arguments: nested commands are found too
        if (NOT_COMMANDS.test(name[0])) continue;
        const args = [];
        let p = ae, opts = [];
        for (;;) {
          const q = skipSpace(lines, p, end), c = q && lines[q.line][q.ch];
          if (c !== "{" && c !== "[") break;
          const e = ends.get(q.line + ":" + q.ch);
          if (!e) break;
          const g = { kind: "arg", opt: c === "[", a: q, ae: at(q.line, q.ch + 1), bs: at(e.line, e.ch - 1), b: e };
          if (g.opt) opts.push(g);
          else { args.push(...opts, g); opts = []; }
          p = e;
        }
        const b = args.length ? args[args.length - 1].b : ae, s = { kind: "command", name: name[0], a, ae, bs: b, b, args };
        for (const g of args) g.cmd = s;
        out.push(s);
      }
    }
  }
  return out;
}
const argSpans = lines => commandSpans(lines).flatMap(s => s.args);
// x_{n+1}, x^2, x^\alpha in maths: the _ / ^ and its group, or its one token (a character,
// \name, or \ and a character). As spans { kind: "script", type: "^" | "_", a, ae, bs, b }.
function scriptSpans(lines) {
  const out = [];
  for (const m of mathSpans(lines)) {
    const end = m.bs, ends = groupEnds(lines, m.ae, end);
    for (let r = m.ae.line; r <= end.line; r++) {
      const line = lines[r], to = r === end.line ? end.ch : line.length;
      for (let i = r === m.ae.line ? m.ae.ch : 0; i < to; i++) {
        const c = line[i];
        if (c === "\\") { i++; continue; }
        if (c !== "^" && c !== "_") continue;
        const q = skipSpace(lines, at(r, i + 1), end);
        if (!q) continue;
        const t = lines[q.line], k = t[q.ch], qto = q.line === end.line ? end.ch : t.length;
        if ("}^_&".includes(k)) continue; // a } ^ _ & right after is not a script argument
        let ae = q, bs, b;
        if (k === "{") {
          const e = ends.get(q.line + ":" + q.ch);
          if (!e) continue;
          ae = at(q.line, q.ch + 1); bs = at(e.line, e.ch - 1); b = e;
        } else {
          let n = 1; // the token's length in UTF-16 units: \name, \ and one character, a character
          if (k === "\\") {
            const name = /^[A-Za-z]+/.exec(t.slice(q.ch + 1, qto));
            n = name ? 1 + name[0].length : 1 + (isHigh(t, q.ch + 1) ? 2 : 1);
          } else if (isHigh(t, q.ch)) n = 2;
          bs = b = at(q.line, Math.min(q.ch + n, qto));
        }
        out.push({ kind: "script", type: c, a: at(r, i), ae, bs, b });
      }
    }
  }
  return out;
}
// [p, q) without the whitespace around it (line breaks and "> " prefixes too); blank → empty at p.
function trimmed(lines, p, q) {
  const s = skipSpace(lines, p, q);
  if (!s) return [p, p];
  let e = q;
  for (;;) {
    const line = lines[e.line], pre = e.line > s.line ? prefixOf(line).length : 0;
    if (e.ch > pre && /\s/.test(line[e.ch - 1])) e = at(e.line, e.ch - 1);
    else if (e.ch <= pre && e.line > s.line) e = at(e.line - 1, lines[e.line - 1].length);
    else return [s, e];
  }
}

// The rows and cells of every environment that has a & or \\ of its own: not in { }, not in a
// nested environment, not \&. A \\ takes its [2pt]. Rows: { kind: "row", a, ae, bs, b, cells };
// cells: { kind: "cell", a, ae, bs, b, row }. [ae, bs) is the trimmed text; [a, b) is what a&
// / aR take: a cell up to the next cell's text (the last one: from the previous cell's text),
// a row with its \\ (the last one: from the previous row's text, through that \\).
function tableSpans(lines) {
  const envs = envSpans(lines), rows = [];
  const startAt = new Map(envs.map(n => [n.a.line + ":" + n.a.ch, n]));
  for (const env of envs) {
    const arg = ARG_ENV.test(env.name) && /^(\[[^\]]*\])?\{[^}]*\}/.exec(lines[env.ae.line].slice(env.ae.ch)), from = arg ? at(env.ae.line, env.ae.ch + arg[0].length) : env.ae;
    const marks = []; // { amp, p, e }
    let depth = 0, r = from.line, i = from.ch;
    while (cmp(at(r, i), env.bs) < 0) {
      const line = lines[r];
      if (i >= line.length) { r++; i = 0; continue; }
      const n = startAt.get(r + ":" + i);
      if (n && cmp(n.a, env.ae) >= 0 && cmp(n.b, env.bs) <= 0) { r = n.b.line; i = n.b.ch; continue; }
      const c = line[i];
      if (c === "{") depth++;
      else if (c === "}") depth = Math.max(0, depth - 1);
      else if (c === "&" && !depth) marks.push({ amp: true, p: at(r, i), e: at(r, i + 1) });
      else if (c === "\\") {
        if (line[i + 1] === "\\" && !depth) {
          const o = /^\[[^\]]*\]/.exec(line.slice(i + 2)), e = at(r, i + 2 + (o ? o[0].length : 0));
          marks.push({ amp: false, p: at(r, i), e });
          r = e.line; i = e.ch; continue;
        }
        i += 2; continue;
      }
      i++;
    }
    if (!marks.length) continue;
    // split into rows at \\, each into cells at &
    const segs = [];
    let start = from, cells = [];
    for (const k of [...marks, { amp: false, p: env.bs, e: env.bs, last: true }]) {
      cells.push([start, k.p]);
      if (k.amp) { start = k.e; continue; }
      segs.push({ cells, sep: k.last ? null : k });
      cells = []; start = k.e;
    }
    const envRows = [];
    for (const g of segs) {
      const [ae, bs] = trimmed(lines, g.cells[0][0], g.cells[g.cells.length - 1][1]);
      if (!g.sep && !cmp(ae, bs) && envRows.length) continue; // nothing after the last \\
      const row = { kind: "row", a: ae, ae, bs, b: g.sep ? g.sep.e : bs, cells: [], noSep: !g.sep };
      // a blank cell sits at its place, kept inside the row's text (a blank first cell: at the first &)
      const clamp = p => (cmp(p, ae) < 0 ? ae : cmp(p, bs) > 0 ? bs : p);
      row.cells = g.cells.map(([p, q]) => { const [cae, cbs] = trimmed(lines, p, q).map(clamp); return { kind: "cell", a: cae, ae: cae, bs: cbs, b: cbs, row }; });
      row.cells.forEach((c, k, cs) => { if (k + 1 < cs.length) c.b = cs[k + 1].ae; else if (k) c.a = cs[k - 1].bs; });
      envRows.push(row);
    }
    const lastRow = envRows[envRows.length - 1], prev = envRows[envRows.length - 2];
    if (prev && lastRow.noSep) lastRow.a = prev.bs;
    rows.push(...envRows);
  }
  return rows;
}
const rowSpans = lines => tableSpans(lines);
const cellSpans = lines => tableSpans(lines).flatMap(r => r.cells);
// Position after typing `str` at p.
function advance(p, str) {
  const parts = str.split("\n");
  return parts.length === 1 ? at(p.line, p.ch + str.length) : at(p.line + parts.length - 1, parts[parts.length - 1].length);
}
// Move items[from] to index `to` among its siblings (each { ae, bs }, in order), the others
// shifting over: one change from the first to the last touched. The cursor keeps its place in
// the moved text. → { changes, cursor }
function moveChanges(lines, items, from, to, pos) {
  const lo = Math.min(from, to), hi = Math.max(from, to), run = items.slice(lo, hi + 1);
  const texts = run.map(s => slice(lines, s.ae, s.bs)), gaps = run.slice(1).map((s, k) => slice(lines, run[k].bs, s.ae));
  const [moved] = texts.splice(from - lo, 1);
  texts.splice(to - lo, 0, moved);
  let text = "", start = null;
  texts.forEach((t, k) => { if (k === to - lo) start = advance(items[lo].ae, text); text += t + (k < gaps.length ? gaps[k] : ""); });
  const m = items[from], inside = cmp(pos, m.ae) >= 0 && cmp(pos, m.bs) <= 0;
  return { changes: [{ from: items[lo].ae, to: items[hi].bs, text }], cursor: inside ? advance(start, slice(lines, m.ae, pos)) : start };
}
// >, <, >& <&: the {…} argument (what "arg") or cell (what "cell") at pos, moved count places
// forward / back among its command's {…} arguments / its row's cells. → { changes, cursor } or
// { none: message }.
function swapAt(lines, pos, what, forward, count = 1) {
  let items, s;
  if (what === "arg") {
    const cmd = commandSpans(lines).find(c => c.args.length && cmp(c.a, pos) <= 0 && cmp(pos, c.ae) < 0);
    s = cmd ? cmd.args.find(g => !g.opt) : around(argSpans(lines).filter(g => !g.opt), pos);
    if (!s) return { none: "Not in a { } argument" };
    items = s.cmd.args.filter(g => !g.opt);
  } else {
    s = around(cellSpans(lines), pos);
    if (!s) return { none: "Not in a cell" };
    items = s.row.cells;
  }
  const from = items.indexOf(s), to = from + (forward ? count : -count);
  if (to < 0 || to >= items.length) return { none: `No ${forward ? "next" : "previous"} ${what === "arg" ? "argument" : "cell"}` };
  return moveChanges(lines, items, from, to, pos);
}
const namedSpans = (lines, name) => commandSpans(lines).filter(s => s.name === name);
// For the prompt's Tab: the names in the note's maths, most used first.
function commandNames(lines) {
  const n = new Map();
  for (const s of commandSpans(lines)) n.set(s.name, (n.get(s.name) || 0) + 1);
  return [...n].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).map(([k]) => k);
}
const ofType = t => lines => bracketSpans(lines).filter(s => s.type === t);
const SPANS = { math: mathSpans, display: l => mathSpans(l).filter(s => s.kind === "display"), env: envSpans, paren: ofType("("), brace: ofType("{"), square: ofType("["),
  command: l => commandSpans(l).filter(s => s.args.length), arg: argSpans,
  sup: l => scriptSpans(l).filter(s => s.type === "^"), sub: l => scriptSpans(l).filter(s => s.type === "_"), cell: l => cellSpans(l), row: l => rowSpans(l) };
// What a ]x / ; walks: an object's spans, or (]C / [C) the commands called `name`.
const spansFor = (obj, lines, name) => (obj === "named" ? namedSpans(lines, name) : SPANS[obj](lines));

// Is span s a better "nearest" than t for the cursor? Compared in order:
//   1. lines between the cursor and the span's nearest edge (first char below, last char above)
//   2. columns between them
//   3. below beats above (a tie goes forward, like Vim's seeking)
//   4. the one nearer in document order (earlier start below, later end above)
function nearer(s, t, pos) {
  const key = x => {
    const below = cmp(x.a, pos) > 0, p = below ? x.a : at(x.b.line, x.b.ch - 1);
    return [Math.abs(p.line - pos.line), Math.abs(p.ch - pos.ch), below ? 0 : 1];
  };
  const [ks, kt] = [key(s), key(t)];
  for (let i = 0; i < 3; i++) if (ks[i] !== kt[i]) return ks[i] < kt[i];
  return ks[2] === 0 ? cmp(s.a, t.a) < 0 : cmp(s.b, t.b) > 0;
}

// which: "cur" = like mini.ai's cover_or_nearest — the innermost span around the cursor,
// else the NEAREST one in either direction (lines first, then columns; a tie goes below) |
// "next" = first one starting after the cursor | "last" = last one ending before it
// (all three within CONFIG.seekLines).
// Seeking stops CONFIG.seekLines lines from the cursor (default 50, mini.ai's n_lines), so an edit never
// lands on maths you can't see; the span around the cursor is always found.
const CONFIG = { seekLines: 50, flash: true, flashMs: 250, highlight: true };   // the settings tab writes these
function pick(spans, pos, which) {
  let cur = null, next = null, last = null, near = null;
  for (const s of spans) {
    const below = cmp(s.a, pos) > 0;
    if (!below && cmp(pos, s.b) < 0) { if (!cur || cmp(s.a, cur.a) > 0) cur = s; continue; }
    if ((below ? s.a.line - pos.line : pos.line - s.b.line) > CONFIG.seekLines) continue;
    if (below) { if (!next || cmp(s.a, next.a) < 0) next = s; }
    else if (!last || cmp(s.b, last.b) > 0) last = s;
    if (!near || nearer(s, near, pos)) near = s;
  }
  if (which === "next") return next;
  if (which === "last") return last;
  return cur || near;
}

// The count-th of `cands` at the same level: forward in order of start, backward in order of
// end, skipping any span nested in the one counted just before (2inB after {a{b}} {c} → {c}).
function nthSameLevel(cands, forward, count) {
  const list = cands.slice().sort((x, y) => (forward ? cmp(x.a, y.a) : cmp(y.b, x.b)));
  let prev = null;
  for (const s of list) {
    if (prev && (forward ? cmp(s.a, prev.b) < 0 : cmp(s.b, prev.a) > 0)) continue;
    prev = s;
    if (--count === 0) return s;
  }
  return null;
}

// 3iB / 3inB / 3ilB: the 3rd enclosing / next / previous one, as a range. Too few → null
// (like Vim's 3i( failing: an operator must not land on some other block).
function countPick(spans, lines, pos, which, inner, count) {
  if (which === "cur") {
    const s = pick(spans, pos, "cur");
    let r = s && range(s, lines, inner);
    for (let i = 1; r && i < count; i++) r = grow(spans, lines, image(lines, r) || { start: r.start, last: r.start }, inner);
    return r;
  }
  const forward = which === "next";
  const cands = spans.filter(s => (forward ? cmp(s.a, pos) > 0 && s.a.line - pos.line <= CONFIG.seekLines
    : cmp(pos, s.b) >= 0 && pos.line - s.b.line <= CONFIG.seekLines));
  const s = nthSameLevel(cands, forward, count);
  return s && range(s, lines, inner);
}

// ic: on a command's name, its first argument; else the argument around / nearest, like iB.
function icPick(lines, pos, which, count) {
  if (which === "cur" && count === 1) {
    const s = commandSpans(lines).find(c => c.args.length && cmp(c.a, pos) <= 0 && cmp(pos, c.ae) < 0);
    if (s) return range(s.args[0], lines, true);
  }
  return countPick(argSpans(lines), lines, pos, which, true, count);
}

// Visual inB / ilB with a selection: the count-th block inside it (first / last), same level.
// null when nothing smaller fits inside — the caller then seeks as usual.
function shrink(spans, lines, sel, which, inner, count) {
  const fits = s => {
    const im = image(lines, range(s, lines, inner));
    return im && cmp(im.start, sel.start) >= 0 && cmp(im.last, sel.last) <= 0 && (cmp(im.start, sel.start) || cmp(im.last, sel.last));
  };
  const s = nthSameLevel(spans.filter(fits), which === "next", count);
  return s && range(s, lines, inner);
}

// A line prefix: indentation and blockquote / callout markers ("> ", "> > "). Text that is
// only a prefix counts as blank: a "> $$" line is a delimiter alone on its line.
const PREFIX = /^[ \t]*(?:>[ \t]*)*/;
const prefixOf = line => line.match(PREFIX)[0];
const onlyPrefix = str => prefixOf(str).length === str.length;

// What an operator acts on, like Vim's i{ / a{: delimiters on their own lines make it
// linewise (d removes the lines, c leaves one empty line to type on).
function range(s, lines, inner) {
  const blankBefore = p => onlyPrefix(lines[p.line].slice(0, p.ch));
  const blankAfter = p => !lines[p.line].slice(p.ch).trim();
  const eol = l => at(l, lines[l].length);
  if (!inner) {
    // a row alone on its line(s) with its \\ too: aR is like dd
    if ((s.a.line < s.b.line || s.kind === "row") && blankBefore(s.a) && blankAfter(s.b)) return { start: at(s.a.line, 0), end: eol(s.b.line), linewise: true };
    return { start: s.a, end: s.b };
  }
  let start = s.ae, end = s.bs;
  if (blankAfter(start) && blankBefore(end) && end.line > start.line + 1) return { start: at(start.line + 1, 0), end: eol(end.line - 1), linewise: true };
  // not the "> " of a blockquote / callout line: taking it would break the quote
  if (blankAfter(start) && start.line < end.line) start = at(start.line + 1, (lines[start.line + 1].match(/^[ \t]*(?:>[ \t]*)+/) || [""])[0].length);
  if (blankBefore(end) && end.line > start.line) end = eol(end.line - 1);
  return { start, end };
}

// Text of [p, q) and the inside of a span as lines (delimiter-only first/last lines dropped).
function slice(lines, p, q) {
  if (p.line === q.line) return lines[p.line].slice(p.ch, q.ch);
  return [lines[p.line].slice(p.ch), ...lines.slice(p.line + 1, q.line), lines[q.line].slice(0, q.ch)].join("\n");
}
function innerLines(lines, s) {
  const P = prefixOf(lines[s.a.line]).slice(0, s.a.ch);
  const t = slice(lines, s.ae, s.bs).split("\n").map((l, k) => (k > 0 && P && l.startsWith(P) ? l.slice(P.length) : l));
  if (t.length > 1 && onlyPrefix(t[0])) t.shift();
  if (t.length > 1 && onlyPrefix(t[t.length - 1])) t.pop();
  return t;
}

// ─── Edits (the commands) — each returns EditorChange[] for one undoable transaction ──────
const blank = s => !s.trim();

// Delete whole lines `rows` (sorted); adjacent rows go in one change so they never overlap.
function dropLines(lines, rows) {
  const out = [];
  for (let k = 0; k < rows.length;) {
    let r2 = rows[k];
    const r1 = r2;
    while (rows[k + 1] === r2 + 1) r2 = rows[++k];
    k++;
    if (r2 + 1 < lines.length) out.push({ from: at(r1, 0), to: at(r2 + 1, 0), text: "" });
    else if (r1 > 0) out.push({ from: at(r1 - 1, lines[r1 - 1].length), to: at(r2, lines[r2].length), text: "" });
    else out.push({ from: at(r1, 0), to: at(r2, lines[r2].length), text: "" });
  }
  return out;
}

// Remove the delimiters, keep the inside; a delimiter alone on its line takes the line.
function unwrapChanges(lines, s, extraRows = []) {
  const alone = (p, q) => s.a.line !== s.b.line && onlyPrefix(lines[p.line].slice(0, p.ch)) && blank(lines[q.line].slice(q.ch));
  const changes = [], rows = [];
  for (const [p, q] of [[s.a, s.ae], [s.bs, s.b]]) {
    if (alone(p, q)) rows.push(p.line);
    else changes.push({ from: p, to: q, text: "" });
  }
  return [...changes, ...dropLines(lines, [...rows, ...extraRows].sort((x, y) => x - y))];
}

// ─── align-type environments ──────────────────────────────────────────────────
const ALIGNED = /^(align|flalign|eqnarray|split)/;    // & columns, \\ rows
const ARG_ENV = /^(alignat|alignedat|array|tabular)/; // \begin{…}{arg}
const argOf = (lines, s) => (ARG_ENV.test(s.name) && /^\{[^}]*\}/.exec(lines[s.ae.line].slice(s.ae.ch))) || null;

// The alignment marks inside s: top-level runs of & (and \\ when `rows`), spaces between
// them included, as {r, i, j}. Not \&, not the marks of a nested matrix / cases.
function alignMarks(lines, s, rows) {
  const nested = envSpans(lines).filter(e => cmp(e.a, s.ae) >= 0 && cmp(e.b, s.bs) <= 0);
  const tok = (line, j) => (line[j] === "&" ? 1 : rows && line.startsWith("\\\\", j) ? 2 : 0);
  const out = [];
  for (let r = s.ae.line; r <= s.bs.line; r++) {
    const line = lines[r], from = r === s.ae.line ? s.ae.ch : 0, to = r === s.bs.line ? s.bs.ch : line.length;
    for (let i = from; i < to; i++) {
      const inner = nested.find(e => cmp(e.a, at(r, i)) <= 0 && cmp(at(r, i), e.b) < 0);
      if (inner) { if (inner.b.line > r) break; i = inner.b.ch - 1; continue; }
      const k = tok(line, i);
      if (!k) { if (line[i] === "\\") i++; continue; }
      let j = i + k;
      for (;;) {
        let m = j;
        while (m < to && line[m] === " ") m++;
        const k2 = m < to ? tok(line, m) : 0;
        if (!k2) break;
        j = m + k2;
      }
      out.push({ r, i, j });
      i = j - 1;
    }
  }
  return out;
}

// Delete the marks: a space on both sides collapses to one, a mark ending its line takes the
// spaces before it, and a line left empty is dropped (a blank line would end the $$ block).
// → { changes, drop: rows to delete }
function markChanges(lines, s, rows) {
  const by = new Map();
  for (const m of alignMarks(lines, s, rows)) { if (!by.has(m.r)) by.set(m.r, []); by.get(m.r).push(m); }
  const changes = [], drop = [];
  for (const [r, ms] of by) {
    const line = lines[r], start = r === s.ae.line ? s.ae.ch : 0, end = r === s.bs.line ? s.bs.ch : line.length;
    if (r > s.ae.line && r < s.bs.line && onlyPrefix(ms.reduceRight((l, m) => l.slice(0, m.i) + l.slice(m.j), line).trimEnd())) { drop.push(r); continue; }
    for (const { i, j } of ms) {
      let a = i, b = j;
      if (blank(line.slice(b, end))) while (a > start && line[a - 1] === " ") a--;
      else if (line[a - 1] === " " && line[b] === " ") b++;
      changes.push({ from: at(r, a), to: at(r, b), text: "" });
    }
  }
  return { changes, drop };
}

// Unwrap environment: an align-type one also loses its & and \\, and
// alignat / array / tabular their {arg}.
function envUnwrapChanges(lines, s) {
  const arg = argOf(lines, s);
  if (arg) s = { ...s, ae: at(s.ae.line, s.ae.ch + arg[0].length) };
  if (!ALIGNED.test(s.name)) return unwrapChanges(lines, s);
  const { changes, drop } = markChanges(lines, s, true);
  return [...unwrapChanges(lines, s, drop), ...changes];
}

// Rename environment extras, in the doc before the rename: align → gather / equation / multline drops
// the & (they don't align); → alignat adds its {columns}; leaving alignat / array drops it.
function renameExtras(lines, s, name) {
  const out = [], arg = argOf(lines, s);
  if (ALIGNED.test(s.name) && /^(gather|gathered|equation|multline)\*?$/.test(name)) {
    const { changes, drop } = markChanges(lines, s, false);
    out.push(...changes, ...dropLines(lines, drop));
  }
  if (/^(alignat|alignedat)\*?$/.test(name) && !arg) {
    const amps = new Map();
    for (const m of alignMarks(lines, s, false)) amps.set(m.r, (amps.get(m.r) || 0) + lines[m.r].slice(m.i, m.j).split("&").length - 1);
    out.push({ from: s.ae, to: s.ae, text: "{" + Math.max(1, ...[...amps.values()].map(n => Math.ceil((n + 1) / 2))) + "}" });
  }
  if (arg && !ARG_ENV.test(name)) out.push({ from: s.ae, to: at(s.ae.line, s.ae.ch + arg[0].length), text: "" });
  return out;
}

// Align: & before the first relation of a line (outside brackets), unless it has one.
const RELATION = /^(?::=|=|<|>|\\(?:leq?|geq?|leqslant|geqslant|neq?|equiv|approx|sim|simeq|cong|implies|impliedby|iff|Rightarrow|Leftarrow|Leftrightarrow|Longrightarrow|Longleftarrow|Longleftrightarrow)(?![A-Za-z]))/;
function ampBeforeRelation(l) {
  if (/(^|[^\\])&/.test(l)) return l;
  let depth = 0;
  for (let i = 0; i < l.length; i++) {
    if (!depth && RELATION.test(l.slice(i))) return l.slice(0, i) + "&" + l.slice(i);
    let c = l[i];
    if (c === "\\") {
      if ("{}".includes(l[i + 1])) c = l[++i];
      else { while (/[A-Za-z]/.test(l[i + 1] || "")) i++; continue; }
    }
    // not [ ]: French intervals ]0, 1[ don't pair up
    if ("({".includes(c)) depth++;
    else if (")}".includes(c)) depth = Math.max(0, depth - 1);
  }
  return l;
}

// Apply EditorChange[] (positions in `lines`) → new lines.
function applyChanges(lines, changes) {
  const starts = [0];
  for (const l of lines) starts.push(starts[starts.length - 1] + l.length + 1);
  const off = p => starts[p.line] + p.ch;
  return [...changes].sort((x, y) => off(y.from) - off(x.from))
    .reduce((d, c) => d.slice(0, off(c.from)) + c.text + d.slice(off(c.to)), lines.join("\n")).split("\n");
}

// Delete the whole thing; on its own lines take the lines (and one of two blank neighbours),
// inline don't leave a double space.
function deleteChanges(lines, s) {
  if (onlyPrefix(lines[s.a.line].slice(0, s.a.ch)) && blank(lines[s.b.line].slice(s.b.ch))) {
    let r1 = s.a.line, r2 = s.b.line;
    if (r1 > 0 && r2 + 1 < lines.length && onlyPrefix(lines[r1 - 1]) && onlyPrefix(lines[r2 + 1])) r2++;
    if (r2 + 1 < lines.length) return [{ from: at(r1, 0), to: at(r2 + 1, 0), text: "" }];
    if (r1 > 0) return [{ from: at(r1 - 1, lines[r1 - 1].length), to: at(r2, lines[r2].length), text: "" }];
    return [{ from: at(r1, 0), to: at(r2, lines[r2].length), text: "" }];
  }
  let from = s.a;
  const before = lines[s.a.line][s.a.ch - 1], after = lines[s.b.line][s.b.ch];
  if (before === " " && (after === " " || after === undefined)) from = at(s.a.line, s.a.ch - 1);
  return [{ from, to: s.b, text: "" }];
}

// $…$ ⇄ $$…$$ (display → inline joins its lines).
function toggleChanges(lines, s) {
  if (s.kind === "display") {
    // an align inside can't be inline: unwrap it (its & and \\ go too)
    let inner = innerLines(lines, s);
    const al = envSpans(inner).filter(e => ALIGNED.test(e.name)), top = al.filter(e => !al.some(o => o !== e && cmp(o.a, e.a) <= 0 && cmp(e.b, o.b) <= 0));
    if (top.length) inner = applyChanges(inner, top.flatMap(e => envUnwrapChanges(inner, e)));
    const joined = inner.filter(l => !blank(l)).map(l => l.trim()).join(" ");
    return [{ from: s.a, to: s.b, text: "$" + joined + "$" }];
  }
  // only the $ change, so the maths (and the cursor in it) is left alone
  const line = lines[s.a.line], P = line.slice(0, s.a.ch);
  if (onlyPrefix(P) && blank(line.slice(s.b.ch))) return [{ from: at(s.a.line, 0), to: s.ae, text: P + "$$\n" + P }, { from: s.bs, to: at(s.a.line, line.length), text: "\n" + P + "$$" }];
  return [{ from: s.a, to: s.ae, text: "$$" }, { from: s.bs, to: s.b, text: "$$" }];
}

// Where the cursor goes after `changes` (positions in the original doc): it stays on the same
// character; one inside removed or rewritten text goes to where that text was.
function mapCursor(lines, changes, pos) {
  const starts = [0];
  for (const l of lines) starts.push(starts[starts.length - 1] + l.length + 1);
  const off = p => starts[p.line] + p.ch, cur = off(pos);
  const cut = changes.find(c => off(c.from) <= cur && cur < off(c.to));
  const target = cut ? off(cut.from) : cur;
  let out = lines.join("\n"), shift = 0;
  for (const c of [...changes].sort((x, y) => off(y.from) - off(x.from))) {
    out = out.slice(0, off(c.from)) + c.text + out.slice(off(c.to));
    if (off(c.to) <= target && c !== cut) shift += c.text.length - (off(c.to) - off(c.from));
  }
  const before = out.slice(0, target + shift).split("\n");
  return at(before.length - 1, before[before.length - 1].length);
}

// Align: the maths under the cursor → $$ \begin{align} … \\ … \end{align} $$ (numbered: \tag and \label work).
// Inline $…$ too (it moves out to its own lines, the text around it stays). Maths that is already one
// align-type or equation environment keeps its body and becomes align; align itself → null (nothing to do).
const TO_ALIGN = /^(align\*|aligned|equation\*?|gather\*?|gathered|multline\*?)$/;
function alignChanges(lines, s) {
  let inner = innerLines(lines, s);
  const t = inner.filter(l => !blank(l)), first = (t[0] || "").trim(), last = (t[t.length - 1] || "").trim();
  const env = /^\\begin\{([^}]*)\}$/.exec(first), whole = env && last === "\\end{" + env[1] + "}" && envSpans(t.map(l => l.trim()))
    .some(e => e.name === env[1] && e.a.line === 0 && e.b.line === t.length - 1);
  if (whole && env[1] === "align") return null;
  if (whole && TO_ALIGN.test(env[1])) {                    // its rows stay as written
    const body = t.slice(1, -1);
    inner = /^(align|aligned)/.test(env[1]) ? body : body.map(ampBeforeRelation);
  } else inner = inner.map(ampBeforeRelation).map((l, k, all) => (k < all.length - 1 && !blank(l) && !/\\\\\s*$/.test(l) ? l + " \\\\" : l));
  const before = lines[s.a.line].slice(0, s.a.ch), after = lines[s.b.line].slice(s.b.ch);
  // in a list item ("- ", "1. ") the new lines are indented under its text, so they stay in the item
  const item = /^([ \t]*(?:>[ \t]*)*)([-*+]|\d+[.)])([ \t]+)/.exec(before), P = item ? item[1] + " ".repeat(item[2].length + item[3].length) : prefixOf(before);
  const body = ["$$", "\\begin{align}", ...inner, "\\end{align}", "$$"].map(l => P + l);
  const out = [...(onlyPrefix(before) ? [] : [before.trimEnd()]), ...body, ...(blank(after) ? [] : [P + after.trimStart()])];
  return [{ from: at(s.a.line, 0), to: at(s.b.line, lines[s.b.line].length), text: out.join("\n") }];
}

// The innermost span the cursor is in (a delimiter counts), never a neighbour: for edits that rewrite it.
function around(spans, pos) {
  let best = null;
  for (const s of spans) if (cmp(s.a, pos) <= 0 && cmp(pos, s.b) < 0 && (!best || cmp(s.a, best.a) > 0)) best = s;
  return best;
}
// %: the delimiter the cursor is on — \begin{…} / \end{…}, \left… / \right…, a $ / $$ —
// as { here: [from, to), there: its partner's [from, to) }, or null (then % is Vim's).
function delimAt(lines, pos) {
  const on = (p, q) => cmp(p, pos) <= 0 && cmp(pos, q) < 0;
  const lefts = bracketSpans(lines).filter(s => /^\\left/.test(slice(lines, s.a, s.ae)));
  for (const s of [...envSpans(lines), ...lefts, ...mathSpans(lines)]) {
    if (on(s.a, s.ae)) return { here: [s.a, s.ae], there: [s.bs, s.b] };
    if (on(s.bs, s.b)) return { here: [s.bs, s.b], there: [s.a, s.ae] };
  }
  return null;
}
const partner = (lines, pos) => { const d = delimAt(lines, pos); return d && d.there[0]; };
// The same for a CodeMirror doc, kept for the last doc and position: the highlight, then %
// (matchKey, then the motion) all ask about the one the cursor is on — one scan between them.
let delimMemo = null;
function delimAtDoc(doc, pos) {
  if (!delimMemo || delimMemo.doc !== doc || cmp(delimMemo.pos, pos)) delimMemo = { doc, pos, d: delimAt(doc.toString().split("\n"), pos) };
  return delimMemo.d;
}
const delimAtCm = (cm, pos) => (cm.cm6 ? delimAtDoc(cm.cm6.state.doc, pos) : delimAt(lineArray(cm), pos));
// Where % goes: after an operator, both delimiters and what is between (d% takes it all);
// in visual mode going forward, the partner's last character; else its first.
function matchTarget(d, op, visual) {
  const [h, t] = [d.here, d.there], fwd = cmp(t[0], h[0]) > 0;
  if (op) return fwd ? [h[0], t[1]] : [t[0], h[1]];
  return visual && fwd ? at(t[1].line, t[1].ch - 1) : t[0];
}

// align ⇄ align*
function starChanges(s) {
  const name = s.name.endsWith("*") ? s.name.slice(0, -1) : s.name + "*";
  return [{ from: s.bs, to: s.b, text: "\\end{" + name + "}" }, { from: s.a, to: s.ae, text: "\\begin{" + name + "}" }];
}

// ─── bracket surround: ds / cs on b B r ( ) { } [ ] ──────────────────────────
// The target seeks like ib / iB / ir. Like vim-surround: an opening target (ds( cs{…) also
// trims the spaces inside, an opening replacement (cs b ( …) puts one space inside.
// \left sizing is kept: cs b B on \left( … \right) gives \left\{ … \right\}; a { } made in
// maths is \{ \} (a bare { } would not show). ds on \left( … \right) trims its spaces too.
const TARGET = { b: "(", "(": "(", ")": "(", B: "{", "{": "{", "}": "{", r: "[", "[": "[", "]": "[" };
const OBJ_OF = { "(": "paren", "{": "brace", "[": "square" };
function surroundChanges(lines, s, target, repl, inMaths) {
  const open = slice(lines, s.a, s.ae), size = /^\\(left|[bB]igg?)/.exec(open), sized = !!size;
  let from = s.ae, to = s.bs;
  const spaced = repl && "([{".includes(repl);
  if ("([{".includes(target) || spaced || (!repl && sized)) {
    const l = lines[from.line];
    let i = from.ch;
    while (i < l.length && /[ \t]/.test(l[i]) && (from.line < to.line || i < to.ch)) i++;
    from = at(from.line, i);
    let j = to.ch;
    while (j > 0 && /[ \t]/.test(lines[to.line][j - 1]) && (to.line > from.line || j > from.ch)) j--;
    to = at(to.line, j);
  }
  let o = "", c = "";
  if (repl) {
    const t = TARGET[repl];
    const B = { "(": ["(", ")"], "[": ["[", "]"], "{": ["\\{", "\\}"] }[t];
    [o, c] = size && size[1] === "left" ? ["\\left" + B[0], "\\right" + B[1]] : size ? [size[0] + B[0], size[0] + B[1]]
      : t === "{" ? (inMaths ? ["\\{", "\\}"] : ["{", "}"]) : t === "(" ? ["(", ")"] : ["[", "]"];
    if (spaced) { o += " "; c = " " + c; }
  }
  return [{ from: s.a, to: from, text: o }, { from: to, to: s.b, text: c }];
}
const inMathsAt = (lines, p) => mathSpans(lines).some(m => cmp(m.a, p) <= 0 && cmp(p, m.b) < 0);
// ─── command surround: dsc / csc, and Wrap in command ────────────────────────
// dsc keeps one argument: the one the cursor is in, else the first ([…] ones go with the command).
const keptArg = (s, pos) => s.args.find(g => !g.opt && cmp(g.a, pos) <= 0 && cmp(pos, g.b) < 0) || s.args.find(g => !g.opt);
const dscChanges = (lines, s, keep) => [{ from: s.a, to: s.b, text: slice(lines, keep.ae, keep.bs) }];
const cscChanges = (s, name) => [{ from: at(s.a.line, s.a.ch + 1), to: s.ae, text: name }];
const wrapChanges = (lines, from, to, name) => [{ from, to, text: "\\" + name + "{" + slice(lines, from, to) + "}" }];
// The word under the cursor (letters and digits) as [from, to), or null.
// A command name takes its \ along: wrapping alpha in $\alpha$ must give \mathbf{\alpha}.
function wordAt(lines, p) {
  const l = lines[p.line], w = /[\p{L}\p{N}]/u;
  if (!w.test(l[p.ch] || "")) return null;
  let i = p.ch, j = p.ch;
  while (i > 0 && w.test(l[i - 1])) i--;
  while (j < l.length && w.test(l[j])) j++;
  if (l[i - 1] === "\\" && l[i - 2] !== "\\" && /^[a-zA-Z]+$/.test(l.slice(i, j))) i--;
  return [at(p.line, i), at(p.line, j)];
}
// The charwise visual selection just left at the cursor (:obcommand from visual exits it first), or null.
function lastVisual(cm, cur, lines) {
  const ls = cm && cm.state && cm.state.vim && cm.state.vim.lastSelection;
  if (!ls || ls.visualLine || ls.visualBlock || !ls.anchorMark || !ls.headMark) return null;
  const a = ls.anchorMark.find && ls.anchorMark.find(), h = ls.headMark.find && ls.headMark.find();
  if (!a || !h || (cmp(h, cur) && cmp(a, cur))) return null;
  const [from, last] = cmp(a, h) <= 0 ? [a, h] : [h, a];
  const l = lines[last.line];
  return l == null ? null : [at(from.line, from.ch), at(last.line, Math.min(last.ch + 1, l.length))]; // Vim's selection includes its last character
}

// Size bracket: ( ) [ ] \{ \} ⇄ \left( \right) … — the nearest bracket of any kind that can be
// sized (a bare { } is LaTeX grouping, the ⟦ ⟧ intervals and \big( \big) are sized already).
const sizable = (lines, s) => !/^\{$|\\!|^\\[bB]ig/.test(slice(lines, s.a, s.ae));
function sizeChanges(lines, s) {
  const open = slice(lines, s.a, s.ae), close = slice(lines, s.bs, s.b);
  if (!/^\\left/.test(open)) return [{ from: s.a, to: s.a, text: "\\left" }, { from: s.bs, to: s.bs, text: "\\right" }];
  const lw = /^\\left\s*/.exec(open)[0].length, rw = /^\\right\s*/.exec(close)[0].length;
  return [{ from: s.a, to: at(s.a.line, s.a.ch + lw), text: "" }, { from: s.bs, to: at(s.bs.line, s.bs.ch + rw), text: "" }];
}

// Last selected character of a visual selection covering [start, end), or null when empty.
// CodeMirror Vim can't END a visual selection on an astral character (😀, 𝔸 — two UTF-16
// units) that follows others: its own vi( / v$ then also delete the closing bracket
// (measured live). So such a character is left out of the selection — never split, never
// overshot; alone, it is selected (that case works). Operators (dim, cib…) are unaffected.
const isHigh = (l, ch) => { const c = l.charCodeAt(ch); return c >= 0xd800 && c <= 0xdbff; };
const isLow = (l, ch) => { const c = l.charCodeAt(ch); return c >= 0xdc00 && c <= 0xdfff; };
function charBefore(lines, p) {
  if (p.ch > 0) return at(p.line, isLow(lines[p.line], p.ch - 1) && p.ch > 1 ? p.ch - 2 : p.ch - 1);
  return p.line > 0 ? at(p.line - 1, lines[p.line - 1].length) : null;
}
function visualEnd(lines, start, end) {
  let e = charBefore(lines, end);
  while (e && isHigh(lines[e.line], e.ch) && cmp(e, start) > 0) e = charBefore(lines, e);
  return e && cmp(e, start) >= 0 ? e : null;
}

// ]m [m ]e [e ]c ]a …: the count-th span starting after (forward) / before the cursor, or the last
// one that exists (like Vim's 9]] stopping at the last section). No seek limit: it only moves.
// `land`: where a span is reached (]a lands inside the argument, the rest on their start).
function jump(spans, pos, forward, count = 1, land = s => s.a) {
  const c = spans.filter(s => (forward ? cmp(land(s), pos) > 0 : cmp(land(s), pos) < 0)).sort((x, y) => (forward ? 1 : -1) * cmp(land(x), land(y)));
  return c[Math.min(count, c.length) - 1] || null;
}

// What visual mode shows for a range: {start, last} (last character included), or null.
function image(lines, r) {
  if (r.linewise) return { start: r.start, last: r.end };
  const last = visualEnd(lines, r.start, r.end);
  return last && { start: r.start, last };
}
// Repeating ie / ib / ae … in visual mode grows like mini.ai: the innermost span whose
// selection is strictly bigger than the current one. null when there is nothing bigger.
function grow(spans, lines, sel, inner) {
  let best = null;
  for (const s of spans) {
    const r = range(s, lines, inner), im = image(lines, r);
    if (!im || cmp(im.start, sel.start) > 0 || cmp(im.last, sel.last) < 0) continue;
    if (!cmp(im.start, sel.start) && !cmp(im.last, sel.last)) continue;
    if (!best || cmp(s.a, best.s.a) > 0) best = { s, r };
  }
  return best && best.r;
}

// ─── Vim wiring ────────────────────────────────────────────────────────────────
const KEYS = [];
// c is two span lists under one key: ic = one argument, ac = the whole command
for (const [ch, obj] of [["m", "math"], ["M", "display"], ["e", "env"], ["b", "paren"], ["B", "brace"], ["r", "square"], ["c", null],
  ["^", "sup"], ["_", "sub"], ["&", "cell"], ["R", "row"]])
  for (const [mid, which] of [["", "cur"], ["n", "next"], ["l", "last"]])
    for (const inner of [true, false]) KEYS.push([(inner ? "i" : "a") + mid + ch, { obj: obj || (inner ? "arg" : "command"), which, inner }]);
const OBJ_KEYS = "mMebBrc^_&R";
// the private keys stockKey sends: <LxO-inm> … for the n / l objects, <LxRep-f/b> for ; ,
const ALIASES = KEYS.filter(([k]) => k.length === 3).map(([k, args]) => [`<LxO-${k}>`, args]);
const REPEATS = [["<LxRep-f>", { forward: true }], ["<LxRep-b>", { forward: false }]];
// ]C [C ask for a name; once it is typed, <LxGo> makes the move (as a ; would)
const NAMED = [["]C", { forward: true }], ["[C", { forward: false }]], GO = [["<LxGo>", { forward: true }]];
const MATCH = [["<LxPct>", {}]]; // the private key matchKey sends for % on our delimiters
// >, <, >& <&: the private keys swapKey sends, mapped to the swap action
const SWAPS = [["<LxSwap-a>", { what: "arg", forward: true }], ["<LxSwap-A>", { what: "arg", forward: false }],
  ["<LxSwap-c>", { what: "cell", forward: true }], ["<LxSwap-C>", { what: "cell", forward: false }]];
const JUMPS = [["]m", { obj: "math", forward: true }], ["[m", { obj: "math", forward: false }],
  ["]M", { obj: "display", forward: true }], ["[M", { obj: "display", forward: false }],
  ["]e", { obj: "env", forward: true }], ["[e", { obj: "env", forward: false }],
  ["](", { obj: "paren", forward: true }], ["[(", { obj: "paren", forward: false }],
  ["]{", { obj: "brace", forward: true }], ["[{", { obj: "brace", forward: false }],
  ["]c", { obj: "command", forward: true }], ["[c", { obj: "command", forward: false }],
  ["]a", { obj: "arg", forward: true }], ["[a", { obj: "arg", forward: false }]];

const NONE = { math: "No $…$ or $$…$$ near the cursor", display: "No $$…$$ near the cursor", env: "No \\begin{…} near the cursor", paren: "No ( ) near the cursor", brace: "No { } near the cursor", square: "No [ ] near the cursor", command: "No command near the cursor", arg: "No argument near the cursor",
  sup: "No ^ near the cursor", sub: "No _ near the cursor", cell: "Not in a cell: no \\begin{…} with & near the cursor", row: "Not in a row: no \\begin{…} with \\\\ or & near the cursor" };
const lineArray = cm => cm.getValue().split("\n");

// The CM Vim adapter of an Obsidian editor. Vim Motions keeps it private (not on view.cm),
// so find it on the view plugin that holds it.
// Note: reads CodeMirror's private view.plugins; if it moves, Rename environment just won't copy the name to \end.
function vimAdapter(editor) {
  const view = editor.cm;
  if (!view) return null;
  if (view.cm) return view.cm;
  const hit = (view.plugins || []).map(p => p.value).find(v => v && v.cm && v.cm.state && v.cm.state.vim);
  return hit ? hit.cm : null;
}

// CM Vim motion: return [anchor, head] and let Vim apply the pending operator / selection.
function latexObj(cm, head, args, vim, inputState) {
  const lines = lineArray(cm), spans = SPANS[args.obj](lines), count = args.repeat || 1;
  // visual with a selection: iB grows out of it, inB / ilB step into it
  const sel = vim.visualMode ? selection(lines, vim) : null;
  let r = sel && (args.which === "cur" ? growN(spans, lines, sel, args.inner, count) : shrink(spans, lines, sel, args.which, args.inner, count));
  if (!r) {
    r = args.obj === "arg" ? icPick(lines, at(head.line, head.ch), args.which, count) : countPick(spans, lines, at(head.line, head.ch), args.which, args.inner, count);
    if (!r) { new Notice(count > 1 ? `${NONE[args.obj]} (${count} wanted)` : NONE[args.obj]); return null; }
  }
  if (vim.visualMode) {
    // the object decides the visual kind: linewise ranges → V, the rest → v (even from V / Ctrl-v)
    const kind = !!r.linewise;
    if (vim.visualLine !== kind || vim.visualBlock) {
      vim.visualLine = kind;
      vim.visualBlock = false;
      const A = window.CodeMirrorAdapter;
      if (A && A.signal) A.signal(cm, "vim-mode-change", { mode: "visual", subMode: kind ? "linewise" : "" });
    }
    if (kind) return [r.start, r.end];
    // visual selections include the head character: end one character before
    const end = visualEnd(lines, r.start, r.end);
    // nothing to select ($$, ()): leave visual with the cursor inside, ready for i
    if (!end) {
      const Vim = window.CodeMirrorAdapter && window.CodeMirrorAdapter.Vim;
      if (Vim && Vim.exitVisualMode) Vim.exitVisualMode(cm);
      cm.setCursor(r.start);
      new Notice("Empty — i to type inside");
      return null;
    }
    madeSel = cmp(r.start, end) ? null : `${end.line}:${end.ch}`;
    return [r.start, end];
  }
  args.linewise = !!r.linewise;
  args.inclusive = false;
  if (r.linewise && inputState && inputState.operatorArgs) inputState.operatorArgs.linewise = true;
  // y, >, gU … leave the text in place: flash it, so a seek that went off the cursor shows where
  if (inputState && inputState.operator && !/^(delete|change)$/.test(inputState.operator)) flashLater(cm, r);
  return [r.start, r.end];
}

// Visual mode with a selection (more than one character, linewise, or the one we just made)
// as {start, last}, else null. A plain one-character selection is where `v` left you, so the
// object seeks as usual; but the b of (b) that vib / inb selected still grows / steps.
// The key being handled: was Vim in visual mode, where was the cursor. A mapped :obcommand
// runs inside it, after Vim has changed both: a vnoremap'd one has left visual already, and
// Vim Motions puts the last visual selection back even from normal mode (stale, anywhere).
let keyAt = null;
let madeSel = null; // "line:ch" of the last one-character visual object we returned
function selection(lines, vim) {
  const { anchor, head } = vim.sel;
  if (!vim.visualLine && !cmp(anchor, head) && madeSel !== `${head.line}:${head.ch}`) return null;
  let [start, last] = cmp(anchor, head) < 0 ? [anchor, head] : [head, anchor];
  if (vim.visualLine) { start = at(start.line, 0); last = at(last.line, lines[last.line].length); }
  return { start: at(start.line, start.ch), last: at(last.line, last.ch) };
}
// Repeating the object grows it, count times (v2iB from inside {b} → two levels out).
function growN(spans, lines, sel, inner, count) {
  let r = null;
  for (let i = 0; i < count; i++) {
    r = grow(spans, lines, sel, inner);
    if (!r) return null;
    sel = image(lines, r) || { start: r.start, last: r.start };
  }
  return r;
}

// ]m [m ]e [e — a motion, so d]m, y[e, v]m and counts work too.
let lastJump = null; // {obj, forward, name?} of the last ]x / [x / ]C name, until an f F t T
function latexJump(cm, head, args) {
  if (!args.again) lastJump = { obj: args.obj, forward: args.forward, name: args.name };
  const land = args.obj === "arg" ? g => g.ae : x => x.a;
  const s = jump(spansFor(args.obj, lineArray(cm), args.name), at(head.line, head.ch), args.forward, args.repeat || 1, land);
  if (!s && args.obj === "named") new Notice(`No \\${args.name} ${args.forward ? "below" : "above"}`);
  // A plain jump (normal/visual, no d]m etc.) lands like `zz`, once Vim has moved the cursor.
  const view = cm.cm6;
  if (s && view && CMView && !cm.state.vim?.inputState?.operator) view.dom.ownerDocument.defaultView.setTimeout(() => view.dispatch({ effects: CMView.EditorView.scrollIntoView(view.state.selection.main.head, { y: "center" }) }));
  return s ? land(s) : null;
}

// ; and , repeat the last ]x / [x (, the other way), else Vim's own f / t repeat.
const againJump = (cm, head, args) => latexJump(cm, head, { obj: lastJump.obj, name: lastJump.name, forward: args.forward ? lastJump.forward : !lastJump.forward, repeat: args.repeat, again: true });
function repeatJump(orig) {
  return (cm, head, args, vim, inputState) => lastJump ? againJump(cm, head, args) : orig(cm, head, args, vim, inputState);
}
// ]C [C: ask for a name, then jump like ]c to the next / previous \name; ; , repeat it.
// The prompt answers after this motion has returned (null: nothing moves yet), so the move
// is <LxGo>, with the count, in whatever mode Vim is in then (normal or visual).
function latexNamedPrompt(cm, head, args, vim, inputState) {
  if (inputState && inputState.operator) { new Notice("]C and [C work in normal and visual mode"); return null; }
  const count = args.repeatIsExplicit ? args.repeat : 0;
  promptName(cm.cm6, { placeholder: (args.forward ? "]C" : "[C") + "  command name", names: commandNames(lineArray(cm)) }).then(name => {
    const Vim = window.CodeMirrorAdapter && window.CodeMirrorAdapter.Vim;
    if (!name || !Vim) return;
    lastJump = { obj: "named", name, forward: args.forward };
    for (const k of count ? String(count) : "") Vim.handleKey(cm, k, "user");
    Vim.handleKey(cm, "<LxGo>", "user");
  });
  return null;
}
// % on one of our delimiters (only matchKey sends it). . replaying d% somewhere else: nothing.
function latexMatch(cm, head, args, vim, inputState) {
  const d = delimAtCm(cm, at(head.line, head.ch));
  if (!d) return null;
  return matchTarget(d, !!(inputState && inputState.operator), !!vim.visualMode);
}
// % is caught here, in both Vims: on \begin \end, \left \right or $ $$ (no count typed:
// 50% is Vim's) it becomes <LxPct>; anywhere else it goes on to Vim's own %.
function matchKey(e, cm) {
  const Vim = window.CodeMirrorAdapter && window.CodeMirrorAdapter.Vim, vim = cm && cm.state && cm.state.vim;
  if (e.key !== "%" || !active.match || !Vim || !vim || vim.insertMode || e.ctrlKey || e.metaKey || e.altKey || !(cm.cm6 && cm.cm6.hasFocus)) return false;
  const st = vim.inputState;
  if ((st.prefixRepeat || []).length || (st.motionRepeat || []).length || [].concat(st.keyBuffer || []).length) return false;
  const head = vim.visualMode ? vim.sel.head : cm.getCursor();
  if (!delimAtCm(cm, at(head.line, head.ch))) return false;
  e.preventDefault();
  e.stopImmediatePropagation();
  Vim.handleKey(cm, "<LxPct>", "user");
  return true;
}
// f F t T hand ; , back to Vim. A keydown, not a wrapped motion: Vim Motions keeps its own
// reference to moveToCharacter. Note: `rf` / `mf` clear it too — harmless, ; then does f's job.
function onKeydown(e, cm) {
  if (holding || (e.target && e.target.classList && e.target.classList.contains("latex-objects-prompt"))) return; // typing a name
  if (cm && cm.state.vim) { keyAt = { visual: !!cm.state.vim.visualMode, cur: cm.getCursor() }; window.setTimeout(() => (keyAt = null), 0); }
  if (matchKey(e, cm) || swapKey(e, cm) || stockKey(e, cm)) return;
  if (e.key === "v" || e.key === "V") madeSel = null; // a new visual selection (v V Ctrl-v)
  if (e.key.length === 1 && "fFtT".includes(e.key) && !e.ctrlKey && !e.metaKey && !(cm && cm.state.vim && cm.state.vim.insertMode)) lastJump = null;
}

// >, <, >& <&: Vim reads > / < as the indent operator before the , or & comes (a full match
// wins over a longer one), so a , or & right after it is caught here: the operator is dropped
// and the count and one private key go to Vim, mapped to the swap action (so `.` repeats it).
function swapKey(e, cm) {
  const Vim = window.CodeMirrorAdapter && window.CodeMirrorAdapter.Vim, vim = cm && cm.state && cm.state.vim;
  if ((e.key !== "," && e.key !== "&") || !Vim || !vim || vim.insertMode || vim.visualMode || e.ctrlKey || e.metaKey || e.altKey || !(cm.cm6 && cm.cm6.hasFocus)) return false;
  const st = vim.inputState;
  if (!st || st.operator !== "indent" || [].concat(st.keyBuffer || []).length) return false;
  const count = st.getRepeat ? st.getRepeat() : 0, fwd = !!(st.operatorArgs && st.operatorArgs.indentRight);
  e.preventDefault(); e.stopImmediatePropagation();
  Vim.handleKey(cm, "<Esc>", "user");
  for (const d of count > 1 ? String(count) : "") Vim.handleKey(cm, d, "user");
  Vim.handleKey(cm, `<LxSwap-${e.key === "," ? (fwd ? "a" : "A") : fwd ? "c" : "C"}>`, "user");
  return true;
}
function latexSwap(cm, args) {
  const cur = cm.getCursor(), r = swapAt(lineArray(cm), at(cur.line, cur.ch), args.what, args.forward, args.repeat || 1);
  if (r.none) { new Notice(r.none); return; }
  const [c] = r.changes;
  cm.replaceRange(c.text, c.from, c.to);
  cm.setCursor(r.cursor);
}
// Obsidian's own Vim (no getMotion, unlike Vim Motions) takes `in` as Vim's text object `n`
// before the m of `inm` arrives (any full match wins over a longer partial one), and gives
// no way to wrap ; and ,. There the keys are caught here and handed to Vim as one private
// key mapped to the same motion, so the operator, the count and `.` all still work.
let pending = null; // "in" / "al" … held back from Vim until the object key
function stockKey(e, cm) {
  const Vim = window.CodeMirrorAdapter && window.CodeMirrorAdapter.Vim, vim = cm && cm.state && cm.state.vim;
  if (!Vim || Vim.getMotion || !vim || vim.insertMode || e.ctrlKey || e.metaKey || e.altKey || !(cm.cm6 && cm.cm6.hasFocus)) { pending = null; return false; }
  if (e.key.length > 1 && e.key !== "Escape") return false; // Shift on its way to M / B
  const st = vim.inputState, buf = [].concat(st.keyBuffer || []).join("");
  const swallow = key => { e.preventDefault(); e.stopImmediatePropagation(); st.keyBuffer = []; Vim.handleKey(cm, key, "user"); return true; };
  if (pending) {
    const p = pending;
    pending = null;
    if (OBJ_KEYS.includes(e.key)) return swallow(`<LxO-${p}${e.key}>`);
    Vim.handleKey(cm, p[1], "user"); // not ours: give Vim back the n / l, then this key as usual
    return false;
  }
  if ((buf === "i" || buf === "a") && (st.operator || vim.visualMode) && (e.key === "n" || e.key === "l")) {
    e.preventDefault(); e.stopImmediatePropagation();
    pending = buf + e.key;
    return true;
  }
  if ((e.key === ";" || e.key === ",") && !buf && lastJump && active.jumps && active.repeatJumps) return swallow(e.key === ";" ? "<LxRep-f>" : "<LxRep-b>");
  return false;
}

// ─── Flash (like nvim's highlight-on-yank) ────────────────────────────────────
const flashEffect = CMState && CMState.StateEffect.define();
const flashField = CMState && CMView && CMState.StateField.define({
  create: () => CMView.Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(flashEffect)) {
      deco = e.value ? CMView.Decoration.set(flashRanges(tr.state.doc, e.value.from, e.value.to), true) : CMView.Decoration.none;
    }
    return deco;
  },
  provide: f => CMView.EditorView.decorations.from(f),
});
// The text itself, and its lines: Live Preview draws maths away from the cursor as a rendered
// widget, which hides a mark on the source, but the line background still shows.
function flashRanges(doc, from, to) {
  const out = [CMView.Decoration.mark({ class: "latex-objects-flash" }).range(from, to)];
  for (let l = doc.lineAt(from).number; l <= doc.lineAt(to).number; l++)
    out.push(CMView.Decoration.line({ class: "latex-objects-flash-line" }).range(doc.line(l).from));
  return out;
}
// After the operator ran (same positions: y, >, gU don't move lines), mark the range briefly.
function flashLater(cm, r) {
  const view = cm.cm6;
  if (!flashField || !view || !CONFIG.flash) return;
  const win = view.dom.ownerDocument.defaultView;
  win.setTimeout(() => {
    const doc = view.state.doc;
    const off = p => (p.line < doc.lines ? Math.min(doc.line(p.line + 1).from + p.ch, doc.line(p.line + 1).to) : doc.length);
    const from = off(r.start), to = off(r.end);
    if (from >= to || !view.dom.isConnected || !view.state.field(flashField, false)) return;
    view.dispatch({ effects: flashEffect.of({ from, to }) });
    win.setTimeout(() => view.dom.isConnected && view.dispatch({ effects: flashEffect.of(null) }), CONFIG.flashMs);
  }, 0);
}

// ─── Match highlight (like matchparen) ────────────────────────────────────────
// The cursor on \begin{…} \end{…}, \left… \right… or $ / $$ marks it and its partner.
// Only lines that could hold one get the full scan; big notes are skipped.
// \begin{name} / \left( count as a whole, so the cursor anywhere on one passes (delimAt decides).
// (its delimiter is never a \left / \right itself: \left\left( is two tokens, the ( in the second)
const DELIM_TOKEN = /\\(?:begin|end)(?:\{[^}]*\})?|\\(?:left|right)\s*(?:([[\]])\s*\\!\s*\\(?:left|right)\s*\1|\\(?!(?:left|right)(?![a-zA-Z]))(?:[a-zA-Z]+|.)|[^\\])?/g;
function mayBeDelim(line, ch) {
  if (line[ch] === "$") return true;
  for (const m of line.matchAll(DELIM_TOKEN)) if (ch >= m.index && ch < m.index + m[0].length) return true;
  return false;
}
function matchDeco(view) {
  const doc = view.state.doc;
  if (!CONFIG.highlight || doc.lines > 5000) return CMView.Decoration.none;
  const head = view.state.selection.main.head, line = doc.lineAt(head), ch = head - line.from;
  if (!mayBeDelim(line.text, ch)) return CMView.Decoration.none;
  const d = delimAtDoc(doc, at(line.number - 1, ch));
  if (!d) return CMView.Decoration.none;
  const off = p => doc.line(p.line + 1).from + p.ch, mark = CMView.Decoration.mark({ class: "latex-objects-match" });
  return CMView.Decoration.set([d.here, d.there].map(([p, q]) => mark.range(off(p), off(q))), true);
}
const matchPlugin = CMView && CMView.ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = matchDeco(view); this.on = CONFIG.highlight; }
  // The setting can flip with no cursor move (updateOptions): rebuild then too.
  update(u) {
    if (u.docChanged || u.selectionSet || this.on !== CONFIG.highlight) { this.on = CONFIG.highlight; this.decorations = matchDeco(u.view); }
  }
}, { decorations: v => v.decorations });

// ds / cs go through Vim Motions' own "surroundAction" (keys s<character> after an operator):
// wrap it, take bracket targets with d / c, hand everything else (ys, ds m, cs " ' …) back.
function surroundAction(orig) {
  const fn = (cm, args, vim) => {
    const target = TARGET[args.selectedCharacter], op = args.pendingOperator;
    if (args.selectedCharacter === "c" && (op === "delete" || op === "change")) return commandSurround(cm, op, vim);
    if (!target || (op !== "delete" && op !== "change")) return orig(cm, args, vim);
    const lines = lineArray(cm), head = cm.getCursor(), s = pick(SPANS[OBJ_OF[target]](lines), at(head.line, head.ch), "cur");
    if (!s) return new Notice(NONE[OBJ_OF[target]]);
    const run = repl => {
      if (repl && !TARGET[repl]) return new Notice("cs: replace a bracket with b B r ( ) { } [ ]");
      dispatchChanges(cm, surroundChanges(lines, s, args.selectedCharacter, repl, inMathsAt(lines, s.a)));
      cm.setCursor(s.a);
    };
    if (op === "delete") return run(null);
    // . repeat replays this same input state: the replacement typed the first time is on it
    const st = vim.lastEditInputState;
    if (st && st._latexRepl) return run(st._latexRepl);
    nextKey(k => { if (k) { if (st) st._latexRepl = k; run(k); } });
  };
  fn.latexOrig = orig;
  return fn;
}
// dsc: the nearest command → the argument kept; csc: asks for its new name. . repeats csc
// with the same name (kept on the input state . replays, like cs's replacement).
function commandSurround(cm, op, vim) {
  const lines = lineArray(cm), head = cm.getCursor(), pos = at(head.line, head.ch), s = pick(SPANS.command(lines), pos, "cur");
  if (!s) return new Notice(NONE.command);
  if (op === "delete") { dispatchChanges(cm, dscChanges(lines, s, keptArg(s, pos))); return cm.setCursor(s.a); }
  const run = name => { dispatchChanges(cm, cscChanges(s, name)); cm.setCursor(s.a); };
  const st = vim.lastEditInputState;
  if (st && st._latexName) return run(st._latexName);
  promptName(cm.cm6, { placeholder: "New name for \\" + s.name, names: commandNames(lines), star: true }).then(name => {
    if (!name || cm.getValue() !== lines.join("\n")) return;
    if (st) st._latexName = name;
    run(name);
  });
}
// The next typed character (AltGr / Shift / dead keys wait for it), or null on anything else.
function nextKey(cb) {
  const on = e => {
    if (["Shift", "Control", "Alt", "AltGraph", "Meta", "CapsLock", "Dead"].includes(e.key)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    window.removeEventListener("keydown", on, true);
    cb(e.key.length === 1 && !e.ctrlKey && !e.metaKey ? e.key : null);
  };
  window.addEventListener("keydown", on, true);
}
// ─── the name prompt (]C [C, csc, Wrap in command) ────────────────────────────
// What was typed, a leading \ ignored; the names it completes to; their common start; and
// whether it is a command name (letters, a trailing * when `star`: csc on align → align*).
const unslash = s => s.replace(/^\\/, "");
const completions = (typed, names) => names.filter(n => n.startsWith(unslash(typed)));
function commonPrefix(list) {
  if (!list.length) return "";
  let p = list[0];
  for (const s of list) while (!s.startsWith(p)) p = p.slice(0, -1);
  return p;
}
const validName = (typed, star = false) => (star ? /^[A-Za-z]+\*?$/ : /^[A-Za-z]+$/).test(unslash(typed.trim()));
// A one-line input at the cursor. Tab completes to the common start of the names, then
// cycles them (Shift-Tab back); Enter accepts; Esc, an empty Enter or leaving it → null.
// Its keys never reach Vim. Opened after the current key is handled (Vim is mid-key now);
// keys typed before it is there are kept and go into it (onKeydown leaves them alone).
let holding = 0;
function promptName(view, { placeholder, names, star = false }) {
  return new Promise(done => {
    // the editor's own document: a popout window has its own
    const doc = (view && view.dom && view.dom.ownerDocument) || (typeof document !== "undefined" && document);
    if (!view || !doc) return done(null);
    const early = [], win = doc.defaultView || doc;
    const hold = e => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || !(e.key.length === 1 || ["Enter", "Escape", "Backspace"].includes(e.key))) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      early.push(e.key);
    };
    win.addEventListener("keydown", hold, true);
    holding++;
    win.setTimeout(() => {
      win.removeEventListener("keydown", hold, true);
      holding--;
      const c = view.coordsAtPos(view.state.selection.main.head) || { left: 0, bottom: 0 };
      const input = doc.body.createEl("input", { cls: "latex-objects-prompt", attr: { placeholder } });
      input.setCssProps({ "--latex-objects-left": c.left + "px", "--latex-objects-top": c.bottom + 2 + "px" });
      let cycle = null, finished = false;
      const finish = value => {
        if (finished) return;
        finished = true;
        input.remove();
        view.focus();
        if (value === null || !unslash(value.trim())) return done(null);
        if (!validName(value, star)) { new Notice(`Not a command name: ${value.trim()}`); return done(null); }
        done(unslash(value.trim()));
      };
      input.addEventListener("keydown", e => {
        e.stopPropagation();
        if (e.isComposing) return; // an IME is still composing: its Enter is not ours
        if (e.key === "Enter") { e.preventDefault(); finish(input.value); }
        else if (e.key === "Escape") { e.preventDefault(); finish(null); }
        else if (e.key === "Tab") {
          e.preventDefault();
          if (!cycle) {
            const list = completions(input.value, names), p = commonPrefix(list);
            if (!list.length) return;
            if (p.length > unslash(input.value).length) { input.value = p; return; }
            cycle = { list, k: e.shiftKey ? list.length - 1 : 0 };
          } else cycle.k = (cycle.k + (e.shiftKey ? -1 : 1) + cycle.list.length) % cycle.list.length;
          input.value = cycle.list[cycle.k];
        } else cycle = null;
      });
      input.addEventListener("blur", () => finish(null));
      input.focus();
      for (const k of early) {
        if (k === "Enter") return finish(input.value);
        if (k === "Escape") return finish(null);
        input.value = k === "Backspace" ? input.value.slice(0, -1) : input.value + k;
      }
    }, 0);
  });
}
// One transaction = one undo step.
function dispatchChanges(cm, changes) {
  const view = cm.cm6, off = p => cm.indexFromPos(p);
  view.dispatch({ changes: changes.map(c => ({ from: off(c.from), to: off(c.to), insert: c.text })) });
}

// Idempotent: drop our keys, then add them (so they never pile up). The Vim object is looked
// up fresh each time: Vim Motions deletes it when it unloads. `opts` says which groups are on.
const OPTS = { jumps: true, repeatJumps: true, surround: true, match: true };
let active = OPTS; // the groups register() last turned on
function register(opts = OPTS) {
  const Vim = window.CodeMirrorAdapter && window.CodeMirrorAdapter.Vim;
  if (!Vim) return;
  unregister();
  active = opts;
  Vim.defineMotion("latexObj", latexObj);
  Vim.defineMotion("latexJump", latexJump);
  Vim.defineMotion("latexRepeat", (cm, head, args) => lastJump ? againJump(cm, head, args) : head);
  Vim.defineMotion("latexNamedPrompt", latexNamedPrompt);
  Vim.defineMotion("latexMatch", latexMatch);
  Vim.defineAction("latexSwap", latexSwap);
  for (const [keys, args] of SWAPS) {
    dropKeys(Vim, keys);
    Vim.mapCommand(keys, "action", "latexSwap", args, { isEdit: true, context: "normal" });
  }
  const repeats = opts.jumps && opts.repeatJumps ? REPEATS : [];
  for (const [motion, list] of [["latexObj", [...KEYS, ...ALIASES]], ["latexJump", opts.jumps ? JUMPS : []], ["latexRepeat", [...repeats, ...(opts.jumps ? GO : [])]],
    ["latexNamedPrompt", opts.jumps ? NAMED : []], ["latexMatch", opts.match ? MATCH : []]]) for (const [keys, args] of list) {
    dropKeys(Vim, keys);
    Vim.mapCommand(keys, "motion", motion, args);
  }
  const cur = Vim.getAction && Vim.getAction("surroundAction");
  if (opts.surround && cur && !cur.latexOrig) Vim.defineAction("surroundAction", surroundAction(cur));
  // getMotion hands back a fresh bound copy each time (no flag survives on it), so the true
  // original is kept on the Vim object, which dies with it when Vim Motions unloads.
  if (opts.jumps && opts.repeatJumps) {
    if (!Vim.latexRepeatOrig && Vim.getMotion) Vim.latexRepeatOrig = Vim.getMotion("repeatLastCharacterSearch");
    if (Vim.latexRepeatOrig) Vim.defineMotion("repeatLastCharacterSearch", repeatJump(Vim.latexRepeatOrig));
  }
}
// Obsidian's own Vim has no removeMapCommand; its unmap drops the first context-less entry
// with these keys, which is what mapCommand made (so repeat until none is left).
function dropKeys(Vim, keys) {
  if (Vim.removeMapCommand) Vim.removeMapCommand(keys);
  else if (Vim.unmap) for (let i = 0; i < 50 && Vim.unmap(keys); i++);
}
function unregister() {
  const Vim = window.CodeMirrorAdapter && window.CodeMirrorAdapter.Vim;
  if (Vim) for (const [keys] of [...KEYS, ...ALIASES, ...JUMPS, ...REPEATS, ...NAMED, ...GO, ...MATCH, ...SWAPS]) dropKeys(Vim, keys);
  const cur = Vim && Vim.getAction && Vim.getAction("surroundAction");
  if (cur && cur.latexOrig) Vim.defineAction("surroundAction", cur.latexOrig);
  if (Vim && Vim.latexRepeatOrig) { Vim.defineMotion("repeatLastCharacterSearch", Vim.latexRepeatOrig); delete Vim.latexRepeatOrig; }
}

const DEFAULTS = { seekLines: 50, jumps: true, repeatJumps: true, surround: true, match: true, highlight: true, flash: true, flashMs: 250 };
// Saved data → settings, bad or missing values back to their default.
function cleanSettings(data) {
  const d = Object.assign({}, DEFAULTS, data || {}), out = {};
  for (const k of Object.keys(DEFAULTS)) {
    const v = d[k], def = DEFAULTS[k];
    out[k] = typeof def === "boolean" ? (typeof v === "boolean" ? v : def)
      : Number.isFinite(v) ? Math.round(Math.min(Math.max(v, k === "seekLines" ? 1 : 0), k === "seekLines" ? 1000 : 5000)) : def;
  }
  return out;
}

// Run from a normal-mode key, a command finds a selection only if Vim Motions' :obcommand put
// the last visual one back: drop it, the cursor goes back where the key was pressed.
function unstale(editor) {
  const cm = vimAdapter(editor), vim = cm && cm.state && cm.state.vim;
  if (!keyAt || keyAt.visual || !vim || vim.visualMode || !editor.somethingSelected()) return;
  editor.setCursor(keyAt.cur);
}

class LatexObjects extends Plugin {
  async onload() {
    this.patched = [];
    await this.loadSettings();
    this.addSettingTab(new LatexObjectsSettings(this.app, this));
    if (flashField) this.registerEditorExtension(flashField);
    if (matchPlugin) this.registerEditorExtension(matchPlugin);
    this.app.workspace.onLayoutReady(() => { this.patchReloads(); this.applyKeys(); });
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => { this.patchReloads(); this.applyKeys(); }));
    this.registerDomEvent(window, "keydown", e => onKeydown(e, this.app.workspace.activeEditor && vimAdapter(this.app.workspace.activeEditor.editor)), true);

    const cmd = (id, name, fn) => this.addCommand({ id, name, editorCallback: editor => { unstale(editor); fn(editor); } });
    cmd("unwrap-math", "Unwrap maths (delete $ / $$, keep the maths)", ed => this.edit(ed, "math", unwrapChanges));
    cmd("delete-math", "Delete maths with its $ / $$", ed => this.edit(ed, "math", deleteChanges));
    cmd("toggle-math", "Toggle inline / display maths", ed => this.edit(ed, "math", toggleChanges));
    cmd("align-math", "Turn the maths under the cursor into align", ed => {
      const lines = ed.getValue().split("\n"), pos = ed.getCursor(), s = around(mathSpans(lines), at(pos.line, pos.ch));
      if (!s) return new Notice("Not in maths: put the cursor inside $…$ or $$…$$");
      const changes = alignChanges(lines, s);
      if (!changes) return new Notice("Already align");
      this.commit(ed, lines, changes, pos);
    });
    cmd("unwrap-env", "Unwrap environment (delete \\begin / \\end, keep the content)", ed => this.edit(ed, "env", envUnwrapChanges));
    cmd("star-env", "Toggle environment star", ed => this.edit(ed, "env", (l, s) => starChanges(s)));
    cmd("rename-env", "Rename environment", ed => this.renameEnv(ed));
    cmd("size-bracket", "Toggle \\left \\right on the nearest bracket", ed => {
      const lines = ed.getValue().split("\n"), pos = ed.getCursor();
      const s = pick(bracketSpans(lines).filter(b => sizable(lines, b)), at(pos.line, pos.ch), "cur");
      if (!s) return new Notice("No ( ), [ ] or \\{ \\} near the cursor");
      this.commit(ed, lines, sizeChanges(lines, s), pos);
    });
    cmd("delete-command", "Delete command, keep its argument", ed => this.edit(ed, "command", (l, s) => dscChanges(l, s, keptArg(s, ed.getCursor()))));
    cmd("rename-command", "Rename command", ed => {
      const f = this.find(ed, "command");
      if (!f) return;
      promptName(ed.cm, { placeholder: "New name for \\" + f.s.name, names: commandNames(f.lines), star: true }).then(name => {
        if (name && ed.getValue() === f.lines.join("\n")) this.commit(ed, f.lines, cscChanges(f.s, name), f.pos);
      });
    });
    cmd("wrap-command", "Wrap in command", ed => {
      const lines = ed.getValue().split("\n"), sel = ed.listSelections()[0];
      let [from, to] = cmp(sel.anchor, sel.head) <= 0 ? [sel.anchor, sel.head] : [sel.head, sel.anchor];
      from = at(from.line, from.ch); to = at(to.line, to.ch);
      const cm = vimAdapter(ed), Vim = window.CodeMirrorAdapter && window.CodeMirrorAdapter.Vim;
      if (!cmp(from, to)) {
        let w = null;
        if (keyAt && keyAt.visual) try { w = lastVisual(cm, from, lines); } catch { /* private Vim state: never let it break the command */ }
        w = w || wordAt(lines, from);
        if (!w) return new Notice("Nothing to wrap: select text or put the cursor on a word");
        [from, to] = w;
      }
      promptName(ed.cm, { placeholder: "Wrap in \\…{ }", names: commandNames(lines) }).then(name => {
        if (!name || ed.getValue() !== lines.join("\n")) return;
        if (cm && cm.state.vim && cm.state.vim.visualMode && Vim && Vim.exitVisualMode) Vim.exitVisualMode(cm);
        ed.transaction({ changes: wrapChanges(lines, from, to, name) });
        ed.setCursor(from);
      });
    });
  }

  onunload() {
    unregister();
    for (const [obj, name, orig] of this.patched) obj[name] = orig;
  }

  async loadSettings() {
    this.settings = cleanSettings(await this.loadData());
    this.applyConfig();
  }
  async saveSettings() {
    this.settings = cleanSettings(this.settings);
    await this.saveData(this.settings);
    this.applyConfig();
    this.app.workspace.updateOptions(); // re-run editor extensions so the highlight setting applies now
    this.applyKeys();
  }
  applyConfig() {
    const { seekLines, flash, flashMs, highlight } = this.settings;
    Object.assign(CONFIG, { seekLines, flash, flashMs, highlight });
  }
  applyKeys() { register(this.settings); }

  // Re-register once Vim Motions has finished (re)loading its vimrc / init.lua — including
  // the automatic reload when you save one of them. Without Vim Motions this does nothing.
  patchReloads() {
    const vm = this.app.plugins && this.app.plugins.plugins && this.app.plugins.plugins["vim-motions"];
    if (!vm || vm.__latexObjects) return;
    vm.__latexObjects = true;
    for (const name of ["reloadAllConfigs", "softReloadVimrc", "softReloadLuaConfig"]) {
      const orig = vm[name];
      if (typeof orig !== "function") continue;
      const applyKeys = () => this.applyKeys();
      vm[name] = async function (...args) { try { return await orig.apply(this, args); } finally { applyKeys(); } };
      this.patched.push([vm, name, orig]);
    }
    this.patched.push([vm, "__latexObjects", undefined]);
  }

  find(editor, obj) {
    const lines = editor.getValue().split("\n"), pos = editor.getCursor();
    const s = pick(SPANS[obj](lines), at(pos.line, pos.ch), "cur");
    if (!s) new Notice(NONE[obj]);
    return s && { lines, s, pos };
  }

  edit(editor, obj, changesOf) {
    const f = this.find(editor, obj);
    if (!f) return;
    this.commit(editor, f.lines, changesOf(f.lines, f.s), f.pos);
  }

  commit(editor, lines, changes, pos) {
    const p = mapCursor(lines, changes, pos);
    editor.transaction({ changes });
    // normal mode: not past the last character
    editor.setCursor({ line: p.line, ch: Math.max(0, Math.min(p.ch, editor.getLine(p.line).length - 1)) });
  }

  // Blank the name in \begin{}, type the new one; leaving insert mode copies it to \end{}.
  renameEnv(editor) {
    const f = this.find(editor, "env");
    if (!f) return;
    // resolve Vim first: never blank the name unless the rest of the rename can run
    const cm = vimAdapter(editor), Vim = window.CodeMirrorAdapter && window.CodeMirrorAdapter.Vim;
    if (!cm || !Vim) return new Notice("Rename needs the Vim adapter — not found");
    const { s } = f, nameAt = at(s.a.line, s.a.ch + 7), file = this.app.workspace.getActiveFile();
    const before = editor.getValue(), nameFrom = editor.posToOffset(nameAt), nameTo = editor.posToOffset(at(s.ae.line, s.ae.ch - 1));
    editor.replaceRange("", nameAt, at(s.ae.line, s.ae.ch - 1));
    editor.setCursor(nameAt);
    const done = e => {
      if (e && e.mode === "insert") return;
      cm.off("vim-mode-change", done);
      // switched note while typing: positions no longer mean anything
      if (this.app.workspace.getActiveFile() !== file || (this.app.workspace.activeEditor || {}).editor !== editor) return;
      const lines = editor.getValue().split("\n"), line = lines[s.a.line] || "";
      if (!line.startsWith("\\begin{", s.a.ch)) return;
      const close = line.indexOf("}", nameAt.ch);
      if (close < 0) return;
      let name = line.slice(nameAt.ch, close);
      // One undo step: when the only edit since the rename started is the new name, rewind to before it
      // and apply the whole rename as a single change. (Anything else typed meanwhile → the
      // two-step path below, never losing text.)
      if (editor.getValue() === before.slice(0, nameFrom) + name + before.slice(nameTo) && this.rewind(editor, before)) {
        if (!name || name === s.name) return;
        const extras = renameExtras(before.split("\n"), s, name);
        editor.transaction({ changes: [{ from: s.bs, to: s.b, text: "\\end{" + name + "}" }, { from: nameAt, to: at(s.ae.line, s.ae.ch - 1), text: name }, ...extras] });
        editor.setCursor(at(nameAt.line, nameAt.ch + name.length - 1));
        return;
      }
      const changes = [];
      if (!name) { name = s.name; changes.push({ from: nameAt, to: at(s.a.line, close), text: name }); }
      // the old \end{…}: same place, shifted when it shares the \begin line
      const shift = s.bs.line === s.a.line ? close - (s.ae.ch - 1) : 0;
      const bs = at(s.bs.line, s.bs.ch + shift), b = at(s.b.line, s.b.ch + shift);
      if ((lines[bs.line] || "").slice(bs.ch, b.ch) === "\\end{" + s.name + "}") changes.push({ from: bs, to: b, text: "\\end{" + name + "}" });
      if (changes.length) editor.transaction({ changes });
    };
    cm.on("vim-mode-change", done);
    // from insert mode (a hotkey) "i" would be typed: already there, so just wait for <Esc>
    if (!(cm.state.vim && cm.state.vim.insertMode)) Vim.handleKey(cm, "i", "mapping");
  }

  // Undo until the note reads `text` again; if it can't get there, redo it all back.
  rewind(editor, text) {
    let k = 0;
    while (editor.getValue() !== text && k < 100) {
      const was = editor.getValue();
      editor.undo();
      k++;
      if (editor.getValue() === was) break;
    }
    if (editor.getValue() === text) return true;
    while (k-- > 0) editor.redo();
    return false;
  }
}

class LatexObjectsSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this, p = this.plugin, set = async (k, v) => { p.settings[k] = v; await p.saveSettings(); };
    containerEl.empty();
    if (!(window.CodeMirrorAdapter && window.CodeMirrorAdapter.Vim))
      containerEl.createEl("p", { text: "Vim mode is off: the text objects need Settings → Editor → Vim key bindings, or the Vim Motions plugin. The commands work without it.", cls: "mod-warning" });
    new Setting(containerEl).setName("Seek distance").setDesc("How many lines above or below the cursor an object or a command looks for the nearest maths, environment or bracket.")
      .addText(t => t.setPlaceholder("50").setValue(String(p.settings.seekLines)).onChange(v => { const n = parseInt(v, 10); if (Number.isFinite(n)) set("seekLines", n); }));
    new Setting(containerEl).setName("Jumps").setDesc("]m [m ]M [M ]e [e ]( [( ]{ [{ ]c [c ]a [a jump to the next or previous maths, display maths, environment, parenthesis, brace, command or argument; ]C [C to a command by name.")
      .addToggle(t => t.setValue(p.settings.jumps).onChange(v => { set("jumps", v); this.display(); }));
    if (p.settings.jumps) new Setting(containerEl).setName("Repeat jumps with ; and ,").setDesc("After a jump, ; repeats it and , goes the other way, until the next f F t T.")
      .addToggle(t => t.setValue(p.settings.repeatJumps).onChange(v => set("repeatJumps", v)));
    new Setting(containerEl).setName("Surround").setDesc("ds and cs on b B r ( ) { } [ ] seek the nearest bracket and know \\left \\right; dsc deletes the nearest command and keeps its argument, csc renames it. Needs the Vim Motions plugin.")
      .addToggle(t => t.setValue(p.settings.surround).onChange(v => set("surround", v)));
    new Setting(containerEl).setName("Match with %").setDesc("% on \\begin{…} \\end{…}, \\left \\right or $ / $$ goes to its partner. Anywhere else, or after a count, % stays Vim's.")
      .addToggle(t => t.setValue(p.settings.match).onChange(v => set("match", v)));
    new Setting(containerEl).setName("Highlight matching delimiter").setDesc("With the cursor on \\begin{…} \\end{…}, \\left \\right or $ / $$, mark it and its partner.")
      .addToggle(t => t.setValue(p.settings.highlight).onChange(v => set("highlight", v)));
    new Setting(containerEl).setName("Flash").setDesc("Highlight what y, >, gU … acted on for a moment.")
      .addToggle(t => t.setValue(p.settings.flash).onChange(v => { set("flash", v); this.display(); }));
    if (p.settings.flash) new Setting(containerEl).setName("Flash duration").setDesc("In milliseconds.")
      .addText(t => t.setPlaceholder("250").setValue(String(p.settings.flashMs)).onChange(v => { const n = parseInt(v, 10); if (Number.isFinite(n)) set("flashMs", n); }));
  }
}

module.exports = LatexObjects;
module.exports.core = { scriptSpans, tableSpans, rowSpans, cellSpans, moveChanges, swapAt, mathSpans, envSpans, bracketSpans, SPANS, surroundChanges, sizeChanges, sizable, pick, range, unwrapChanges, envUnwrapChanges, renameExtras, ampBeforeRelation, applyChanges, deleteChanges, toggleChanges, alignChanges, around, starChanges, mapCursor, KEYS, JUMPS, CONFIG, cleanSettings, visualEnd, jump, grow, countPick, shrink, commandSpans, argSpans, namedSpans, commandNames, icPick, spansFor, unslash, completions, commonPrefix, validName, promptName, delimAt, partner, matchTarget, mayBeDelim, keptArg, dscChanges, cscChanges, wrapChanges, wordAt, lastVisual };
