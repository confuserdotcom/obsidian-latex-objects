# LaTeX Objects

Vim text objects, jumps and editing commands for LaTeX in [Obsidian](https://obsidian.md): maths (`$…$`, `$$…$$`), environments (`\begin{…} … \end{…}`) and brackets (`( )`, `{ }`, `[ ]`, `\left( \right)`, `\{ \}`).

They work with every operator (`d c y > gU …`), in visual mode, with counts and with `.` repeat. Every object **seeks**: it takes the one around the cursor, or else the closest one above or below. So `dim` works even when the cursor is on the line before the maths.

Requires Vim mode: Obsidian's built-in **Settings → Editor → Vim key bindings**, or the [Vim Motions](https://github.com/saberzero1/obsidian-vim-motions) plugin. The commands work without Vim.

## Text objects

| Keys | Object |
| --- | --- |
| `im` `am` | maths: `$…$` or `$$…$$` |
| `iM` `aM` | display maths `$$…$$` only (skips the inline maths on the way) |
| `ie` `ae` | environment `\begin{…} … \end{…}`, matched by name |
| `ib` `ab` | parentheses `( )`, `\left( \right)` |
| `iB` `aB` | braces `{ }`, `\{ \}`, `\left\{ \right\}` |
| `ir` `ar` | square brackets `[ ]`, `\left[ \right]`, and `⟦a; b⟧` intervals |

`i` is the inside, `a` includes the delimiters. Put `n` or `l` in the middle for the **next** or **last** one: `dinm` deletes the inside of the next maths, `cilB` changes the inside of the previous braces.

- When the delimiters are on their own lines, the object is linewise, like Vim's `i{`: `dim` removes the lines, `cim` leaves one empty line to type on.
- In visual mode, repeating an object grows the selection to the enclosing one (`vie ie ie`). With a selection, `inB` / `ilB` step into the first / last block inside it.
- Counts: `3iB` is the 3rd enclosing braces; `3inB` / `3ilB` the 3rd next / previous at the same level (nested ones skipped). Too few → nothing happens, like Vim's `3i(`.
- `y`, `>`, `gU` … flash what they acted on for a moment, so you can see where a seek went.

## Jumps

| Keys | Jump to the next / previous |
| --- | --- |
| `]m` `[m` | maths |
| `]M` `[M` | display maths |
| `]e` `[e` | `\begin{…}` |
| `](` `[(` | `( )` |
| `]{` `[{` | `{ }` |

They are motions: counts, operators (`d]m`) and visual mode work. After a jump, `;` repeats it and `,` goes the other way, until the next `f F t T`.

## Bracket surround (with Vim Motions)

`ds` and `cs` on `b B r ( ) { } [ ]` seek the nearest bracket like `ib`, and know `\left \right`:

- `dsb` on `\left( x \right)` → `x`
- `csbB` on `\left( x \right)` → `\left\{ x \right\}`
- a `{ }` made inside maths is `\{ \}`, so it shows
- like vim-surround, an opening target (`ds(`) trims the spaces inside, and an opening replacement (`cs b (`) puts one space inside

Other surround keys (`ys`, `ds"` …) stay Vim Motions' own.

## Commands

| Command | What it does |
| --- | --- |
| Unwrap maths | delete the `$` / `$$`, keep the maths |
| Delete maths with its `$` / `$$` | delete the maths and its lines when it is alone on them |
| Toggle inline / display maths | `$x$` ⇄ `$$x$$`; display → inline joins the lines and unwraps an inner `align` |
| Turn the maths under the cursor into align | `$$ \begin{align} … \end{align} $$`, `&` before the first relation of each line, `\\` between lines |
| Unwrap environment | delete `\begin` / `\end`, keep the content; `align`-type environments also lose their `&` and `\\` |
| Toggle environment star | `align` ⇄ `align*` |
| Rename environment | type the new name in `\begin{}`; leaving insert mode copies it to `\end{}` (one undo step). `align` → `gather` drops the `&`, → `alignat` adds `{n}` |
| Toggle `\left \right` on the nearest bracket | `( )` ⇄ `\left( \right)`, also `[ ]` and `\{ \}` |

The cursor stays on the character it was on. Every command is one undo step.

### vimrc

Bind the commands to keys in Settings → Hotkeys, or from a vimrc. With [Vim Motions](https://github.com/saberzero1/obsidian-vim-motions):

```vim
let mapleader = " "
nnoremap <leader>lm :obcommand latex-objects:unwrap-math<CR>
nnoremap <leader>ld :obcommand latex-objects:delete-math<CR>
nnoremap <leader>lt :obcommand latex-objects:toggle-math<CR>
nnoremap <leader>la :obcommand latex-objects:align-math<CR>
nnoremap <leader>le :obcommand latex-objects:unwrap-env<CR>
nnoremap <leader>lr :obcommand latex-objects:rename-env<CR>
nnoremap <leader>ls :obcommand latex-objects:star-env<CR>
nnoremap <leader>lb :obcommand latex-objects:size-bracket<CR>
```

With [Vimrc Support](https://github.com/esm7/obsidian-vimrc-support), wrap each command in an `exmap` first:

```vim
exmap unwrapmath obcommand latex-objects:unwrap-math
nmap <Space>lm :unwrapmath<CR>
```

## Settings

- **Seek distance**: how many lines away the nearest object is looked for (default 50, like mini.ai's `n_lines`). The one around the cursor is always found.
- **Jumps** and **Repeat jumps with ; and ,**: turn `]m [m …` and the `; ,` repeat off if they clash with your own maps.
- **Bracket surround**: turn the `ds` / `cs` bracket handling off.
- **Flash** and **Flash duration**.

## What counts as maths

- `$$` pairs over the whole note; a `$$` that is not alone on its line only opens display maths if another `$$` closes it in the same paragraph.
- Inline `$…$` never spans lines.
- A backslash escapes the next character: `\$` is a dollar sign.
- `$` inside code fences and inline code is text.
- Blockquotes and callouts work: `> $$` is a delimiter on its own line.

## Install

Until it is in the community plugins list, either:

- use [BRAT](https://github.com/TfTHacker/obsidian42-brat): add `confuserdotcom/obsidian-latex-objects`, or
- download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/confuserdotcom/obsidian-latex-objects/releases/latest) into `<vault>/.obsidian/plugins/latex-objects/`, then enable **LaTeX Objects** in Settings → Community plugins.

## Development

No build step: `main.js` is the plugin.

```sh
npm test          # unit tests + property tests on 1000 random notes
node fuzz.js 5000 # more random notes (a failure prints its seed to replay it)
node e2e.mjs      # real key presses in a running Obsidian (see the header of e2e.mjs)
```

## License

[MIT](LICENSE)
