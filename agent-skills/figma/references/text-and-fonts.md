# Text and fonts

Source: `packages/core/src/text.ts`, `fonts.ts`, `google-fonts.ts`, `resolve-fonts.ts`, `accessibility.ts`, `packages/cli/src/run.ts`, and `apps/web/src/FontsPanel.tsx` on `main`. See also `docs/accessibility.md`.

## How it works

- `<text>`/`<tspan>` are laid out with the real font (fontkit: kerning, ligatures, CSS weight and style matching) and emitted as static glyph outlines. The Lottie needs no fonts at runtime. **There is no raster fallback and no faux bold.**
- Font sources:
  - **CLI:** `--fonts <dir>` (repeatable). Accepts TTF, OTF, WOFF, WOFF2 and TTC.
  - **Web UI:** the **Fonts** panel. Use **Upload fonts** or drop font files anywhere on the page.
  - **Google Fonts:** tried for each family in the `font-family` list, in order, when a font isn't found otherwise.
    - The CLI downloads only the unicode-range subsets it needs and caches them in `--font-cache <dir>` (default `~/.cache/svg2lottie/fonts`). `--no-google-fonts` turns this off.
    - The web UI fetches WOFF2 directly from Google Fonts, caches it in the browser, and has a Google Fonts toggle.
- **Fonts you supply win over Google Fonts downloads** for the same family.
- If no source has the font, you get warning `font-missing` and that text is skipped. `--strict` fails, and everything else still converts.
- The original strings are always kept as accessibility metadata:
  - Lottie `meta.d` holds the label, and `meta.a11y` holds the label, source, title, description and every text.
  - The dotLottie manifest gets `description` and `accessibility`.
  - Label priority: `--alt "…"` (or the web **Accessible text** panel) > root `aria-label` > root `<title>` > all text in document order.
  - Players can apply the label with `@svg2lottie/a11y`. Layer names look like `id: Text "…"`.

## Fonts to prefer

- **Google Fonts families** such as Inter, Roboto, Noto Sans, Manrope or DM Sans. They resolve automatically in both the CLI and the web UI.
- Brand or system fonts (SF Pro, Helvetica, licensed faces) must be provided with `--fonts <dir>` or an upload.
- Always name a **concrete** family. Only generic families (`sans-serif`, `system-ui`, …) produce `font-missing`.
- Variable fonts are fine. The `wght` axis is instanced at the requested weight.

## Weights and styles

- Use a weight the font actually has. Figma exports `font-weight="bold"` (700) or numeric weights.
- There is **no faux bold**. If 600+ is requested but the best face is ≤500, you get warning `font-synthetic-bold`: the outlines use the lighter face, look thinner than in Figma or the browser, and `--strict` fails. Supply or pick the real bold face.
- A missing italic face is slanted like browsers do. This is info `font-synthetic-italic`, so it passes, but the real italic face is better.
- Characters missing from every listed family produce warning `glyph-missing` and are skipped. List a fallback family that covers them, such as Noto.

## Letter-spacing, alignment and layout

- Letter-spacing works in px or em (Figma exports `letter-spacing="-0.02em"`). A non-zero value turns off optional ligatures, as browsers do. Word-spacing works too.
- Alignment works. Figma bakes it into each line's `tspan x`, and `text-anchor` start/middle/end is honoured per text chunk. `dominant-baseline` and `baseline-shift` follow Blink.
- Fixed-width and auto-width text boxes are fine, because Figma exports one `tspan` per line. `xml:space`/`white-space: pre` are respected.
- Animate text as a layer: transform, opacity, and fill/stroke colour all animate.

These are skipped with a warning, so avoid them:
- `textPath`: text on a path.
- `textLength`: fixed text width.
- Text decoration: underline or strikethrough (`text-decoration`). Draw a line shape instead.
- Vertical text (`text-vertical`), and RTL or bidi text (`text-direction`, `text-bidi`).
- `font-variant`.
- Animated `x`/`y`/`font-size`/`letter-spacing` (`text-animation`). Only the first frame is used.
- `transform` on a `tspan` is ignored (`tspan-transform`).

## Live text vs pre-outlined

| Keep live text (Outline text: **off**) when | Pre-outline in Figma (Outline text: **on**) when |
|---|---|
| The font is on Google Fonts or you can pass it with `--fonts` or an upload | The font can't be obtained or licensed where the conversion runs |
| You want the text as the accessible label and in layer names automatically | The text uses underline, RTL, vertical text or text on a path |
| The copy may change and should stay editable | Only a lighter face exists for the weight you need (no faux bold) |

Live text is the default recommendation. With pre-outlined text there is no text metadata, so pass `--alt "…"` (or give the SVG a `<title>`) to keep an accessible label.

## Self-check

```bash
node packages/cli/dist/cli.js anim.svg -o out/anim.lottie --strict --fonts ./fonts   # add --no-google-fonts for offline builds
pnpm verify anim.svg --fonts ./fonts --frames 24
```

- The `font: … from Google Fonts` lines show which families were downloaded.
- Exit 0 means every text was outlined with a real face at the requested weight.
- `pnpm verify` serves the same font files to Chrome, so live text is compared glyph for glyph. On the text fixtures, at most 0.51% of pixels differ.
