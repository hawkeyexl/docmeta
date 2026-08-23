# Design

The docs site and the demo videos are the two things people see before they run
`docmeta` once. This page is what they both follow.

## Why this exists

Three demo videos were produced in a single session, from one skill, by three
agents given the same brief. They came out with **three different accent colours
and two different layout models**:

| Video | Accent | Band background | Layout model |
|---|---|---|---|
| `write-support-1x1` | `#4FA978` green | `#101010` | uniform `scale 0.9`, band at y=886 |
| `action-precommit-1x1` | `#58a6ff` blue | `#0d0d0d` | title band 112px, caption band 86px |
| `fill-local-1x1` | `#4EC9D9` cyan | — | per-beat crop, no band constants |

Only three things were consistent: the 1080×1080/30fps frame, JetBrains Mono,
and the `#171717` terminal background — and that last one only because every
agent sampled it from the same VHS capture rather than because anyone chose it.

Two of those three accents were also **wrong**, in a way nobody caught, because
nothing had written down that docmeta's own output already assigns meaning to
colour. See [Reserved colours](#reserved-colours).

Meanwhile the docs site is stock Starlight: no `customCss`, no tokens, no
relationship to any of it.

## Reserved colours

`docmeta` is a CLI whose output is the thing being demonstrated. That output
already uses colour semantically, in `src/reporters/fill.ts`:

| Colour | Means, in docmeta's own output |
|---|---|
| red | a failure — `✗` |
| green | a success — `✓` |
| yellow | a warning, or a required field that could not be filled |
| cyan | **a metadata field name** — `/type`, `/audience` |
| dim | secondary detail — confidence scores, paths |

**A brand accent may not be any of those.** Not as a preference — because the
frame shows product output and chrome at the same time, and a shared colour
makes a viewer read a relationship that is not there.

Both defects are visible in shipped frames. In `fill-local-1x1` the beat title
and the `/title` `/audience` `/status` field names are the same cyan. In
`write-support-1x1` the accent is the same green as the `✓` it sits above.

Red, green, yellow and cyan are spoken for. The accent is **blue**, and that is
the whole derivation.

## Palette

| Token | Dark | Light | Use |
|---|---|---|---|
| `accent` | `#58a6ff` | `#0969da` | Chrome only: rules, titles, active nav, links |
| `bg` | `#171717` | `#ffffff` | Terminal background; page background |
| `bg-band` | `#0d0d0d` | `#f6f8fa` | Video title/caption bands; sidebar |
| `text` | `#ffffff` | `#1f2328` | Captions, body copy |
| `text-muted` | `#d5dbe3` | `#59636e` | Secondary captions, metadata |

Two accent values, one hue, because one value cannot serve both. Measured
contrast, computed rather than assumed:

| Pair | Ratio | WCAG 2.2 AA |
|---|---|---|
| `#58a6ff` on `#171717` | **7.10** | passes at any size |
| `#58a6ff` on `#0d0d0d` | **7.69** | passes at any size |
| `#ffffff` on `#171717` | **17.93** | passes at any size |
| `#d5dbe3` on `#171717` | **12.87** | passes at any size |
| `#0969da` on `#ffffff` | **5.19** | passes at any size |
| `#58a6ff` on `#ffffff` | **2.53** | **fails** — never use the dark accent on light |

AA is 4.5:1 for normal text and 3:1 for large text (18pt/24px, or 14pt bold).
That last row is why the light value exists.

## Type

**JetBrains Mono everywhere**, chrome included, not just the terminal. It is
already what the captures use, and a proportional chrome font would draw a line
between "the tool" and "us talking about the tool" that this project does not
want — the product *is* the terminal.

Sizes are given per surface below, because a px in a 1080 video frame and a px
in a browser are not the same thing.

## Video

### Frame and container

| Property | Value | Why |
|---|---|---|
| Aspect | **1:1**, 1080×1080 | The safest ratio across the LinkedIn feed on both desktop and mobile |
| Frame rate | 30fps | Composition base; see the VHS note below |
| Container | MP4, H.264, yuv420p, AAC 48kHz | Broadest compatibility |
| Length | **20–45s** | |
| Loudness | **−16 LUFS, −1.5 dBTP** | Two-pass `loudnorm`, once, on the finished mix — never per beat |

A 1:1 cut is **not a crop of a 16:9 master**. Cropping 1920 to 1080 discards 44%
of the width, which on terminal footage deletes file paths and schema tags — the
content. Build format-native captures.

**VHS reports 25fps regardless of the tape setting.** Probe the capture and
convert to the 30fps composition base before computing any trim.

### Capture geometry

| Property | Value |
|---|---|
| `Set Width` / `Set Height` | `1200` / `980` |
| `Set Padding` | `0` |
| `Set CursorBlink` | `false` |
| `Set TypingSpeed` | `35ms`–`70ms` |
| `Set FontSize` | **measured — see below** |

**Font size is derived, not chosen.** Measure the longest real line the demo will
print, then pick the largest size whose column count exceeds it. Do not copy a
number from another video; the three shipped videos legitimately use 23, 28 and
30 because their longest lines differ.

Two traps, both hit for real:

- **`pre-commit` pads its status line to 79 columns** via `max(cols, 80)` in its
  own source, regardless of terminal width or `COLUMNS`. No amount of `tput` or
  `export COLUMNS` changes it.
- **Column count moves in steps, not linearly**, because glyph advance rounds to
  a whole pixel. FontSize 24 gives 78 columns and 23 gives 83. Landing one column
  short is *worse* than landing fifteen short: a 79-character line at 78 columns
  orphans a single character onto the next row, which reads as a broken renderer
  rather than as wrapped output.

Crop each capture to its **used rows** before scaling. A tape is 980px tall and a
five-line demo uses a third of it; without the crop, half the square is empty and
the type is smaller than it needed to be.

### Composition

```text
┌─────────────────────────────┐
│  Title band          n / N  │  112px, bg-band, accent text
├─────────────────────────────┤  2px accent rule
│                             │
│  Terminal capture           │  cropped to used rows, centred
│                             │
├─────────────────────────────┤  2px accent rule
│      Caption band           │  86px, bg-band, text
└─────────────────────────────┘
```

| Element | Size | Colour | Position |
|---|---|---|---|
| Beat title | 40–52px | `accent` | Title band, left, 44px inset |
| Beat counter `n / N` | 28px | `accent` | Title band, right, 44px inset |
| Caption | 30–32px | `text` / `text-muted` | Caption band, centred |

**Captions or step titles are mandatory.** LinkedIn autoplays muted, so a demo
with no on-screen text is a silent flicker in the feed. This is not polish; it is
the only thing most viewers will read.

### Timing

Narration is generated first and **measured** with `ffprobe`. Word-count
arithmetic is not a model of speech — `v2.0.0` is one word that reads as seven
syllables, and release demos are dense with exactly that.

| Property | Value |
|---|---|
| Card length | measured narration + ~1.4–1.7s pad |
| Speed-up ceiling | **1.3×** |
| Above the ceiling | stop scaling; cut dead air instead |

That last row is worth stating plainly, because the alternative is a video that
feels rushed. When a real command takes 43 seconds, do not run the whole beat at
4×. Compress **only the static wait** — typing and output stay at 1× — and
disclose the real elapsed time on screen. Bash's own `time` output in frame is
the strongest form of that disclosure, because it is the command's output rather
than a label someone wrote.

### Honesty

Everything on screen is real execution. Staging the input is fine; faking the
output is not.

- A warm cache is disclosed or avoided. `docmeta` prints `· 3 cached` itself — if
  that undercuts the claim the video is making, re-shoot cold rather than hide
  it.
- Latency is disclosed, not trimmed away.
- A claim that is not shown is not made. "No network" belongs on screen only if a
  run with no network is what was filmed, or the claim is independently verified
  and carried as narration rather than presented as a demonstrated result.

## Website

The site is Starlight. Theming is a `customCss` entry in `astro.config.mjs`
pointing at a stylesheet that overrides Starlight's own custom properties:

```js
starlight({
  title: "docmeta",
  customCss: ["./src/styles/docmeta.css"],
})
```

Map the palette onto Starlight's tokens:

| Starlight token | Value |
|---|---|
| `--sl-color-accent` | `#58a6ff` dark / `#0969da` light |
| `--sl-color-accent-low` / `--sl-color-accent-high` | darker/lighter steps of the same hue |
| `--sl-color-bg` | `#171717` dark / `#ffffff` light |
| `--sl-color-bg-sidebar`, `--sl-color-bg-nav` | `bg-band` |
| `--sl-color-text` | `text` |
| `--sl-color-white`, `--sl-color-gray-1` … `--sl-color-gray-7` | the neutral ramp |

Starlight ships light and dark themes and switches on `[data-theme]`, so define
both. Never ship the dark accent into light mode — 2.53:1, and unreadable.

### Code blocks

Code is the site's primary content, so it carries the most weight:

- The background in a code block is the same `#171717` the videos use, so a
  snippet and a still frame read as the same surface.
- Never use colour as the only carrier of meaning. `✗` and `✓` differ in glyph as
  well as hue, which is what makes them survive both a greyscale screenshot and a
  colour-blind reader.
- Wide blocks scroll inside their own container. The page body never scrolls
  horizontally.

### Images and embedded video

- A demo video embedded in a page is the **native or 16:9 cut**, not the 1:1
  social cut. The square exists for a feed; a docs page has width.
- Alt text describes the outcome, not the chrome: "docmeta reports 3 files
  failed", not "screenshot of a terminal".

## What must match, and what may not

| Must match across both surfaces | May differ |
|---|---|
| Accent hue, and the reserved-colour rule | Exact accent value (dark vs light) |
| `#171717` terminal/code background | Page background |
| JetBrains Mono | Size scales |
| The `✓` / `✗` / field-name semantics | Layout entirely |

The first column exists so that a still from a video and a code block on the site
look like the same product. The second exists because a 1080×1080 feed post and a
docs page have nothing else in common, and forcing them to share a layout helps
nobody.

## Checks before shipping

Video:

1. Longest real line measured against the chosen font size, with the column count
   read from the actual capture rather than calculated.
2. No text touching the frame edge; no token split across a line break.
3. Captions present on every beat.
4. `ffprobe` confirms 1080×1080 and the intended duration.
5. Loudness measured on the finished file, not assumed from the filter.
6. Accent is not red, green, yellow or cyan.

Site:

1. Contrast computed for every text/background pair, in both themes.
2. Light and dark both defined; no token defined only inside a media query.
3. `docmeta validate` passes on the changed pages — editing frontmatter is a
   validation change, not a prose change.

## Open

- **No logo or wordmark exists.** The videos have no end card and the site has no
  `logo` in its Starlight config. Worth deciding before either surface grows a
  fourth accent colour.
- **The light theme is untested.** Every value above is measured, but the site has
  never rendered with a custom stylesheet, so the neutral ramp is a starting
  point rather than a result.
- **The three shipped videos do not follow this page.** They are not being
  re-rendered for consistency alone; the next one follows it, and any re-shoot
  adopts it.
