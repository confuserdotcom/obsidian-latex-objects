// Unit tests for the pure finders and edits:  node test.js
// (e2e.mjs checks the real keys inside Obsidian.)
const assert = require("assert");
const { mathSpans, envSpans, bracketSpans, SPANS, surroundChanges, sizeChanges, sizable, applyChanges, pick, range, unwrapChanges, envUnwrapChanges, renameExtras, ampBeforeRelation, deleteChanges, toggleChanges, alignChanges, starChanges, KEYS, mapCursor, countPick, shrink } = require("./main.js").core;

const at = (line, ch) => ({ line, ch });
const L = s => s.split("\n");
// text of a span or range in `lines`
const text = (lines, p, q) => (p.line === q.line ? lines[p.line].slice(p.ch, q.ch)
  : [lines[p.line].slice(p.ch), ...lines.slice(p.line + 1, q.line), lines[q.line].slice(0, q.ch)].join("\n"));
// apply EditorChange[] (positions in the original doc) → new text
function apply(lines, changes) {
  const doc = lines.join("\n"), off = p => lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.ch;
  const cs = changes.map(c => [off(c.from), off(c.to), c.text]).sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < cs.length; i++) assert(cs[i][0] >= cs[i - 1][1], "overlapping changes");
  return cs.reverse().reduce((d, [f, t, s]) => d.slice(0, f) + s + d.slice(t), doc);
}
const whole = (lines, s) => text(lines, s.a, s.b);
let n = 0, failed = 0;
const t = (name, fn) => {
  try { fn(); n++; } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${String(e.message).split("\n").join("\n      ")}`); }
};

// ─── math spans ───
t("inline and display, in order", () => {
  const l = L("Soit $f$ et $$g$$\n$$\na+b\n$$\nfin $z$");
  assert.deepStrictEqual(mathSpans(l).map(s => [s.kind, whole(l, s)]),
    [["inline", "$f$"], ["display", "$$g$$"], ["display", "$$\na+b\n$$"], ["inline", "$z$"]]);
});
t("escaped \\$ and \\\\ before $", () => {
  const l = L("prix 5\\$ et $x$ puis \\\\$$y$$");
  assert.deepStrictEqual(mathSpans(l).map(s => whole(l, s)), ["$x$", "$$y$$"]);
});
t("$ inside code fence and inline code is text", () => {
  const l = L("```bash\necho $$ $x\n```\n`a $b`  $c$");
  assert.deepStrictEqual(mathSpans(l).map(s => whole(l, s)), ["$c$"]);
});
t("$ inside a $$ block is not inline maths", () => {
  const l = L("$$\n\\text{$a$}\n$$");
  assert.deepStrictEqual(mathSpans(l).map(s => s.kind), ["display"]);
});
t("unclosed inline $ does not cross lines", () => {
  const l = L("coût $5\nvrai $x$");
  assert.deepStrictEqual(mathSpans(l).map(s => whole(l, s)), ["$x$"]);
});
t("user's Exercice line", () => {
  const l = L("L'implication $( \\exists x \\ | \\ \\forall y  )$  ");
  assert.strictEqual(whole(l, mathSpans(l)[0]), "$( \\exists x \\ | \\ \\forall y  )$");
});

// ─── pick: cur / next / last / seeking ───
const l1 = L("# Exercice\nfoo $a$ bar $b$\n$$\nc\n$$\nend");
const S1 = mathSpans(l1);
t("seek from a heading → next", () => assert.strictEqual(whole(l1, pick(S1, at(0, 2), "cur")), "$a$"));
t("inside wins", () => assert.strictEqual(whole(l1, pick(S1, at(1, 13), "cur")), "$b$"));
t("on the closing $ counts as inside", () => assert.strictEqual(whole(l1, pick(S1, at(1, 6), "cur")), "$a$"));
t("on a $$ line counts as inside", () => assert.strictEqual(pick(S1, at(4, 0), "cur").kind, "display"));
t("next skips the current one", () => assert.strictEqual(whole(l1, pick(S1, at(1, 5), "next")), "$b$"));
t("last", () => assert.strictEqual(whole(l1, pick(S1, at(5, 0), "last")), "$$\nc\n$$"));
t("after everything → falls back to last", () => assert.strictEqual(pick(S1, at(5, 1), "cur").kind, "display"));
t("nothing → null", () => assert.strictEqual(pick([], at(0, 0), "cur"), null));
t("next past the end → null", () => assert.strictEqual(pick(S1, at(5, 0), "next"), null));

// ─── pick "cur" = cover or NEAREST (lines first, then columns; tie → below) ───
const far = L("$a$\n\n\nici\n\n\n\n\n$b$");
t("nearest: the one above when it is closer", () => assert.strictEqual(whole(far, pick(mathSpans(far), at(3, 0), "cur")), "$a$"));
t("nearest: the one below when it is closer", () => assert.strictEqual(whole(far, pick(mathSpans(far), at(6, 0), "cur")), "$b$"));
const tie = L("$a$\n\n  ici\n\n  $b$"); // 2 lines and 0 columns each way
t("nearest: exact tie → the one below", () => assert.strictEqual(whole(tie, pick(mathSpans(tie), at(2, 2), "cur")), "$b$"));
const row = L("$a$ x       $b$");
t("nearest on the same line: columns decide", () => assert.strictEqual(whole(row, pick(mathSpans(row), at(0, 4), "cur")), "$a$"));
t("nearest: a multi-line block counts from its last line", () => {
  const l = L("$$\nx\ny\n$$\nici\n\n\n$b$");
  assert.strictEqual(pick(mathSpans(l), at(4, 0), "cur").kind, "display");
});
t("inside always wins over a nearer neighbour", () => {
  const l = L("$a$($long inner$)");
  assert.strictEqual(whole(l, pick(mathSpans(l), at(0, 14), "cur")), "$long inner$");
});
t("env: closest environment above when below is farther", () => {
  const l = L("\\begin{a}\nx\n\\end{a}\n\ntexte ici\n\n\n\n\\begin{b}\ny\n\\end{b}");
  assert.strictEqual(pick(envSpans(l), at(4, 3), "cur").name, "a");
});
t("bracket: closest pair on the line, either side", () => {
  const l = L("f(a) + g         (b)");
  assert.strictEqual(whole(l, pick(bracketSpans(l), at(0, 7), "cur")), "(a)");
});
t("next / last ignore distance (directional)", () => {
  assert.strictEqual(whole(far, pick(mathSpans(far), at(3, 0), "next")), "$b$");
  assert.strictEqual(whole(far, pick(mathSpans(far), at(6, 0), "last")), "$a$");
});

t("nearest: column matters between two on the line above", () => {
  const l = L("$a$ .............. $b$\nici");
  assert.strictEqual(whole(l, pick(mathSpans(l), at(1, 0), "cur")), "$a$");
});

// ─── seeking never reaches beyond 50 lines (mini.ai's n_lines): no off-screen edits ───
const gap = n => L("$a$" + "\n".repeat(n) + "ici");
t("seek finds maths 50 lines away", () => assert.strictEqual(whole(gap(50), pick(mathSpans(gap(50)), at(50, 0), "cur")), "$a$"));
t("seek ignores maths 51 lines away", () => assert.strictEqual(pick(mathSpans(gap(51)), at(51, 0), "cur"), null));
t("next / last obey the same limit", () => {
  const l = L("ici" + "\n".repeat(51) + "$b$");
  assert.strictEqual(pick(mathSpans(l), at(0, 0), "next"), null);
  assert.strictEqual(pick(mathSpans(gap(51)), at(51, 0), "last"), null);
});
t("around the cursor always wins, however long the block", () => {
  const l = L("$$\n" + "x\n".repeat(80) + "$$");
  assert.strictEqual(pick(mathSpans(l), at(40, 0), "cur").kind, "display");
});

// ─── range ───
t("inline inner / around", () => {
  const l = L("x $ab$ y"), s = mathSpans(l)[0];
  assert.strictEqual(text(l, ...Object.values(range(s, l, true)).slice(0, 2)), "ab");
  assert.strictEqual(text(l, ...Object.values(range(s, l, false)).slice(0, 2)), "$ab$");
});
t("$$ on own lines: inner is linewise content", () => {
  const l = L("t\n$$\na\nb\n$$\nu"), r = range(mathSpans(l)[0], l, true);
  assert.deepStrictEqual(r, { start: at(2, 0), end: at(3, 1), linewise: true });
});
t("$$ on own lines: around is linewise whole block", () => {
  const l = L("t\n$$\na\n$$\nu"), r = range(mathSpans(l)[0], l, false);
  assert.deepStrictEqual(r, { start: at(1, 0), end: at(3, 2), linewise: true });
});
t("empty $$\\n$$ → empty inner", () => {
  const l = L("$$\n$$"), r = range(mathSpans(l)[0], l, true);
  assert.strictEqual(r.linewise, undefined);
  assert.deepStrictEqual(r.start, r.end);
});
t("one-line $$x$$ is charwise", () => {
  const l = L("$$x$$"), r = range(mathSpans(l)[0], l, true);
  assert.deepStrictEqual(r, { start: at(0, 2), end: at(0, 3) });
});
t("empty brackets → zero-width inner (cib types inside)", () => {
  const l = L("f()"), r = range(bracketSpans(l)[0], l, true);
  assert.deepStrictEqual(r, { start: at(0, 2), end: at(0, 2) });
});

// ─── environments ───
t("nested envs: innermost around, outer from outside", () => {
  const l = L("\\begin{align*}\nx \\\\\n\\begin{cases}\na\n\\end{cases}\n\\end{align*}");
  const S = envSpans(l);
  assert.strictEqual(pick(S, at(3, 0), "cur").name, "cases");
  assert.strictEqual(pick(S, at(1, 0), "cur").name, "align*");
  assert.deepStrictEqual(range(pick(S, at(3, 0), "cur"), l, true), { start: at(3, 0), end: at(3, 1), linewise: true });
});
t("env seek from above", () => {
  const l = L("texte\n\\begin{pmatrix} 1 \\end{pmatrix}");
  assert.strictEqual(pick(envSpans(l), at(0, 0), "cur").name, "pmatrix");
});
t("\\end must match the \\begin name", () => {
  const l = L("\\begin{a}\\begin{b}x\\end{a}");
  assert.deepStrictEqual(envSpans(l).map(s => s.name), ["a"]);
});
t("stray \\end ignored", () => {
  const l = L("\\end{x}\n\\begin{y}z\\end{y}");
  assert.deepStrictEqual(envSpans(l).map(s => s.name), ["y"]);
});

// empty inline maths: Latex Suite's "$$" while typing, not a display opener
const kinds = src => mathSpans(L(src)).map(s => s.kind + " " + whole(L(src), s));
t("empty $$ in a sentence is an empty inline maths", () => {
  assert.deepStrictEqual(kinds("Soit $$ et $y$ ok"), ["inline $$", "inline $y$"]);
  assert.deepStrictEqual(kinds("Dans le cas $$\n\n## Q1"), ["inline $$"]);
});
t("…but $$ closing later in the paragraph is display", () => {
  assert.deepStrictEqual(kinds("Alors : $$ \\begin{a}\nx \\end{a} $$"), ["display $$ \\begin{a}\nx \\end{a} $$"]);
  assert.deepStrictEqual(kinds("vers : $$ f $$"), ["display $$ f $$"]);
  assert.deepStrictEqual(kinds("$$\n\nx\n$$").length, 1); // alone on its line: always an opener
});
t("an empty $$ no longer eats the maths after it", () => {
  const l = L("a $$ b\n\n$$\nx\n$$");
  assert.deepStrictEqual(mathSpans(l).map(s => s.kind), ["inline", "display"]);
});
t("cim on empty $$: zero-width inner between the two $", () => {
  const l = L("a $$ b"), r = range(pick(mathSpans(l), at(0, 0), "next"), l, true);
  assert.deepStrictEqual([r.start, r.end], [at(0, 3), at(0, 3)]);
});
t("next / last environment", () => {
  const l = L("\\begin{a}x\\end{a} ici \\begin{b}y\\end{b}"), S = envSpans(l);
  assert.strictEqual(pick(S, at(0, 19), "next").name, "b");
  assert.strictEqual(pick(S, at(0, 19), "last").name, "a");
});

t("iM skips the inline maths on the cursor's line (the student's note)", () => {
  const l = L("Alors le différentielle de $f$ notée $df$ est:\n$$\n\n$$");
  assert.strictEqual(whole(l, pick(mathSpans(l), at(0, 0), "cur")), "$f$");
  assert.strictEqual(whole(l, pick(SPANS.display(l), at(0, 0), "cur")), "$$\n\n$$");
});

// ─── brackets ───
t("mixed brackets, \\{ \\} is a brace, stray ) skipped", () => {
  const l = L("f(x) ) \\{ [a, {b}] \\}");
  assert.deepStrictEqual(bracketSpans(l).map(s => [whole(l, s), s.type]), [["(x)", "("], ["{b}", "{"], ["[a, {b}]", "["], ["\\{ [a, {b}] \\}", "{"]]);
});
t("\\{ closes only with \\}, { only with }, \\left\\{ only with \\right\\}", () => {
  for (const src of ["\\{ a }", "{ a \\}", "\\left\\{ a \\}", "\\{ a \\right\\}"]) assert.deepStrictEqual(bracketSpans(L(src)), [], src);
});
t("cases \\left\\{ … \\right. is no span", () =>
  assert.deepStrictEqual(bracketSpans(L("\\left\\{ \\begin{array}{l} 1 \\end{array} \\right.")).map(s => s.a.ch), [14, 21, 31]));  // only {array} {l} {array}
t("types: \\left( → (, interval → [, \\left\\{ → {", () => {
  const l = L("\\left( a \\right) \\left[\\!\\left[ 1; n \\right]\\!\\right] \\left\\{ x \\right\\}");
  assert.deepStrictEqual(bracketSpans(l).map(s => s.type), ["(", "[", "{"]);
});
t("ib (paren) skips a nearer { }: \\frac{a}{b} (x)", () => {
  const src = "\\frac{a}{b} (x)", l = L(src);
  assert.strictEqual(whole(l, pick(SPANS.paren(l), at(0, 6), "cur")), "(x)");
  assert.strictEqual(whole(l, pick(SPANS.brace(l), at(0, 6), "cur")), "{a}");
  assert.strictEqual(pick(SPANS.square(l), at(0, 6), "cur"), null);
});
t("a ] never closes a (", () => {
  const l = L("(a]");
  assert.deepStrictEqual(bracketSpans(l), []);
});
t("innermost bracket around cursor", () => {
  const l = L("f(g(x))");
  assert.strictEqual(whole(l, pick(bracketSpans(l), at(0, 4), "cur")), "(x)");
});
// \left( … \right) and the ⟦ ⟧ interval snippets (icc ico ioc ioo) are one bracket each
const inside = (lines, s) => text(lines, s.ae, s.bs);
const brAt = (src, needle) => { const l = L(src); const sp = pick(bracketSpans(l), at(0, src.indexOf(needle)), "cur"); return sp && [whole(l, sp), inside(l, sp)]; };
t("\\left( … \\right) is one bracket: ib leaves \\right alone", () =>
  assert.deepStrictEqual(brAt("f \\left( a+b \\right) g", "a+b"), ["\\left( a+b \\right)", " a+b "]));
t("interval ⟦a;b⟧ (icc) is one bracket", () =>
  assert.deepStrictEqual(brAt("A=\\left[\\!\\left[ 1; n \\right] \\!\\right]", "n "), ["\\left[\\!\\left[ 1; n \\right] \\!\\right]", " 1; n "]));
t("half-open intervals (ico ioc ioo) are brackets too", () => {
  assert.deepStrictEqual(brAt("\\left[\\!\\left[ 0; n \\right[ \\!\\right[", "n ")[1], " 0; n ");
  assert.deepStrictEqual(brAt("\\left]\\!\\left] 0; n \\right] \\!\\right]", "n ")[1], " 0; n ");
  assert.deepStrictEqual(brAt("\\left]\\!\\left] 0; n \\right[ \\!\\right[", "n ")[1], " 0; n ");
});
t("interval inside parentheses: innermost wins, then ab grows to the ( )", () => {
  const src = "( \\left]\\!\\left] 0; f(n) \\right[ \\!\\right[ )", l = L(src);
  assert.deepStrictEqual(brAt(src, "0;")[1], " 0; f(n) ");
  assert.deepStrictEqual(bracketSpans(l).map(sp => whole(l, sp)), ["(n)", "\\left]\\!\\left] 0; f(n) \\right[ \\!\\right[", src]);
});
t("\\left( only closes with \\right), ( only with )", () => {
  const l = L("\\left( a ) \\right) ( b \\right)");
  assert.deepStrictEqual(bracketSpans(l).map(sp => whole(l, sp)), ["\\left( a ) \\right)"]);
});
t("plain \\left[ … \\right] (not an interval) still pairs", () =>
  assert.deepStrictEqual(brAt("\\left[ x \\right]", "x")[1], " x "));

t("next / last bracket", () => {
  const l = L("(a) x (b)");
  const S = bracketSpans(l);
  assert.strictEqual(whole(l, pick(S, at(0, 4), "next")), "(b)");
  assert.strictEqual(whole(l, pick(S, at(0, 4), "last")), "(a)");
});

// ─── Space l edits ───
const one = (l, fn, spans = mathSpans(l)) => apply(l, fn(l, spans[0]));
t("unwrap inline", () => assert.strictEqual(one(L("a $x$ b"), unwrapChanges), "a x b"));
t("unwrap display on own lines drops the $$ lines", () => assert.strictEqual(one(L("t\n$$\nx\n$$\nu"), unwrapChanges), "t\nx\nu"));
t("unwrap one-line $$x$$", () => assert.strictEqual(one(L("$$x$$"), unwrapChanges), "x"));
t("unwrap empty env at end of note (adjacent lines)", () => {
  const l = L("t\n\\begin{a}\n\\end{a}");
  assert.strictEqual(apply(l, unwrapChanges(l, envSpans(l)[0])), "t");
});
t("unwrap empty env that is the whole note", () => {
  const l = L("\\begin{a}\n\\end{a}");
  assert.strictEqual(apply(l, unwrapChanges(l, envSpans(l)[0])), "");
});
t("unwrap empty $$ block at end of note", () => {
  const l = L("t\n$$\n$$");
  assert.strictEqual(apply(l, unwrapChanges(l, mathSpans(l)[0])), "t");
});
t("unwrap env", () => assert.strictEqual(one(L("\\begin{a}\nx\n\\end{a}"), unwrapChanges, envSpans(L("\\begin{a}\nx\n\\end{a}"))), "x"));
const envUn = src => { const l = L(src); return apply(l, envUnwrapChanges(l, envSpans(l).find(e => e.a.line === 0 || /align|split|eqnarray|gather/.test(e.name) && !e.a.ch))); };
t("Space l e on align drops the &", () => assert.strictEqual(envUn("\\begin{align*}\nf(x) &= a \\\\\n&= b\n\\end{align*}"), "f(x) = a\n= b"));
t("Space l e: spaced & and && collapse to one space", () => assert.strictEqual(envUn("\\begin{alignat*}{2}\na & = b && c & & d\n\\end{alignat*}"), "a = b c d"));
t("Space l e keeps \\& and the & of a nested matrix", () => assert.strictEqual(
  envUn("\\begin{aligned}\nA &= \\begin{pmatrix} 1 & 2 \\end{pmatrix} \\& x\n\\end{aligned}"), "A = \\begin{pmatrix} 1 & 2 \\end{pmatrix} \\& x"));
t("Space l e: \\\\& both go", () => assert.strictEqual(envUn("\\begin{align}a \\\\&= b\\end{align}"), "a = b"));
t("Space l e leaves & of other envs", () => assert.strictEqual(envUn("\\begin{cases}\na & b\n\\end{cases}"), "a & b"));
t("Space l e keeps the \\\\ of a nested matrix, drops a line left empty", () => assert.strictEqual(
  envUn("\\begin{align*}\nA &= \\begin{pmatrix} 1 \\\\ 2 \\end{pmatrix} \\\\\n\\\\\n&= B\n\\end{align*}"), "A = \\begin{pmatrix} 1 \\\\ 2 \\end{pmatrix}\n= B"));
t("Space l e: mid-line \\\\ becomes a space", () => assert.strictEqual(envUn("\\begin{align*}a \\\\ b\\end{align*}"), "a b"));
// Space l a: & before the first relation outside brackets
for (const [src, want] of [["a = b", "a &= b"], ["= b", "&= b"], ["\\sum_{k=0}^n u_k \\leq M", "\\sum_{k=0}^n u_k &\\leq M"],
  ["P(X = 1) = p", "P(X = 1) &= p"], ["f \\left( x \\right) \\implies y", "f \\left( x \\right) &\\implies y"], ["a &= b", "a &= b"],
  ["x \\in ]0, 1[ = I", "x \\in ]0, 1[ &= I"], ["u := v", "u &:= v"], ["no relation", "no relation"], ["\\{ x = 1 \\} = E", "\\{ x = 1 \\} &= E"]])
  t(`amp: ${src}`, () => assert.strictEqual(ampBeforeRelation(src), want));
t("Space l t: display with align → inline without & and \\\\", () => assert.strictEqual(
  one(L("$$\n\\begin{align*}\nf &= a \\\\\n&= b\n\\end{align*}\n$$"), toggleChanges), "$f = a = b$"));
// Space l r extras (doc before the rename)
const rx = (src, name) => { const l = L(src); return apply(l, renameExtras(l, envSpans(l)[0], name)); };
t("rename align → gather drops &, keeps \\\\", () => assert.strictEqual(rx("\\begin{align}\na &= b \\\\\n&= c\n\\end{align}", "gather"), "\\begin{align}\na = b \\\\\n= c\n\\end{align}"));
t("rename align → alignat adds {columns}", () => assert.strictEqual(rx("\\begin{align}\na &= b & c &= d\n\\end{align}", "alignat"), "\\begin{align}{2}\na &= b & c &= d\n\\end{align}"));
t("rename alignat → align drops {n}", () => assert.strictEqual(rx("\\begin{alignat}{2}\na &= b\n\\end{alignat}", "align"), "\\begin{alignat}\na &= b\n\\end{alignat}"));
t("rename align → aligned changes nothing else", () => assert.strictEqual(rx("\\begin{align}\na &= b\n\\end{align}", "aligned*"), "\\begin{align}\na &= b\n\\end{align}"));
t("delete inline, no double space", () => assert.strictEqual(one(L("a $x$ b"), deleteChanges), "a b"));
t("delete block, no blank gap", () => assert.strictEqual(one(L("t\n\n$$\nx\n$$\n\nu"), deleteChanges), "t\n\nu"));
t("delete last block in note", () => assert.strictEqual(one(L("t\n$$\nx\n$$"), deleteChanges), "t"));
t("toggle inline → display (alone on line)", () => assert.strictEqual(one(L("$x$"), toggleChanges), "$$\nx\n$$"));
t("toggle inline → display (in text)", () => assert.strictEqual(one(L("a $x$ b"), toggleChanges), "a $$x$$ b"));
t("toggle display → inline joins lines", () => assert.strictEqual(one(L("$$\na\n  b\n$$"), toggleChanges), "$a b$"));
t("align adds \\\\ except last line", () => assert.strictEqual(one(L("$$\na = b\nc = d\n$$"), alignChanges),
  "$$\n\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}\n$$"));
t("align: inline maths in text moves out to its own lines", () => assert.strictEqual(one(L("Soit $f(x) = x^2$ donc"), alignChanges),
  "Soit\n$$\n\\begin{align}\nf(x) &= x^2\n\\end{align}\n$$\ndonc"));
t("align: align* becomes align, rows kept", () => assert.strictEqual(one(L("$$\n\\begin{align*}\na &= b \\\\\n&= c\n\\end{align*}\n$$"), alignChanges),
  "$$\n\\begin{align}\na &= b \\\\\n&= c\n\\end{align}\n$$"));
t("align: equation becomes align with & before =", () => assert.strictEqual(one(L("$$\n\\begin{equation}\nk_i = k_{i+2} \\tag{1}\n\\end{equation}\n$$"), alignChanges),
  "$$\n\\begin{align}\nk_i &= k_{i+2} \\tag{1}\n\\end{align}\n$$"));
t("align: already align → null", () => { const l = L("$$\n\\begin{align}\na &= b\n\\end{align}\n$$"); assert.strictEqual(alignChanges(l, mathSpans(l)[0]), null); });
t("around: only the maths under the cursor, never a neighbour", () => {
  const { around } = require("./main.js").core, l = L("$$\na\n$$\ntexte $x$\n$$\nb\n$$");
  assert.strictEqual(around(mathSpans(l), at(3, 2)), null);
  assert.deepStrictEqual(around(mathSpans(l), at(3, 7)).a, at(3, 6));
  assert.deepStrictEqual(around(mathSpans(l), at(5, 0)).a, at(4, 0));
  assert.deepStrictEqual(around(mathSpans(l), at(2, 1)).a, at(0, 0));
});
t("star toggle both ways", () => {
  const l = L("\\begin{align}x\\end{align}");
  const once = apply(l, starChanges(envSpans(l)[0]));
  assert.strictEqual(once, "\\begin{align*}x\\end{align*}");
  assert.strictEqual(apply(L(once), starChanges(envSpans(L(once))[0])), l[0]);
});

// ─── visual end: inclusive, never inside a surrogate pair (😀, 𝔸 are 2 UTF-16 units) ───
const { visualEnd } = require("./main.js").core;
t("visual end steps back one character", () => assert.deepStrictEqual(visualEnd(L("(ab)"), at(0, 1), at(0, 3)), at(0, 2)));
// CodeMirror Vim itself can't end a visual selection on an astral character that follows
// others (its own vi( and v$ then delete the closing bracket — measured live), so the
// selection stops before it; alone, it is selected (that case works in CM Vim).
t("visual: a lone emoji is selected", () => assert.deepStrictEqual(visualEnd(L("(😀)"), at(0, 1), at(0, 3)), at(0, 1)));
t("visual: trailing 𝔸 after text is left out, never split", () => assert.deepStrictEqual(visualEnd(L("$x𝔸$"), at(0, 1), at(0, 4)), at(0, 1)));
t("visual: trailing emoji after text is left out", () => assert.deepStrictEqual(visualEnd(L("(ab😀)"), at(0, 1), at(0, 5)), at(0, 2)));
t("visual: two emoji → only the first", () => assert.deepStrictEqual(visualEnd(L("(😀😀)"), at(0, 1), at(0, 5)), at(0, 1)));
t("visual: text then two emoji → the text only", () => assert.deepStrictEqual(visualEnd(L("(a😀😀)"), at(0, 1), at(0, 6)), at(0, 1)));
t("visual: emoji in the middle is fine", () => assert.deepStrictEqual(visualEnd(L("(😀b)"), at(0, 1), at(0, 4)), at(0, 3)));
t("visual end at column 0 goes to the previous line end", () => assert.deepStrictEqual(visualEnd(L("(ab\n)"), at(0, 1), at(1, 0)), at(0, 3)));
t("visual end before start → null (empty)", () => assert.strictEqual(visualEnd(L("()"), at(0, 1), at(0, 1)), null));

// ─── callouts / blockquotes: the "> " prefix is kept on every line ───
const Q = L("> [!note]\n> $$\n> a = b\n> c = d\n> $$\n> fin");
const qs = mathSpans(Q)[0];
t("callout: align keeps > on every line", () => assert.strictEqual(apply(Q, alignChanges(Q, qs)),
  "> [!note]\n> $$\n> \\begin{align}\n> a &= b \\\\\n> c &= d\n> \\end{align}\n> $$\n> fin"));
t("callout: display → inline drops the > from the maths", () => assert.strictEqual(apply(Q, toggleChanges(Q, qs)), "> [!note]\n> $a = b c = d$\n> fin"));
t("callout: inline alone → display keeps >", () => {
  const l = L("> $x$");
  assert.strictEqual(apply(l, toggleChanges(l, mathSpans(l)[0])), "> $$\n> x\n> $$");
});
t("callout: unwrap drops the > $$ lines", () => assert.strictEqual(apply(Q, unwrapChanges(Q, qs)), "> [!note]\n> a = b\n> c = d\n> fin"));
t("callout: delete whole block drops its lines", () => assert.strictEqual(apply(Q, deleteChanges(Q, qs)), "> [!note]\n> fin"));
t("callout: dim is linewise on the content lines", () => assert.deepStrictEqual(range(qs, Q, true), { start: at(2, 0), end: at(3, 7), linewise: true }));
t("callout: dam is linewise on the whole block", () => assert.deepStrictEqual(range(qs, Q, false), { start: at(1, 0), end: at(4, 4), linewise: true }));
t("nested quote > > keeps its prefix", () => {
  const l = L("> > $$\n> > x\n> > $$");
  assert.strictEqual(apply(l, alignChanges(l, mathSpans(l)[0])), "> > $$\n> > \\begin{align}\n> > x\n> > \\end{align}\n> > $$");
});

// ─── ]m [m ]e [e jumps: to the start of the next / previous one, with a count ───
const { jump, grow, JUMPS } = require("./main.js").core;
const J = L("$a$ x $b$\n$c$"), JS = mathSpans(J);
const jat = (pos, fwd, count, spans = JS) => { const s = jump(spans, pos, fwd, count); return s && [s.a.line, s.a.ch]; };
t("]m goes to the next maths start", () => assert.deepStrictEqual(jat(at(0, 0), true, 1), [0, 6]));
t("2]m skips one", () => assert.deepStrictEqual(jat(at(0, 0), true, 2), [1, 0]));
t("9]m stops at the last one", () => assert.deepStrictEqual(jat(at(0, 0), true, 9), [1, 0]));
t("]m after the last one → null", () => assert.strictEqual(jat(at(1, 1), true, 1), null));
t("[m inside maths goes to its own start", () => assert.deepStrictEqual(jat(at(1, 1), false, 1), [1, 0]));
t("[m on a start goes to the previous one", () => assert.deepStrictEqual(jat(at(1, 0), false, 1), [0, 6]));
t("2[m", () => assert.deepStrictEqual(jat(at(1, 0), false, 2), [0, 0]));
t("[m before the first → null", () => assert.strictEqual(jat(at(0, 0), false, 1), null));
t("]m has no 50-line limit (it only moves)", () => {
  const l = L("x" + "\n".repeat(80) + "$a$");
  assert.deepStrictEqual(jat(at(0, 0), true, 1, mathSpans(l)), [80, 0]);
});
const EN = L("\\begin{a}\n\\begin{b}\nx\n\\end{b}\n\\end{a}");
t("]e enters a nested env", () => assert.deepStrictEqual(jat(at(0, 0), true, 1, envSpans(EN)), [1, 0]));
t("2[e from inside the inner env reaches the outer", () => assert.deepStrictEqual(jat(at(2, 0), false, 2, envSpans(EN)), [0, 0]));
t("jump keys", () => assert.deepStrictEqual(JUMPS.map(x => x[0]).sort(), ["[(", "[M", "[a", "[c", "[e", "[m", "[{", "](", "]M", "]a", "]c", "]e", "]m", "]{"]));

// ─── ds / cs on brackets, Space l b ───
// src, cursor ch, target, replacement (null = ds), in maths?  → result
const sur = (src, ch, target, repl, maths = false) => {
  const l = L(src), T = { b: "paren", "(": "paren", ")": "paren", B: "brace", "{": "brace", "}": "brace", r: "square", "[": "square", "]": "square" }[target];
  const sp = pick(SPANS[T](l), at(0, ch), "cur");
  return applyChanges(l, surroundChanges(l, sp, target, repl, maths)).join("\n");
};
t("ds: b / ) keep the spaces, ( trims them", () => {
  assert.strictEqual(sur("f( a )", 3, "b", null), "f a ");
  assert.strictEqual(sur("f( a )", 3, ")", null), "f a ");
  assert.strictEqual(sur("f( a )", 3, "(", null), "fa");
});
t("ds on \\left( \\right) removes the sizing and its spaces", () =>
  assert.strictEqual(sur("\\left( a+b \\right) c", 8, "b", null), "a+b c"));
t("dsB on \\{ \\}, dsr on an interval", () => {
  assert.strictEqual(sur("\\{x\\}", 2, "B", null), "x");
  assert.strictEqual(sur("\\left[\\!\\left[ 1; n \\right] \\!\\right]", 17, "r", null), "1; n");
});
t("ds seeks like ib: nearest ( ) even from inside { }", () =>
  assert.strictEqual(sur("\\frac{a}{b} (x)", 6, "b", null), "\\frac{a}{b} x"));
t("cs b B: plain { } outside maths, \\{ \\} in maths", () => {
  assert.strictEqual(sur("(x)", 1, "b", "B"), "{x}");
  assert.strictEqual(sur("(x)", 1, "b", "B", true), "\\{x\\}");
});
t("cs keeps \\left sizing", () => {
  assert.strictEqual(sur("\\left( a \\right)", 7, "b", "B", true), "\\left\\{ a \\right\\}");
  assert.strictEqual(sur("\\left\\{ a \\right\\}", 8, "B", "r"), "\\left[ a \\right]");
  assert.strictEqual(sur("\\left[\\!\\left[ 1; n \\right] \\!\\right]", 17, "r", "b"), "\\left( 1; n \\right)");
});
t("cs: opening replacement puts one space in, opening target trims", () => {
  assert.strictEqual(sur("(a)", 1, "b", "["), "[ a ]");
  assert.strictEqual(sur("(  a  )", 3, "b", "["), "[ a ]");
  assert.strictEqual(sur("( a )", 2, "(", "]"), "[a]");
  assert.strictEqual(sur("( a )", 2, "b", "]"), "[ a ]");
});
t("cs across lines", () =>
  assert.strictEqual(sur("(\na\n)", 0, "b", "r"), "[\na\n]"));
t("ds on empty ( )", () => assert.strictEqual(sur("f()", 1, "(", null), "f"));
const size = (src, ch) => { const l = L(src); const sp = pick(bracketSpans(l).filter(b => sizable(l, b)), at(0, ch), "cur"); return sp ? applyChanges(l, sizeChanges(l, sp)).join("\n") : null; };
t("Space l b: ( ) [ ] \\{ \\} ⇄ \\left \\right", () => {
  assert.strictEqual(size("(\\frac{a}{b})", 3), "\\left(\\frac{a}{b}\\right)");
  assert.strictEqual(size("\\left(\\frac{a}{b}\\right)", 8), "(\\frac{a}{b})");
  assert.strictEqual(size("\\left( a \\right)", 7), "( a )");
  assert.strictEqual(size("[x]", 1), "\\left[x\\right]");
  assert.strictEqual(size("\\{x\\}", 2), "\\left\\{x\\right\\}");
  assert.strictEqual(size("\\left\\{x\\right\\}", 7), "\\{x\\}");
});
t("Space l b skips { } grouping and intervals", () => {
  assert.strictEqual(size("\\frac{a}{b} (x)", 6), "\\frac{a}{b} \\left(x\\right)");
  assert.strictEqual(size("\\left[\\!\\left[ 1; n \\right] \\!\\right]", 17), null);
});

// ─── visual: repeating ie / ib / ae … grows to the enclosing one ───
const g = (lines, spans, sel, inner) => { const r = grow(spans, lines, sel, inner); return r && [r.start, r.end, !!r.linewise]; };
t("vie then ie: inner env lines → outer env lines", () => {
  // selection = what vie gave on \begin{b} (line 2, linewise)
  assert.deepStrictEqual(g(EN, envSpans(EN), { start: at(2, 0), last: at(2, 1) }, true), [at(1, 0), at(3, 7), true]);
});
t("vib then ib: (b) → a(b)c", () => {
  const l = L("(a(b)c)");
  assert.deepStrictEqual(g(l, bracketSpans(l), { start: at(0, 3), last: at(0, 3) }, true), [at(0, 1), at(0, 6), false]);
});
t("((b)): inner of the middle equals the selection → outer", () => {
  const l = L("((b))");
  assert.deepStrictEqual(g(l, bracketSpans(l), { start: at(0, 2), last: at(0, 2) }, true), [at(0, 1), at(0, 4), false]);
});
t("vab then ab grows to the outer brackets", () => {
  const l = L("(a(b)c)");
  assert.deepStrictEqual(g(l, bracketSpans(l), { start: at(0, 2), last: at(0, 4) }, false), [at(0, 0), at(0, 7), false]);
});
t("vib then ab: the same brackets, around", () => {
  const l = L("(a(b)c)");
  assert.deepStrictEqual(g(l, bracketSpans(l), { start: at(0, 3), last: at(0, 3) }, false), [at(0, 2), at(0, 5), false]);
});
t("nothing bigger → null", () => {
  const l = L("(a)");
  assert.strictEqual(g(l, bracketSpans(l), { start: at(0, 1), last: at(0, 1) }, true), null);
});
t("maths never nest: vim then im → null", () => {
  const l = L("x $ab$ y");
  assert.strictEqual(g(l, mathSpans(l), { start: at(0, 3), last: at(0, 4) }, true), null);
});
t("a selection outside every span → null", () => {
  const l = L("(a) xyz");
  assert.strictEqual(g(l, bracketSpans(l), { start: at(0, 4), last: at(0, 6) }, true), null);
});
t("grow compares what visual mode can show (trailing emoji left out)", () => {
  const l = L("((a😀))"); // vib on the inner pair shows "a"; the inner of the outer is "(a😀)"
  assert.deepStrictEqual(g(l, bracketSpans(l), { start: at(0, 2), last: at(0, 2) }, true), [at(0, 1), at(0, 6), false]);
});

// ─── counts: 2iB = 2nd enclosing, 2inB / 2ilB = 2nd next / previous at the same level ───
const cp = (text, pos, which, count, inner = true) => { const l = L(text), r = countPick(bracketSpans(l), l, pos, which, inner, count); return r && text_(l, r); };
const text_ = (l, r) => text(l, r.start, r.end);
t("count 1 = today's pick", () => assert.strictEqual(cp("x {a} {b}", at(0, 0), "next", 1), "a"));
t("2inB skips blocks nested in the one counted", () => assert.strictEqual(cp("x {a{b}} {c} {d}", at(0, 0), "next", 2), "c"));
t("3inB", () => assert.strictEqual(cp("x {a{b}} {c} {d}", at(0, 0), "next", 3), "d"));
t("2ilB skips nested blocks backwards", () => assert.strictEqual(cp("{a} {b{c}} x", at(0, 11), "last", 2), "a"));
t("count past the last one → null (no acting on another block)", () => assert.strictEqual(cp("x {a{b}} {c}", at(0, 0), "next", 3), null));
t("2iB = the 2nd enclosing", () => assert.strictEqual(cp("{a{b{c}}}", at(0, 5), "cur", 2), "b{c}"));
t("3aB = the 3rd enclosing, around", () => assert.strictEqual(cp("{a{b{c}}}", at(0, 5), "cur", 3, false), "{a{b{c}}}"));
t("cur count past the outermost → null", () => assert.strictEqual(cp("{a{b}}", at(0, 3), "cur", 3), null));
t("outside every block the nearest is the outer one: 2iB → null", () => assert.strictEqual(cp("{a{b}} x", at(0, 7), "cur", 2), null));
t("\\frac braces count as one level each: 2inB", () => assert.strictEqual(cp("x \\frac{a}{b} {c}", at(0, 0), "next", 3), "c"));

// ─── visual shrink: inB / ilB with a selection = the first / last block inside it ───
const sh = (text, sel, which, count, inner = true) => { const l = L(text), r = shrink(bracketSpans(l), l, sel, which, inner, count); return r && text_(l, r); };
t("viB then inB: first child", () => assert.strictEqual(sh("{a{b}{c}}", { start: at(0, 1), last: at(0, 7) }, "next", 1), "b"));
t("viB then ilB: last child", () => assert.strictEqual(sh("{a{b}{c}}", { start: at(0, 1), last: at(0, 7) }, "last", 1), "c"));
t("2inB inside skips grandchildren", () => assert.strictEqual(sh("{a{b{x}}{c}}", { start: at(0, 1), last: at(0, 10) }, "next", 2), "c"));
t("vaB then anB: the child around, not the selection itself", () => assert.strictEqual(sh("{a{b}}", { start: at(0, 0), last: at(0, 5) }, "next", 1, false), "{b}"));
t("no child inside → null (falls back to seek)", () => assert.strictEqual(sh("{ab} {c}", { start: at(0, 1), last: at(0, 2) }, "next", 1), null));

// ─── keys ───
t("all 66 keys, unique", () => {
  const k = KEYS.map(x => x[0]);
  assert.deepStrictEqual(k.sort(), ["a&", "aB", "aM", "aR", "a^", "a_", "ab", "ac", "ae", "al&", "alB", "alM", "alR", "al^", "al_", "alb", "alc", "ale", "alm", "alr", "am", "an&", "anB", "anM", "anR", "an^", "an_", "anb", "anc", "ane", "anm", "anr", "ar",
    "i&", "iB", "iM", "iR", "i^", "i_", "ib", "ic", "ie", "il&", "ilB", "ilM", "ilR", "il^", "il_", "ilb", "ilc", "ile", "ilm", "ilr", "im", "in&", "inB", "inM", "inR", "in^", "in_", "inb", "inc", "ine", "inm", "inr", "ir"]);
});
t("ic is an argument, ac a command", () => {
  const obj = key => KEYS.find(x => x[0] === key)[1].obj;
  assert.deepStrictEqual(["ic", "inc", "ac", "alc"].map(obj), ["arg", "arg", "command", "command"]);
});
t("i^ i_ i& iR are sup, sub, cell, row", () => {
  const obj = key => KEYS.find(x => x[0] === key)[1].obj;
  assert.deepStrictEqual(["i^", "a_", "in&", "alR"].map(obj), ["sup", "sub", "cell", "row"]);
});

// ─── cursor after a Space l edit: stays on the same character ───
const mc = (text, pos, changesOf) => { const l = L(text), sp = pick(mathSpans(l).concat(envSpans(l)), pos, "cur"); return mapCursor(l, changesOf(l, sp), pos); };
t("cursor: text before it removed on its line", () => assert.deepStrictEqual(mc("a $xy$ b", at(0, 4), unwrapChanges), at(0, 3)));
t("cursor: lines above removed", () => assert.deepStrictEqual(mc("\\begin{a}\nxyz\n\\end{a}", at(1, 2), unwrapChanges), at(0, 2)));
t("cursor: edit below doesn't move it", () => assert.deepStrictEqual(mapCursor(L("hi\n$x$"), [{ from: at(1, 0), to: at(1, 3), text: "" }], at(0, 1)), at(0, 1)));
t("cursor: inside deleted text → where it was deleted", () => assert.deepStrictEqual(mc("a $xy$ b", at(0, 4), deleteChanges), at(0, 1)));
t("cursor: toggle inline → display keeps it on its letter", () => assert.deepStrictEqual(mc("a $xy$ b", at(0, 4), toggleChanges), at(0, 5)));
t("cursor: toggle alone on its line → display keeps it on its letter", () => assert.deepStrictEqual(mc("$xy$", at(0, 2), toggleChanges), at(1, 1)));

// ─── settings ───
const { cleanSettings, CONFIG } = require("./main.js").core;
t("settings: nothing saved → defaults", () => assert.deepStrictEqual(cleanSettings(null), { seekLines: 50, jumps: true, repeatJumps: true, surround: true, match: true, highlight: true, flash: true, flashMs: 250 }));
t("settings: saved values kept, junk back to default", () => {
  const c = cleanSettings({ seekLines: 20, jumps: false, flash: "yes", flashMs: NaN, match: 0, other: 1 });
  assert.deepStrictEqual(c, { seekLines: 20, jumps: false, repeatJumps: true, surround: true, match: true, highlight: true, flash: true, flashMs: 250 });
});
t("settings: numbers clamped and rounded", () => {
  assert.strictEqual(cleanSettings({ seekLines: 0 }).seekLines, 1);
  assert.strictEqual(cleanSettings({ seekLines: 1e6 }).seekLines, 1000);
  assert.strictEqual(cleanSettings({ flashMs: 12.6 }).flashMs, 13);
});
t("seek distance setting limits how far the nearest one is looked for", () => {
  const lines = L("$a$" + "\n".repeat(10) + "x"), old = CONFIG.seekLines;
  try {
    CONFIG.seekLines = 5; assert.strictEqual(pick(mathSpans(lines), at(10, 0), "cur"), null);
    CONFIG.seekLines = 50; assert.ok(pick(mathSpans(lines), at(10, 0), "cur"));
  } finally { CONFIG.seekLines = old; }
});

// ─── 1.0.2 fixes ───
t("fence closes only with the same character, at least as long", () => {
  const l = L("```\n~~~\n$a$\n```\n````\n```\n$b$\n````\n$c$");
  assert.deepStrictEqual(mathSpans(l).map(s => whole(l, s)), ["$c$"]);
});
t("fence inside a callout, ended by the callout", () => {
  const l = L("> ```\n> $a$\n> ```\n> $b$\n> ```\n> $c$\n\n$d$");
  assert.deepStrictEqual(mathSpans(l).map(s => whole(l, s)), ["$b$", "$d$"]);
});
t("$a$$b$ is two inline maths", () => {
  const l = L("$a$$b$");
  assert.deepStrictEqual(mathSpans(l).map(s => whole(l, s)), ["$a$", "$b$"]);
});
t("\\big( \\big) is one bracket: ib keeps the sizes out", () => {
  const l = L("\\big( x \\Bigr) \\bigl[ y \\bigr] \\Big\\{ z \\Big\\}");
  assert.deepStrictEqual(bracketSpans(l).map(s => [s.type, text(l, s.ae, s.bs)]), [["(", " x "], ["[", " y "], ["{", " z "]]);
});
t("cs b B on \\big( keeps the size, size-bracket skips it", () => {
  const l = L("$\\big( x \\big)$"), s = bracketSpans(l)[0];
  assert.strictEqual(apply(l, surroundChanges(l, s, "b", "B", true)), "$\\big\\{ x \\big\\}$");
  assert.strictEqual(sizable(l, s), false);
});
t("im on an empty callout display keeps the > of its last line", () => {
  const l = L("> $$\n> $$"), r = range(mathSpans(l)[0], l, true);
  assert.deepStrictEqual([r.start, r.end], [at(1, 2), at(1, 2)]);
});
t("align in a list item indents under the item", () => {
  const l = L("1. $x = 1$");
  assert.strictEqual(apply(l, alignChanges(l, mathSpans(l)[0])), "1.\n   $$\n   \\begin{align}\n   x &= 1\n   \\end{align}\n   $$");
});

// ─── commands (1.1) ───
const { commandSpans, argSpans, namedSpans, commandNames } = require("./main.js").core;
const cmds = s => { const l = L(s); return commandSpans(l).map(c => [c.name, ...c.args.map(g => (g.opt ? "[" : "{") + text(l, g.ae, g.bs))]); };
t("commands: \\frac{a}{b} has two arguments", () => assert.deepStrictEqual(cmds("$\\frac{a}{b}$"), [["frac", "{a", "{b"]]));
t("commands: optional argument before a brace", () => assert.deepStrictEqual(cmds("$\\sqrt[n]{x}$"), [["sqrt", "[n", "{x"]]));
t("commands: [x] after the last brace is not an argument", () => assert.deepStrictEqual(cmds("$\\mathbb{R}[x]$"), [["mathbb", "{R"]]));
t("commands: no arguments", () => assert.deepStrictEqual(cmds("$\\alpha [0, 1]$"), [["alpha"]]));
t("commands: spaces and a newline between groups", () => assert.deepStrictEqual(cmds("$$\n\\frac {a}\n{b}\n$$"), [["frac", "{a", "{b"]]));
t("commands: groups on callout lines skip the > prefix", () => assert.deepStrictEqual(cmds("> $$\n> \\frac{a}\n> {b}\n> $$"), [["frac", "{a", "{b"]]));
t("commands: nested, in document order", () => assert.deepStrictEqual(cmds("$\\frac{\\sqrt{x}}{y}$"), [["frac", "{\\sqrt{x}", "{y"], ["sqrt", "{x"]]));
t("commands: \\{ \\} are not braces", () => assert.deepStrictEqual(cmds("$\\mathbf{\\{a\\}}$"), [["mathbf", "{\\{a\\}"]]));
t("commands: \\begin \\left \\big are not commands", () => assert.deepStrictEqual(cmds("$\\left( \\bigl[ x \\bigr] \\right)$\n$$\n\\begin{a}\n\\end{a}\n$$"), []));
t("commands: outside maths is text", () => assert.deepStrictEqual(cmds("\\textbf{a} $\\mathbf{b}$"), [["mathbf", "{b"]]));
t("commands: an unclosed group ends the arguments", () => assert.deepStrictEqual(cmds("$\\frac{a}{b$"), [["frac", "{a"]]));
t("commands: a [ group never takes the } of the enclosing one", () => assert.deepStrictEqual(cmds("$\\frac{\\sqrt[}]{x}$"), [["frac", "{\\sqrt["], ["sqrt"]]));
t("commands: \\ then a name is a line break, not a command", () => assert.deepStrictEqual(cmds("$a \\\\frac{b}$"), []));
t("commands: several optional arguments", () => assert.deepStrictEqual(cmds("$\\x[a][b]{c}$"), [["x", "[a", "[b", "{c"]]));
t("commands: an unclosed [ ends the arguments", () => assert.deepStrictEqual(cmds("$\\sqrt[a$"), [["sqrt"]]));
t("commands: an optional argument over two lines", () => assert.deepStrictEqual(cmds("$$\n\\sqrt[a\nb]{x}\n$$"), [["sqrt", "[a\nb", "{x"]]));
t("commands: an unclosed { ends its command's arguments, the ones inside still count", () => assert.deepStrictEqual(cmds("$\\a{\\b{x}\\c{y}$"), [["a"], ["b", "{x"], ["c", "{y"]]));
t("commands: a long unclosed run stays fast (one pass over the maths)", () => {
  const l = L("$$\n" + "\\a{".repeat(20000) + "\n$$"), t0 = Date.now();
  assert.strictEqual(commandSpans(l).length, 20000);
  assert.ok(Date.now() - t0 < 500, Date.now() - t0 + "ms");
});
t("]a [a: an empty group is landed on at its }", () => {
  const l = L("$a \\hat{} b \\c{x}$"), g = argSpans(l), j = (p, f) => jump(g, p, f, 1, x => x.ae).ae.ch;
  assert.strictEqual(j(at(0, 1), true), 8);
  assert.strictEqual(j(at(0, 8), true), 15);
  assert.strictEqual(j(at(0, 15), false), 8);
});
t("commands: args point back, b ends the last one, bs = b", () => {
  const l = L("$\\frac{a}{b} x$"), [c] = commandSpans(l);
  assert.ok(c.args.every(g => g.cmd === c));
  assert.strictEqual(text(l, c.a, c.b), "\\frac{a}{b}");
  assert.deepStrictEqual(c.bs, c.b);
});
t("argSpans: every argument of every command", () => {
  const l = L("$\\frac{a}{\\sqrt{b}}$");
  assert.deepStrictEqual(argSpans(l).map(g => text(l, g.a, g.b)), ["{a}", "{\\sqrt{b}}", "{b}"]);
});
t("SPANS.command skips commands without arguments", () => assert.deepStrictEqual(SPANS.command(L("$\\alpha \\hat{x}$")).map(c => c.name), ["hat"]));
t("namedSpans: by name, with or without arguments", () => assert.deepStrictEqual(namedSpans(L("$\\alpha \\frac{a}{b} \\alpha$"), "alpha").map(c => c.a.ch), [1, 20]));
t("commandNames: most frequent first, then alphabetical", () => assert.deepStrictEqual(commandNames(L("$\\frac{a}{b} \\beta \\frac{c}{d} \\alpha$")), ["frac", "alpha", "beta"]));

// ─── ic / ac ───
const { icPick } = require("./main.js").core;
const ic = (s, pos, which = "cur", count = 1) => { const l = L(s), r = icPick(l, pos, which, count); return r && text(l, r.start, r.end); };
const ac = (s, pos, count = 1) => { const l = L(s), r = countPick(SPANS.command(l), l, pos, "cur", false, count); return r && text(l, r.start, r.end); };
t("ic: inside the argument around the cursor", () => assert.strictEqual(ic("$\\frac{ab}{c}$", at(0, 8)), "ab"));
t("ic: on the name → the first argument", () => assert.strictEqual(ic("$\\frac{ab}{c}$", at(0, 3)), "ab"));
t("ic: on a nested command's name → its own first argument", () => assert.strictEqual(ic("$\\frac{\\sqrt{x}}{y}$", at(0, 9)), "x"));
t("2ic: the enclosing argument", () => assert.strictEqual(ic("$\\frac{\\sqrt{x}}{y}$", at(0, 13), "cur", 2), "\\sqrt{x}"));
t("inc: the next argument", () => assert.strictEqual(ic("$\\frac{a}{b}$", at(0, 7), "next"), "b"));
t("ic: seeks the nearest when not in one", () => assert.strictEqual(ic("$x \\hat{y}$", at(0, 1)), "y"));
t("ic: nothing → null", () => assert.strictEqual(ic("$x$", at(0, 1)), null));
t("ac: the whole command, optional argument included", () => assert.strictEqual(ac("$x + \\sqrt[n]{y}$", at(0, 12)), "\\sqrt[n]{y}"));
t("2ac: the enclosing command", () => assert.strictEqual(ac("$\\frac{\\sqrt{x}}{y}$", at(0, 13), 2), "\\frac{\\sqrt{x}}{y}"));

// ─── ]c ]a and jumps by name ───
const { spansFor } = require("./main.js").core;
t("]a lands inside the next argument, [a inside the previous one", () => {
  const l = L("$\\frac{a}{b}$"), g = argSpans(l), land = s => s.ae;
  assert.deepStrictEqual(land(jump(g, at(0, 0), true, 1, land)), at(0, 7));
  assert.deepStrictEqual(land(jump(g, at(0, 7), true, 1, land)), at(0, 10));
  assert.deepStrictEqual(land(jump(g, at(0, 10), false, 1, land)), at(0, 7));
  assert.strictEqual(jump(g, at(0, 10), true, 1, land), null);
});
t("]c counts commands with arguments only", () => assert.strictEqual(jump(spansFor("command", L("$\\alpha \\hat{x} \\bar{y}$")), at(0, 0), true, 2).name, "bar"));
t("spansFor named: every \\name", () => assert.deepStrictEqual(spansFor("named", L("$\\hat{x} \\frac{a}{b} \\frac{c}{d}$"), "frac").map(s => s.a.ch), [9, 21]));

// ─── name prompt helpers ───
const { completions, commonPrefix, validName, unslash } = require("./main.js").core;
t("prompt: completions ignore a leading backslash", () => assert.deepStrictEqual(completions("\\ma", ["frac", "mathbb", "mathcal"]), ["mathbb", "mathcal"]));
t("prompt: longest common prefix", () => {
  assert.strictEqual(commonPrefix(["mathbb", "mathcal"]), "math");
  assert.strictEqual(commonPrefix(["frac"]), "frac");
  assert.strictEqual(commonPrefix([]), "");
});
t("prompt: names are letters, a trailing * only when allowed", () => {
  assert.ok(validName("\\frac"));
  assert.ok(!validName("fr ac"));
  assert.ok(!validName("align*"));
  assert.ok(validName("align*", true));
  assert.ok(!validName(""));
  assert.strictEqual(unslash("\\frac"), "frac");
});

// ─── % ───
const { delimAt, partner, matchTarget } = require("./main.js").core;
t("%: \\begin ⇄ \\end, from any character of the token", () => {
  const l = L("\\begin{a}\nx\n\\end{a}");
  for (let ch = 0; ch < 9; ch++) assert.deepStrictEqual(partner(l, at(0, ch)), at(2, 0));
  for (let ch = 0; ch < 7; ch++) assert.deepStrictEqual(partner(l, at(2, ch)), at(0, 0));
  assert.strictEqual(partner(l, at(1, 0)), null);
});
t("%: \\left ⇄ \\right", () => {
  const l = L("$\\left( x \\right)$");
  assert.deepStrictEqual(partner(l, at(0, 3)), at(0, 10));
  assert.deepStrictEqual(partner(l, at(0, 15)), at(0, 1));
});
t("%: a plain ( and \\big( are not ours", () => {
  assert.strictEqual(partner(L("$(x)$"), at(0, 1)), null);
  assert.strictEqual(partner(L("$\\big( x \\big)$"), at(0, 2)), null);
});
t("%: $ and $$", () => {
  const l = L("a $x$ b\n$$\ny\n$$");
  assert.deepStrictEqual(partner(l, at(0, 2)), at(0, 4));
  assert.deepStrictEqual(partner(l, at(0, 4)), at(0, 2));
  assert.deepStrictEqual(partner(l, at(1, 1)), at(3, 0));
  assert.deepStrictEqual(partner(l, at(3, 1)), at(1, 0));
});
t("%: where it goes — normal, visual forward, operator", () => {
  const l = L("$x$"), fwd = delimAt(l, at(0, 0)), back = delimAt(l, at(0, 2));
  assert.deepStrictEqual(fwd, { here: [at(0, 0), at(0, 1)], there: [at(0, 2), at(0, 3)] });
  assert.deepStrictEqual(matchTarget(fwd, false, false), at(0, 2));
  assert.deepStrictEqual(matchTarget(back, false, false), at(0, 0));
  assert.deepStrictEqual(matchTarget(fwd, true, false), [at(0, 0), at(0, 3)]);
  assert.deepStrictEqual(matchTarget(back, true, false), [at(0, 0), at(0, 3)]);
  const env = delimAt(L("\\begin{a}x\\end{a}"), at(0, 0));
  assert.deepStrictEqual(matchTarget(env, false, true), at(0, 16));
});
t("%: backward from \\end — d% takes both, visual lands on \\begin", () => {
  const back = delimAt(L("\\begin{a}x\\end{a}"), at(0, 12));
  assert.deepStrictEqual(matchTarget(back, true, false), [at(0, 0), at(0, 17)]);
  assert.deepStrictEqual(matchTarget(back, false, true), at(0, 0));
});

// ─── match highlight ───
const { mayBeDelim } = require("./main.js").core;
t("highlight: cheap test before the full scan", () => {
  assert.ok(mayBeDelim("a $x$", 2));
  assert.ok(mayBeDelim("\\begin{a}", 3));
  assert.ok(!mayBeDelim("plain (text)", 6));
  const b = "xx \\begin{align} yy zzzz";
  assert.ok(!mayBeDelim(b, 0) && !mayBeDelim(b, 20) && !mayBeDelim(b, 2) && !mayBeDelim(b, 16)); // far from it
  for (const i of [3, 4, 7, 9, 10, 12, 14]) assert.ok(mayBeDelim(b, i), "begin at " + i); // \, b, n, {, name, }
  for (const [l, i] of [["\\end{x}", 0], ["\\end{x}", 5], ["a\\left(b", 1], ["a\\left(b", 6], ["\\right)", 6], ["\\left\\{", 6], ["\\left.", 5]]) assert.ok(mayBeDelim(l, i), l + i);
  assert.ok(!mayBeDelim("\\left(b", 7));
});
t("highlight: only the $ under the cursor counts", () => {
  assert.ok(mayBeDelim("a $x$ b", 4));
  assert.ok(!mayBeDelim("a $x$ b", 0) && !mayBeDelim("a $x$ b", 3));
});
t("highlight: \\left\\left( — the ( belongs to the second \\left", () => {
  const l = "$\\left\\left( x \\right) \\right.$";
  for (let i = 0; i < l.length; i++) if (delimAt([l], at(0, i))) assert.ok(mayBeDelim(l, i), "missed at " + i);
  assert.ok(mayBeDelim("$\\left\\{ a \\right\\}$", 7) && mayBeDelim("$\\left\\langle a$", 8));
});

// ─── dsc / csc / wrap ───
const { dscChanges, cscChanges, wrapChanges, keptArg, wordAt, lastVisual } = require("./main.js").core;
const cmdAt = (l, pos) => pick(SPANS.command(l), pos, "cur");
t("dsc keeps the argument under the cursor", () => {
  const l = L("$\\frac{a}{b}$"), p = at(0, 10), s = cmdAt(l, p);
  assert.strictEqual(apply(l, dscChanges(l, s, keptArg(s, p))), "$b$");
});
t("dsc on the name keeps the first argument and drops [opt]", () => {
  const l = L("$\\sqrt[n]{x}$"), p = at(0, 2), s = cmdAt(l, p);
  assert.strictEqual(apply(l, dscChanges(l, s, keptArg(s, p))), "$x$");
  assert.strictEqual(keptArg(s, at(0, 7)).opt, false); // in [n]: still the {x}
});
t("dsc on an argument's closing } keeps that argument", () => {
  const l = L("$\\frac{a}{b}$"), p = at(0, 11), s = cmdAt(l, p);
  assert.strictEqual(apply(l, dscChanges(l, s, keptArg(s, p))), "$b$");
});
t("csc renames and keeps the arguments", () => {
  const l = L("$\\mathbf{x}$"), s = cmdAt(l, at(0, 3));
  assert.strictEqual(apply(l, cscChanges(s, "mathcal")), "$\\mathcal{x}$");
});
t("wrap: \\name{…} around the range", () => {
  const l = L("$x + y$");
  assert.strictEqual(apply(l, wrapChanges(l, at(0, 1), at(0, 2), "mathbf")), "$\\mathbf{x} + y$");
});
t("wordAt: the word under the cursor, null on a space", () => {
  assert.deepStrictEqual(wordAt(L("$ab + c$"), at(0, 2)), [at(0, 1), at(0, 3)]);
  assert.strictEqual(wordAt(L("$ab + c$"), at(0, 3)), null);
});
t("wordAt: accented letters are part of the word", () => assert.deepStrictEqual(wordAt(L("$été + x$"), at(0, 2)), [at(0, 1), at(0, 4)]));
t("wordAt: a command name takes its \\ along (not after \\\\, not with digits)", () => {
  assert.deepStrictEqual(wordAt(L("$\\alpha$"), at(0, 3)), [at(0, 1), at(0, 7)]);
  assert.deepStrictEqual(wordAt(L("$ab$"), at(0, 1)), [at(0, 1), at(0, 3)]);
  assert.deepStrictEqual(wordAt(L("a\\\\b"), at(0, 3)), [at(0, 3), at(0, 4)]);
  assert.deepStrictEqual(wordAt(L("$\\x2$"), at(0, 2)), [at(0, 2), at(0, 4)]);
});
t("lastVisual: the charwise selection just left at the cursor, inclusive; else null", () => {
  const mk = (a, h, extra = {}) => ({ state: { vim: { lastSelection: { anchorMark: { find: () => a }, headMark: { find: () => h }, ...extra } } } });
  const l = L("$a+b$");
  assert.deepStrictEqual(lastVisual(mk(at(0, 1), at(0, 3)), at(0, 3), l), [at(0, 1), at(0, 4)]);
  assert.deepStrictEqual(lastVisual(mk(at(0, 3), at(0, 1)), at(0, 1), l), [at(0, 1), at(0, 4)]);
  assert.strictEqual(lastVisual(mk(at(0, 1), at(0, 3)), at(0, 0), l), null);
  assert.strictEqual(lastVisual(mk(at(0, 1), at(0, 3), { visualLine: true }), at(0, 3), l), null);
  assert.strictEqual(lastVisual(mk(undefined, at(0, 3)), at(0, 3), l), null);
  assert.strictEqual(lastVisual({ state: { vim: {} } }, at(0, 3), l), null);
  assert.strictEqual(lastVisual(null, at(0, 3), l), null);
});

// ─── the name prompt (a stand-in DOM) ───
const { promptName } = require("./main.js").core;
function fakeDom() {
  const on = new Map(), listen = t => (type, fn) => on.set(t + type, fn), unlisten = t => type => on.delete(t + type);
  const input = { value: "", css: {}, addEventListener: listen("input:"), remove() {}, focus() {}, setCssProps(p) { Object.assign(this.css, p); } };
  const win = { addEventListener: listen("win:"), removeEventListener: unlisten("win:"), setTimeout: (fn, ms) => setTimeout(fn, ms) };
  const doc = { defaultView: win, body: { createEl: (tag, o) => Object.assign(input, { tag, o }) } };
  const view = { dom: { ownerDocument: doc }, state: { selection: { main: { head: 0 } } }, coordsAtPos: () => null, focus() {} };
  const key = (where, k, extra = {}) => on.get(where + ":keydown")({ key: k, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, ...extra });
  return { view, input, key, held: () => on.has("win:keydown") };
}
const tests = [];
const ta = (name, fn) => tests.push([name, fn]);
ta("prompt: no view → null", async () => assert.strictEqual(await promptName(null, { placeholder: "", names: [] }), null));
ta("prompt: keys typed before it opens go into it", async () => {
  const d = fakeDom(), p = promptName(d.view, { placeholder: "", names: [] });
  for (const k of "matx") d.key("win", k);
  d.key("win", "Backspace");
  d.key("win", "Shift"); // not a character: left alone
  d.key("win", "h", { ctrlKey: true }); // a shortcut: left alone
  await new Promise(r => setTimeout(r, 5));
  assert.ok(!d.held(), "stops holding once open");
  assert.strictEqual(d.input.value, "mat");
  d.key("input", "Enter");
  assert.strictEqual(await p, "mat");
});
ta("prompt: an early Enter accepts, an early Escape cancels", async () => {
  const a = fakeDom(), pa = promptName(a.view, { placeholder: "", names: [] });
  for (const k of "hat") a.key("win", k);
  a.key("win", "Enter");
  assert.strictEqual(await pa, "hat");
  const b = fakeDom(), pb = promptName(b.view, { placeholder: "", names: [] });
  b.key("win", "x"); b.key("win", "Escape");
  assert.strictEqual(await pb, null);
});
ta("prompt: an input at the cursor, placed by CSS variables", async () => {
  const d = fakeDom(), p = promptName(d.view, { placeholder: "New name", names: [] });
  await new Promise(r => setTimeout(r, 5));
  assert.strictEqual(d.input.tag, "input");
  assert.deepStrictEqual(d.input.o, { cls: "latex-objects-prompt", attr: { placeholder: "New name" } });
  assert.deepStrictEqual(d.input.css, { "--latex-objects-left": "0px", "--latex-objects-top": "2px" });
  d.key("input", "Escape");
  assert.strictEqual(await p, null);
});
ta("prompt: Enter while an IME composes is not ours", async () => {
  const d = fakeDom(), p = promptName(d.view, { placeholder: "", names: [] });
  await new Promise(r => setTimeout(r, 5));
  d.input.value = "frac";
  d.key("input", "Enter", { isComposing: true });
  d.key("input", "Enter");
  assert.strictEqual(await p, "frac");
});

// ─── scripts, cells, rows, swap (1.2) ───
const { scriptSpans } = require("./main.js").core;
const scripts = s => { const l = L(s); return scriptSpans(l).map(x => [x.type, text(l, x.ae, x.bs), text(l, x.a, x.b)]); };
t("scripts: braced and one token", () => assert.deepStrictEqual(scripts("$x_{n+1}^2$"), [["_", "n+1", "_{n+1}"], ["^", "2", "^2"]]));
t("scripts: a \\name token, a space before the token", () => assert.deepStrictEqual(scripts("$y^\\alpha_ k$"), [["^", "\\alpha", "^\\alpha"], ["_", "k", "_ k"]]));
t("scripts: \\ and one character is one token", () => assert.deepStrictEqual(scripts("$x^\\{$"), [["^", "\\{", "^\\{"]]));
t("scripts: nested, outer first", () => assert.deepStrictEqual(scripts("$e^{x^2}$"), [["^", "x^2", "^{x^2}"], ["^", "2", "^2"]]));
t("scripts: \\_ and outside maths are not scripts", () => assert.deepStrictEqual(scripts("a_b [^1] $\\_x$"), []));
t("scripts: no token (maths end, }, unclosed {) is no script", () => assert.deepStrictEqual(scripts("$x^$ $\\a{y_}$ $z^{w$"), []));
t("scripts: a token over a surrogate pair", () => assert.deepStrictEqual(scripts("$x^𝔸$"), [["^", "𝔸", "^𝔸"]]));
t("scripts: over a line break in $$", () => assert.deepStrictEqual(scripts("$$\nx^\n2\n$$"), [["^", "2", "^\n2"]]));
t("scripts: \\^ is not a script, \\\\^2 is (a line break first)", () => {
  assert.deepStrictEqual(scripts("$a\\^2$"), []);
  assert.deepStrictEqual(scripts("$a\\\\^2$"), [["^", "2", "^2"]]);
});
t("scripts: a second mark right after has no script", () => {
  assert.deepStrictEqual(scripts("$x^^2$"), [["^", "2", "^2"]]);
  assert.deepStrictEqual(scripts("$x^&2$"), []);
});
t("scripts: a callout prefix before the token on the next line", () => assert.deepStrictEqual(scripts("> $$\n> x^\n> 2\n> $$"), [["^", "2", "^\n> 2"]]));
t("scripts: \\ and an astral character is one token", () => assert.deepStrictEqual(scripts("$x^\\😀$"), [["^", "\\😀", "^\\😀"]]));
t("scripts: a braced group over lines in $$", () => assert.deepStrictEqual(scripts("$$\nx^{a\nb}\n$$"), [["^", "a\nb", "^{a\nb}"]]));
t("SPANS.sup / SPANS.sub split by type", () => {
  assert.deepStrictEqual(SPANS.sup(L("$x_a^b$")).map(s => s.type), ["^"]);
  assert.deepStrictEqual(SPANS.sub(L("$x_a^b$")).map(s => s.type), ["_"]);
});
const { rowSpans, cellSpans } = require("./main.js").core;
const table = s => { const l = L(s); return rowSpans(l).map(r => [text(l, r.ae, r.bs), text(l, r.a, r.b), r.cells.map(c => [text(l, c.ae, c.bs), text(l, c.a, c.b)])]); };
t("rows / cells: one line", () => assert.deepStrictEqual(table("\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}"), [
  ["a & b", "a & b \\\\", [["a", "a & "], ["b", " & b"]]],
  ["c & d", " \\\\ c & d", [["c", "c & "], ["d", " & d"]]]]));
t("rows: own lines, a trailing \\\\ makes no empty row", () => assert.deepStrictEqual(table("$$\n\\begin{align}\nx &= 1 \\\\\ny &= 2 \\\\\n\\end{align}\n$$").map(r => r.slice(0, 2)),
  [["x &= 1", "x &= 1 \\\\"], ["y &= 2", "y &= 2 \\\\"]]));
t("rows: \\\\[2pt] is one separator", () => assert.deepStrictEqual(table("\\begin{align}a \\\\[2pt] b\\end{align}").map(r => r.slice(0, 2)), [["a", "a \\\\[2pt]"], ["b", " \\\\[2pt] b"]]));
t("cells: & in braces, in a nested env and \\& are not separators", () => {
  const rows = table("\\begin{pmatrix} {a & b} & \\begin{cases} x & y \\end{cases} & c \\& d \\end{pmatrix}");
  assert.deepStrictEqual(rows.find(r => r[0].startsWith("{a")).at(2).map(c => c[0]), ["{a & b}", "\\begin{cases} x & y \\end{cases}", "c \\& d"]);
  assert.deepStrictEqual(rows.find(r => r[0] === "x & y").at(2).map(c => c[0]), ["x", "y"]);
});
t("cells: an empty cell is empty at its place", () => {
  const l = L("\\begin{matrix}a & & b\\end{matrix}"), c = cellSpans(l)[1];
  assert.deepStrictEqual([c.ae, c.bs], [at(0, 17), at(0, 17)]);
});
t("cells: one-cell row: a& is just the cell", () => assert.deepStrictEqual(table("\\begin{align}a \\\\ b\\end{align}")[0][2], [["a", "a"]]));
t("cells: array's column spec is not a cell", () => assert.deepStrictEqual(table("\\begin{array}{cc} a & b \\end{array}")[0][2].map(c => c[0]), ["a", "b"]));
t("tables: an environment without & or \\\\ has no rows", () => assert.deepStrictEqual(table("\\begin{equation} x \\end{equation}"), []));
t("tables: callout prefixes are not cell text", () => assert.deepStrictEqual(table("> $$\n> \\begin{matrix}\n> a & b\n> \\end{matrix}\n> $$")[0][0], "a & b"));
t("cells: an optional [..] before the column spec is not a cell", () => {
  assert.deepStrictEqual(table("\\begin{array}[t]{cc} a & b \\end{array}")[0][2].map(c => c[0]), ["a", "b"]);
  assert.deepStrictEqual(table("\\begin{tabular}[t]{cc} a & b \\end{tabular}")[0][2].map(c => c[0]), ["a", "b"]);
});
t("rows: aR on the last row takes the previous row's end through its \\\\", () => {
  const l = L("\\begin{align} a \\\\ b \\end{align}"), r = rowSpans(l)[1];
  assert.deepStrictEqual(range(r, l, false), { start: at(0, 15), end: at(0, 20) });
});
t("cells: a multi-line cell", () => assert.deepStrictEqual(table("\\begin{matrix} a\nb & c \\end{matrix}")[0][2], [["a\nb", "a\nb & "], ["c", " & c"]]));
t("rows: a blank middle row", () => assert.deepStrictEqual(table("\\begin{align} a \\\\ \\\\ b \\end{align}").map(r => r.slice(0, 2)), [["a", "a \\\\"], ["", " \\\\"], ["b", " \\\\ b"]]));
t("cells: next / last pick the neighbouring cell", () => {
  const l = L("\\begin{matrix} a & b & c \\end{matrix}"), nx = countPick(SPANS.cell(l), l, at(0, 16), "next", true, 1), ls = countPick(SPANS.cell(l), l, at(0, 20), "last", true, 1);
  assert.strictEqual(text(l, nx.start, nx.end), "b");
  assert.strictEqual(text(l, ls.start, ls.end), "a");
});
t("cells: a count of 2 from a nested matrix reaches the outer cell", () => {
  const l = L("\\begin{matrix} a & \\begin{matrix} x & y \\end{matrix} \\end{matrix}"), r = countPick(SPANS.cell(l), l, at(0, l[0].indexOf(" x ") + 1), "cur", true, 2);
  assert.strictEqual(text(l, r.start, r.end), "\\begin{matrix} x & y \\end{matrix}");
});
t("range: aR on a row alone on its line is linewise", () => {
  const l = L("\\begin{align}\nx \\\\\ny\n\\end{align}"), [r0, r1] = rowSpans(l);
  assert.deepStrictEqual(range(r0, l, false), { start: at(1, 0), end: at(1, 4), linewise: true });
  assert.deepStrictEqual(range(r1, l, false), { start: at(1, 1), end: at(2, 1) });
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); n++; } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${String(e.message).split("\n").join("\n      ")}`); }
  }
  if (failed) { console.log(`${failed} failed, ${n} passed`); process.exit(1); }
  console.log(`ok — ${n} tests`);
})();
