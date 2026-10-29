// Live end-to-end check: real key presses in a running Obsidian.
//   1. start Obsidian with the debug port:   obsidian --remote-debugging-port=9222
//   2. node e2e.mjs   (in a test vault with Vim Motions and the leader maps of README.md § vimrc,
//      leader = Space: " lm" runs Unwrap maths, " le" Unwrap environment …, " lx" Delete command,
//      " lc" Rename command, " lw" Wrap in command (also mapped in visual: vnoremap <leader>lw))
//      Vim Motions with its defaults: clever-f (set flashcleverf) or a remapped D change what
//      the f / ; and ]eD cases type, and those cases then fail without any bug here.
// Uses a scratch note zz-latex-objects-e2e.md (deleted at the end). Prints PASS/FAIL per case.
// ONLY=text runs just the cases whose name contains it.
// Note: port 9222 lets any local process drive Obsidian; relaunch normally when done.

const list = await (await fetch("http://localhost:9222/json/list")).json();
const ws = new WebSocket(list.find(p => p.type === "page" && p.url.endsWith("/index.html")).webSocketDebuggerUrl);
await new Promise(r => (ws.onopen = r));
let id = 0;
const pend = {};
ws.onmessage = e => { const m = JSON.parse(e.data); pend[m.id]?.(m); };
const call = (method, params) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async expr => (await call("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function key(k) {
  const special = { "<Esc>": ["Escape", 27], "<Down>": ["ArrowDown", 40], "<CR>": ["Enter", 13], "<Tab>": ["Tab", 9] }[k];
  if (special) {
    for (const type of ["keyDown", "keyUp"]) await call("Input.dispatchKeyEvent", { type, key: special[0], code: special[0], windowsVirtualKeyCode: special[1] });
  } else {
    await call("Input.dispatchKeyEvent", { type: "keyDown", key: k, text: k, unmodifiedText: k });
    await call("Input.dispatchKeyEvent", { type: "keyUp", key: k });
  }
  await sleep(50);
}
const keys = s => s.match(/<Esc>|<Down>|<CR>|<Tab>|./gu);
const ed = "app.workspace.activeEditor.editor";

await ev(`(async()=>{const p='zz-latex-objects-e2e.md';const f=app.vault.getAbstractFileByPath(p)||await app.vault.create(p,'');
  await app.workspace.getLeaf(false).openFile(f);await new Promise(r=>setTimeout(r,500))})()`);

let fails = 0;
const cleanup = async () => {
  const left = await ev(`(async()=>{const p='zz-latex-objects-e2e.md';const f=app.vault.getAbstractFileByPath(p);if(f)await app.vault.delete(f);return !!app.vault.getAbstractFileByPath(p)})()`);
  if (left !== false) { fails++; console.log("FAIL  cleanup: zz-latex-objects-e2e.md was not deleted"); }
};
// text, cursor [line, ch], keys, expected doc text (or {sel} for visual selections)
// every edit goes through here: refuse to touch anything but the scratch note
const scratch = async () => {
  if ((await ev(`app.workspace.getActiveFile()?.path`)) !== "zz-latex-objects-e2e.md") throw new Error("the scratch note is not the active one, stopping");
};
async function t(name, text, [line, ch], ks, want) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return; // ONLY=";" node e2e.mjs
  await scratch();
  await ev(`(()=>{${ed}.setValue(${JSON.stringify(text)});${ed}.focus()})()`);
  await key("<Esc>");
  await ev(`${ed}.setCursor({line:${line},ch:${ch}})`);
  for (const k of keys(ks)) await key(k);
  await sleep(250);
  const got = await ev(`JSON.stringify({doc:${ed}.getValue(),sel:${ed}.getSelection(),cur:[${ed}.getCursor().line,${ed}.getCursor().ch]})`).then(JSON.parse);
  await key("<Esc>");
  await key("<Esc>");
  const ok = typeof want === "string" ? got.doc === want : "cur" in want ? got.doc === want.doc && got.cur.join() === want.cur.join() : got.sel === want.sel;
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      want ${JSON.stringify(want)}\n      got  ${JSON.stringify(typeof want === "string" ? got.doc : "cur" in want ? { doc: got.doc, cur: got.cur } : got.sel)}`}`);
}

try {
const EX = "# Exercice 1\n\n##### Énoncé\nL'implication $( \\exists x )$ ok\n\n$$\na+b\nc\n$$\nfin $z$ et $w$";

// maths — operators, seeking, next / last
await t("dim from heading seeks next", EX, [0, 2], "dim", EX.replace("$( \\exists x )$", () => "$$"));
await t("cam + type", "a $x$ b", [0, 3], "camY<Esc>", "a Y b");
await t("dinm", "$a$ et $b$", [0, 1], "dinm", "$a$ et $$");
await t("dalm", "$a$ et $b$", [0, 8], "dalm", " et $b$");
await t("yim then paste at end", "$ab$ ", [0, 4], "yim$p", "$ab$ ab");
await t("dim on $$ block → linewise", "t\n$$\na\nb\n$$\nu", [2, 0], "dim", "t\n$$\n$$\nu");
await t("cim on $$ block → one line to type", "t\n$$\na\nb\n$$\nu", [0, 0], "cimz<Esc>", "t\n$$\nz\n$$\nu");
await t("dam on $$ block removes its lines", "t\n$$\na\n$$\nu", [2, 0], "dam", "t\nu");
await t(". repeats with seeking", "$a$ $b$", [0, 0], "cimX<Esc>W.", "$X$ $X$");
await t("vim visual", "Soit $f(x)$ ok", [0, 0], "vim", { sel: "f(x)" });
await t("vinm visual", "$a$ $bc$", [0, 1], "vinm", { sel: "bc" });
await t("vam visual", "x $y$ z", [0, 3], "vam", { sel: "$y$" });

// empty inline maths ($$ left by Latex Suite while typing)
await t("cinm into an empty $$", "Soit $$ et $y$", [0, 0], "cinmx<Esc>", "Soit $x$ et $y$");
await t("cim on an empty $$ at line end", "Dans le cas $$\n\n## Q1", [0, 0], "cimf<Esc>", "Dans le cas $f$\n\n## Q1");
await t("vinm on an empty $$: cursor inside, i types", "a $$ b", [0, 0], "vinmiz<Esc>", "a $z$ b");
await t("dilm skips back over an empty $$", "$a$ $$ ici", [0, 8], "dilm", "$a$ $$ ici");
await t("dinm after an empty $$ still finds $y$", "$$ puis $y$", [0, 3], "dinm", "$$ puis $$");

// iM: display $$ only
const DF = "Alors le différentielle de $f$ notée $df$ est:\n$$\n\n$$";
await t("ciM from the text line goes into the $$ block", DF, [0, 0], "ciMx<Esc>", DF.replace("$$\n\n$$", () => "$$\nx\n$$"));
await t("cim from the same spot still takes $f$", DF, [0, 0], "cimx<Esc>", DF.replace("$f$", "$x$"));
await t("cinM", DF, [0, 0], "cinMx<Esc>", DF.replace("$$\n\n$$", () => "$$\nx\n$$"));
await t("dilM", "$$\na\n$$\nb $c$", [3, 3], "dilM", "$$\n$$\nb $c$");
await t("vaM", "t $x$\n$$\na\n$$", [0, 0], "vaMd", "t $x$");
await t("]M skips inline maths", "a $x$ b\n$$\ny\n$$", [0, 0], "]Mx", "a $x$ b\n$\ny\n$$");

// next / last environment
await t("cine", "\\begin{a}x\\end{a} ici \\begin{b}y\\end{b}", [0, 19], "cinez<Esc>", "\\begin{a}x\\end{a} ici \\begin{b}z\\end{b}");
await t("dile", "\\begin{a}x\\end{a} ici \\begin{b}y\\end{b}", [0, 19], "dile", "\\begin{a}\\end{a} ici \\begin{b}y\\end{b}");
await t("dane", "t \\begin{a}x\\end{a}", [0, 0], "dane", "t ");
await t("vale", "\\begin{p}1\\end{p} ici", [0, 17], "vale", { sel: "\\begin{p}1\\end{p}" });

// seeking: the CLOSEST one when the cursor is outside (either direction)
await t("dim picks closer maths above", "$a$\n\n\nici\n\n\n\n\n$b$", [3, 0], "dim", "$$\n\n\nici\n\n\n\n\n$b$");
await t("dim picks closer maths below", "$a$\n\n\n\n\nici\n$b$", [5, 0], "dim", "$a$\n\n\n\n\nici\n$$");
await t("same line: nearer column wins", "$a$ x         $b$", [0, 4], "dam", " x         $b$");
await t("vie from below picks the env above", "\\begin{a}\nx\n\\end{a}\n\ntexte\n\n\n\n\\begin{b}\ny\n\\end{b}", [4, 2], "vie", { sel: "x" });
await t("Space l e picks nearest env", "\\begin{a}\nx\n\\end{a}\nici\n\n\n\\begin{b}\ny\n\\end{b}", [3, 0], " le", "x\nici\n\n\n\\begin{b}\ny\n\\end{b}");
await t("dib picks nearest bracket", "f(a) + g         (b)", [0, 7], "dib", "f() + g         (b)");
await t("maths 60 lines away is out of reach (no off-screen edit)", "$a$" + "\n".repeat(60) + "ici", [60, 0], "dim", "$a$" + "\n".repeat(60) + "ici");
await t("Space l d out of reach does nothing", "$a$" + "\n".repeat(60) + "ici", [60, 0], " ld", "$a$" + "\n".repeat(60) + "ici");
await t("dinm still means NEXT", "$a$\nici\n\n\n$b$", [1, 0], "dinm", "$a$\nici\n\n\n$$");

// review fixes: surrogate pairs, callouts, visual kind
await t("vib d around an emoji keeps both brackets", "(😀)", [0, 1], "vibd", "()");
await t("dim with 𝔸 before the closing $ (operator: all of it)", "$x𝔸$", [0, 1], "dim", "$$");
// visual: CodeMirror Vim can't end a selection on 𝔸 after other text, so it stops before it
await t("vim d with 𝔸 last never splits it nor eats the $", "$x𝔸$", [0, 1], "vimd", "$𝔸$");
await t("vib d with text then emoji keeps both brackets", "(ab😀)", [0, 1], "vibd", "(😀)");
await t("cib with text then emoji (operator: all of it)", "(ab😀)", [0, 1], "cibz<Esc>", "(z)");
await t("V then im gives a charwise selection", "Soit $f(x)$ ok", [0, 0], "Vim", { sel: "f(x)" });
await t("callout: dim keeps both > $$ lines", "> [!note]\n> $$\n> a\n> b\n> $$\n> fin", [2, 2], "dim", "> [!note]\n> $$\n> $$\n> fin");
await t("callout: Space l a keeps > on every line", "> $$\n> a = b\n> c = d\n> $$", [1, 2], " la", "> $$\n> \\begin{align}\n> a &= b \\\\\n> c &= d\n> \\end{align}\n> $$");
await t("callout: Space l m drops the > $$ lines", "> [!tip]\n> $$\n> x\n> $$", [2, 2], " lm", "> [!tip]\n> x");

// environments
await t("die", "\\begin{align*}\nx\ny\n\\end{align*}", [1, 0], "die", "\\begin{align*}\n\\end{align*}");
await t("cie seeks from above", "texte\n\\begin{cases}\na\n\\end{cases}", [0, 0], "cieq<Esc>", "texte\n\\begin{cases}\nq\n\\end{cases}");
await t("vae", "\\begin{p} 1 \\end{p}", [0, 10], "vae", { sel: "\\begin{p} 1 \\end{p}" });

// brackets
await t("diB on {}", "f{a, b}", [0, 3], "diB", "f{}");
await t("cib on empty ()", "f()", [0, 0], "cibx<Esc>", "f(x)");
await t("dinb", "(a) (b)", [0, 1], "dinb", "(a) ()");
await t("dilb", "(a) (b)", [0, 5], "dilb", "() (b)");
await t("dab inside \\{ \\} takes the ( )", "\\{ (a) \\}", [0, 4], "dab", "\\{  \\}");
await t("ciB in a set \\{ \\}", "$\\{x \\in E\\}$", [0, 4], "ciBz<Esc>", "$\\{z\\}$");
await t("diB in \\left\\{ \\right\\}", "$\\left\\{ a \\right\\}$", [0, 9], "diB", "$\\left\\{\\right\\}$");
await t("dib skips the nearer { }", "$\\frac{a}{b} (x)$", [0, 7], "dib", "$\\frac{a}{b} ()$");
await t("diB skips the nearer ( )", "(a) {b}", [0, 1], "diB", "(a) {}");
await t("dir on [ ]", "f[a] (b)", [0, 6], "dir", "f[] (b)");
await t("dinB", "{a} {b}", [0, 1], "dinB", "{a} {}");
await t("dilr", "[a] [b]", [0, 5], "dilr", "[] [b]");
await t("vir ir grows", "[a[bc]d]", [0, 3], "virird", "[]");

// \left( … \right) and the interval snippets are one bracket each
await t("dir in an interval keeps the brackets", "$A=\\left[\\!\\left[ 1; n \\right] \\!\\right]$", [0, 20], "dir", "$A=\\left[\\!\\left[\\right] \\!\\right]$");
await t("dar deletes the whole interval", "$A=\\left]\\!\\left] 0; n \\right[ \\!\\right[ x$", [0, 20], "dar", "$A= x$");
await t("cib in \\left( \\right) keeps \\right", "$\\left( a+b \\right)$", [0, 9], "cibz<Esc>", "$\\left(z\\right)$");

// bracket surround (ds / cs on b B r ( ) { } [ ]) — seeks, knows \left \right; the rest stays Vim Motions'
await t("dsb", "f(a) x", [0, 5], "dsb", "fa x");
await t("ds( trims", "f( a )", [0, 0], "ds(", "fa");
await t("dsb on \\left( \\right)", "$\\left( a \\right)$", [0, 8], "dsb", "$a$");
await t("dsB on a set", "$\\{x\\}$", [0, 3], "dsB", "$x$");
await t("dsb skips the nearer { }", "$\\frac{a}{b} (x)$", [0, 7], "dsb", "$\\frac{a}{b} x$");
await t("csbB in maths gives \\{ \\}", "$(x)$", [0, 2], "csbB", "$\\{x\\}$");
await t("csbr keeps \\left", "$\\left( a \\right)$", [0, 8], "csbr", "$\\left[ a \\right]$");
await t("csr( spaced", "[a]", [0, 1], "csr(", "( a )");
await t("csb then . repeats the replacement", "(a)\n(b)", [0, 1], "csbrj.", "[a]\n[b]");
await t("csb then Esc changes nothing", "(a)", [0, 1], "csb<Esc>", "(a)");
await t("csb with a bad replacement changes nothing", "(a)", [0, 1], "csbz", "(a)");
await t("dsm still Vim Motions'", "a $x$ b", [0, 3], "dsm", "a x b");
await t("cs\"' still Vim Motions'", "a \"x\" b", [0, 3], "cs\"'", "a 'x' b");
await t("ysiw) still Vim Motions'", "foo bar", [0, 5], "ysiw)", "foo (bar)");
await t("ysb) still Vim Motions'", "foo bar", [0, 6], "ysb)", "foo (ba)r");

// ]( [( ]{ [{ jumps
await t("]( jumps to the next ( )", "a {b} (c)", [0, 0], "](x", "a {b} c)");
await t("[( jumps back", "(a) (b) x", [0, 8], "[(x", "(a) b) x");
await t("]{ jumps to the next { }", "(a) {b}", [0, 0], "]{x", "(a) b}");
await t("2]( counts", "(a) (b) (c)", [0, 0], "2](x", "(a) (b) c)");

// Space l b
await t("Space l b adds \\left \\right", "$(\\frac{a}{b})$", [0, 3], " lb", "$\\left(\\frac{a}{b}\\right)$");
await t("Space l b removes them", "$\\left\\{ x \\right\\}$", [0, 9], " lb", "$\\{ x \\}$");

// Space l commands (vimrc → :obcommand)
await t("Space l m from heading", "# H\na $x$ b", [0, 0], " lm", "# H\na x b");
await t("Space l d", "a $x$ b", [0, 3], " ld", "a b");
await t("Space l t", "a $x$ b", [0, 3], " lt", "a $$x$$ b");
await t("Space l a", "$$\na = b\nc = d\n$$", [1, 0], " la", "$$\n\\begin{align}\na &= b \\\\\nc &= d\n\\end{align}\n$$");
await t("Space l e", "\\begin{a}\nx\n\\end{a}", [1, 0], " le", "x");
await t("Space l e on align* drops the &", "$$\n\\begin{align*}\nf(x) &= a \\\\\n&= b\n\\end{align*}\n$$", [2, 0], " le", "$$\nf(x) = a\n= b\n$$");
await t("Space l t on align → inline", "$$\n\\begin{align*}\nf &= a \\\\\n&= b\n\\end{align*}\n$$", [2, 0], " lt", "$f = a = b$");
await t("Space l r align → gather drops &", "\\begin{align}\na &= b\n\\end{align}", [1, 0], " lrgather<Esc>", "\\begin{gather}\na = b\n\\end{gather}");
await t("Space l r align → alignat adds {n}", "\\begin{align}\na &= b\n\\end{align}", [1, 0], " lralignat<Esc><Esc>", "\\begin{alignat}{1}\na &= b\n\\end{alignat}");
await t("Space l s", "\\begin{align}x\\end{align}", [0, 0], " ls", "\\begin{align*}x\\end{align*}");
await t("Space l r", "\\begin{align}\nx\n\\end{align}", [1, 0], " lrgather<Esc>", "\\begin{gather}\nx\n\\end{gather}");
// (the second Esc closes the completion popup that "pmatrix" opens)
await t("Space l r, one line", "\\begin{p} 1 \\end{p}", [0, 10], " lrpmatrix<Esc><Esc>", "\\begin{pmatrix} 1 \\end{pmatrix}");
await t("Space l r, nothing typed keeps name", "\\begin{a}x\\end{a}", [0, 9], " lr<Esc>", "\\begin{a}x\\end{a}");

// the cursor stays on the same character (it used to keep its old line/column numbers)
await t("Space l e: cursor stays on its letter", "\\begin{a}\nxyz\n\\end{a}", [1, 2], " le", { doc: "xyz", cur: [0, 2] });
await t("Space l m: cursor stays on its letter", "a $xy$ b", [0, 4], " lm", { doc: "a xy b", cur: [0, 3] });
await t("Space l t: cursor stays on its letter", "a $xy$ b", [0, 4], " lt", { doc: "a $$xy$$ b", cur: [0, 5] });
await t("Space l s: cursor stays on its letter", "\\begin{align}xy\\end{align}", [0, 14], " ls", { doc: "\\begin{align*}xy\\end{align*}", cur: [0, 15] });
await t("Space l m from a heading: cursor stays on the heading", "# Hi\na $x$ b", [0, 3], " lm", { doc: "# Hi\na x b", cur: [0, 3] });
await t("Space l d from below: cursor stays there", "a $x$ b\nhello", [1, 3], " ld", { doc: "a b\nhello", cur: [1, 3] });
await t("Space l e with lines above removed: cursor follows", "\\begin{a}\n\\begin{b}\nq\n\\end{b}\nzz\n\\end{a}", [4, 1], " le", { doc: "\\begin{b}\nq\n\\end{b}\nzz", cur: [3, 1] });

// ]m [m ]e [e jumps (motions: counts and operators work)
await t("]m jumps to the next maths", "a $x$ b $y$", [0, 0], "]mx", "a x$ b $y$");
await t("2]m", "a $x$ b $y$", [0, 0], "2]mx", "a $x$ b y$");
await t("[m inside maths goes to its start", "a $x$ b $y$", [0, 10], "[mx", "a $x$ b y$");
await t("]e", "t\n\\begin{a}\nx\n\\end{a}", [0, 0], "]eD", "t\n\nx\n\\end{a}");
await t("[e", "\\begin{a}\nx\n\\end{a}", [1, 0], "[eD", "\nx\n\\end{a}");
await t("d]m", "abc $x$", [0, 0], "d]m", "$x$");
await t("]m with nothing ahead stays put", "$a$ b", [0, 4], "]mx", "$a$ ");
// a jump lands like zz: target line in the middle of the screen
for (const [k, mark] of [["]m", "$a$"], ["]e", "\\begin{a} x \\end{a}"], ["](", "(u)"]]) {
  await scratch();
  const lines = Array.from({ length: 200 }, (_, i) => i === 22 ? `ici ${mark} fin` : `ligne ${i}`);
  await ev(`(()=>{${ed}.setValue(${JSON.stringify(lines.join("\n"))});${ed}.focus()})()`);
  await key("<Esc>"); await ev(`${ed}.setCursor({line:0,ch:0})`); await sleep(200);
  for (const x of keys(k)) await key(x);
  await sleep(300);
  const c = await ev(`(()=>{const cm=app.workspace.activeLeaf.view.editor.cm,r=cm.scrollDOM.getBoundingClientRect(),y=cm.coordsAtPos(cm.state.selection.main.head);return {line:cm.state.doc.lineAt(cm.state.selection.main.head).number,off:Math.round((y.top+y.bottom)/2-(r.top+r.bottom)/2),lh:Math.round(cm.defaultLineHeight)}})()`);
  const ok = c.line === 23 && Math.abs(c.off) <= 2 * c.lh;
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${k} centres the target line (zz)${ok ? "" : "\n      " + JSON.stringify(c)}`);
}

// visual: repeating the object grows the selection
const NEST = "\\begin{a}\n\\begin{b}\nx\n\\end{b}\n\\end{a}";
await t("vie ie grows to the outer env", NEST, [2, 0], "vieied", "\\begin{a}\n\\end{a}");
await t("vib ib grows", "(a(bc)d)", [0, 3], "vibibd", "()");
await t("vib ab: same brackets, around", "(a(bc)d)", [0, 3], "vibab", { sel: "(bc)" });
await t("vab ab grows", "(a(b)c)", [0, 3], "vababd", "");
await t("vim im stays (maths never nest)", "x $ab$ y", [0, 3], "vimim", { sel: "ab" });
await t("vie on the outer env stays", NEST, [2, 0], "vieieied", "\\begin{a}\n\\end{a}");

// counts: 2iB = 2nd enclosing, 2inB / 3ilB = same level, . replays the count
await t("d2iB", "{a{b{c}}}", [0, 5], "d2iB", "{a{}}");
await t("v2iB", "{a{b{c}}}", [0, 5], "v2iB", { sel: "b{c}" });
await t("v3ilB", "{a} {b{x}} {c} y", [0, 15], "v3ilB", { sel: "a" });
await t("d2inB then . (count replayed)", "x {a{b}} {c} {d} {e}", [0, 0], "d2inB.", "x {a{b}} {} {d} {}");
await t("2dinB (count before the operator)", "x {a{b}} {c}", [0, 0], "2dinB", "x {a{b}} {}");
await t("d3inB with only 2 → nothing", "x {a} {b}", [0, 0], "d3inB", "x {a} {b}");
// visual: inB / ilB step into the selection
await t("viB inB: first child", "{a{b}{c}}", [0, 1], "viBinB", { sel: "b" });
await t("viB ilB: last child", "{a{b}{c}}", [0, 1], "viBilB", { sel: "c" });
await t("viB inB inB: then the next sibling", "{a{b}{c}}", [0, 1], "viBinBinB", { sel: "c" });
await t("viB inB iB: back out", "{a{b}{c}}", [0, 1], "viBinBiB", { sel: "a{b}{c}" });
await t("vib ib grows out of a one-character (b)", "(a(b)c)", [0, 3], "vibibd", "()");
await t("vib, Esc, v ib: seeks again (not a stale grow)", "(a(b)c)", [0, 3], "vib<Esc>vibd", "(a()c)");
// ; , repeat the last ]x / [x jump
await t("]{ ; ;", "{a} {b} {c} {d}", [0, 0], "]{;;x", "{a} {b} {c} d}");
await t("]{ ; ,", "{a} {b} {c} {d}", [0, 0], "]{;,x", "{a} b} {c} {d}");
await t("d; after ]{", "{a} {b} {c}", [0, 0], "]{d;", "{a} {c}");
await t("f after a jump gives ; back to f", "(a) x (b) x (c)", [0, 0], "](fx;D", "(a) x (b) ");
await t("f typed in insert mode keeps the jump", "{a} {b} {c}", [0, 0], "]{af<Esc>;x", "{a} {fb} c}");
await t("fx ; without a jump", "axbxc", [0, 0], "fx;D", "axb");

// flash after y (checked while it is on screen)
{
  await scratch();
  await ev(`(()=>{${ed}.setValue("a $xy$ b\\nsuite");${ed}.focus();${ed}.setCursor({line:1,ch:0})})()`);
  await key("<Esc>");
  for (const k of "yim") await key(k);
  const lit = await ev(`[...document.querySelectorAll(".workspace-leaf.mod-active .latex-objects-flash-line")].map(e=>e.textContent).join("|")`);
  await sleep(400);
  const gone = await ev(`document.querySelectorAll(".latex-objects-flash, .latex-objects-flash-line").length`);
  const ok = lit !== "" && !lit.includes("suite") && gone === 0;
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  yim flashes the maths, then clears${ok ? "" : ` (lit ${JSON.stringify(lit)}, left ${gone})`}`);
}
await t("dim does not leave a flash behind", "a $x$", [0, 0], "dim", "a $$");

// Space l r is one undo step, and never loses other typing
await t("Space l r then u restores in one step", "\\begin{align}\nx\n\\end{align}", [1, 0], " lrgather<Esc>u", "\\begin{align}\nx\n\\end{align}");
await t("Space l r: u stops right before the rename", "kk\n\\begin{a}x\\end{a}", [0, 0], "x lrb<Esc>u", "k\n\\begin{a}x\\end{a}");
await t("Space l r with other typing keeps it", "\\begin{a}\nx\n\\end{a}", [1, 0], " lrb<Down>z<Esc>", "\\begin{b}\nxz\n\\end{b}");

// commands (1.1): ic ac, ]c ]a ]C, %, the highlight, dsc csc, Space l x / c / w
await t("cic in the numerator", "$\\frac{a}{b}$", [0, 7], "cicX<Esc>", "$\\frac{X}{b}$");
await t("cic on the name takes the first argument", "$\\frac{a}{b}$", [0, 2], "cicX<Esc>", "$\\frac{X}{b}$");
await t("dac", "$x + \\sqrt[n]{y}$", [0, 11], "dac", "$x + $");
await t("vic ic grows to the enclosing argument", "$\\frac{\\sqrt{x}}{y}$", [0, 13], "vicic", { sel: "\\sqrt{x}" });
await t("]a ]a lands in the denominator", "$\\frac{a}{b}$", [0, 0], "]a]ax", "$\\frac{a}{}$");
await t("3]c skips commands without arguments", "$\\alpha \\sqrt{a} \\sqrt{b} \\sqrt{c}$", [0, 0], "3]cx", "$\\alpha \\sqrt{a} \\sqrt{b} sqrt{c}$");
await t("]C frac Enter", "$a \\sqrt{x} \\frac{1}{2}$", [0, 0], "]Cfrac<CR>x", "$a \\sqrt{x} frac{1}{2}$");
await t("]C then ; and ,", "$\\frac{a}{b} \\frac{c}{d}$", [0, 0], "]Cfrac<CR>;,x", "$frac{a}{b} \\frac{c}{d}$");
await t("]C then ;", "$\\frac{a}{b} \\frac{c}{d}$", [0, 0], "]Cfrac<CR>;x", "$\\frac{a}{b} frac{c}{d}$");
await t("]C Tab completes from the note", "$\\mathbb{R} \\mathcal{C}$", [0, 0], "]Cmathc<Tab><CR>x", "$\\mathbb{R} mathcal{C}$");
await t("]C Esc cancels", "$\\frac{a}{b}$", [0, 0], "]Cfrac<Esc>x", "\\frac{a}{b}$");
await t("% \\begin → \\end", "\\begin{a}\nx\n\\end{a}", [0, 3], "%x", "\\begin{a}\nx\nend{a}");
await t("% \\end → \\begin", "\\begin{a}\nx\n\\end{a}", [2, 2], "%x", "begin{a}\nx\n\\end{a}");
await t("% on $$", "$$\nx\n$$", [0, 0], "%x", "$$\nx\n$");
await t("d% on \\left", "$\\left( x \\right) y$", [0, 2], "d%", "$ y$");
await t("% on a plain ( stays Vim's", "f(x) y", [0, 1], "%x", "f(x y");
await t("dsc", "$\\mathbf{x}$", [0, 9], "dsc", "$x$");
await t("dsc keeps the argument under the cursor", "$\\frac{a}{b}$", [0, 10], "dsc", "$b$");
await t("csc then .", "$\\mathbf{x} \\mathbf{y}$", [0, 2], "cscmathcal<CR>W.", "$\\mathcal{x} \\mathcal{y}$");
await t("Space l x deletes the command", "$\\mathbf{x}$", [0, 3], " lx", "$x$");
await t("Space l c renames the command", "$\\mathbf{x}$", [0, 3], " lcmathcal<CR>", "$\\mathcal{x}$");
await t("Space l w wraps the word", "$x + y$", [0, 1], " lwmathbf<CR>", "$\\mathbf{x} + y$");
await t("Space l w wraps a visual selection", "$a+b$", [0, 1], "vll lwhat<CR>", "$\\hat{a+b}$");
{
  await scratch();
  await ev(`(()=>{${ed}.setValue(${JSON.stringify("\\begin{a}\nx\n\\end{a}")});${ed}.focus();${ed}.setCursor({line:0,ch:2})})()`);
  await sleep(200);
  const lit = await ev(`[...document.querySelectorAll(".workspace-leaf.mod-active .latex-objects-match")].map(e=>e.textContent).join("")`);
  await ev(`${ed}.setCursor({line:1,ch:0})`);
  await sleep(200);
  const gone = await ev(`document.querySelectorAll(".workspace-leaf.mod-active .latex-objects-match").length`);
  const ok = lit === "\\begin{a}\\end{a}" && gone === 0;
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  highlight marks \\begin and \\end, then clears${ok ? "" : ` (lit ${JSON.stringify(lit)}, left ${gone})`}`);
}

// regressions: built-ins untouched
await t("dd", "a\nb\nc", [1, 0], "dd", "a\nc");
await t("diw", "foo bar", [0, 0], "diw", " bar");
await t("ci(", "f(x)", [0, 2], "ci(y<Esc>", "f(y)");
await t("i then m types m", "ab", [0, 1], "im<Esc>", "amb");

// survives Vim Motions reloads
await ev(`(async()=>{app.commands.executeCommandById("vim-motions:reload-configuration");await new Promise(r=>setTimeout(r,2000))})()`);
await t("dim after Reload configuration", "a $x$", [0, 0], "dim", "a $$");
await ev(`(async()=>{const f=app.vault.getAbstractFileByPath('.obsidian.init.lua');const p=app.plugins.plugins['vim-motions'];
  if(p.softReloadLuaConfig) await p.softReloadLuaConfig.call(p);await new Promise(r=>setTimeout(r,500))})()`);
await t("dim after init.lua soft reload", "a $x$", [0, 0], "dim", "a $$");
await ev(`(async()=>{await app.plugins.disablePlugin("vim-motions");await app.plugins.enablePlugin("vim-motions");await new Promise(r=>setTimeout(r,1500))})()`);
await t("dim after Vim Motions is turned off and on", "a $x$", [0, 0], "dim", "a $$");
await t("]m after Vim Motions is turned off and on", "a $x$ $y$", [0, 0], "]mx", "a x$ $y$");
await t("]{ ; after Vim Motions is turned off and on", "{a} {b} {c}", [0, 0], "]{;x", "{a} {b} c}");
// our own reload (and every note switch) must not stack ; wrappers or leave an old one behind
await ev(`(async()=>{await app.plugins.disablePlugin("latex-objects");await app.plugins.enablePlugin("latex-objects");await new Promise(r=>setTimeout(r,500))})()`);
// (no f here: after any plugin toggle, f stops taking CDP keys — any plugin, not ours)
await t("; after the toggle doesn't replay the old copy's ]{", "x {a} {b}", [0, 0], ";D", "");
await t("]{ ; after latex-objects is turned off and on", "{a} {b} {c}", [0, 0], "]{;x", "{a} {b} c}");

} catch (e) {
  fails++;
  console.log("CRASH ", e.message);
} finally {
  await cleanup();
}
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
ws.close();
process.exit(fails ? 1 : 0);
