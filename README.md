# markdown-render-speed-02

A fast CommonMark 0.31.2 + GFM renderer. `parse(markdown)` returns exactly
the HTML that marked 18.1.3 produces with its default settings (GFM on,
breaks off, pedantic off) — only faster.

## Files

- `parse.js` — the renderer itself. A dependency-free ES module; `parse(markdown)`
  returns the HTML string for one document.
- `main.ts` — the driver the harness runs: it reads `/input/cases.json`,
  renders each case on its own with `parse`, and writes the HTML strings,
  in order, to `/output/html.json`.

## How it works

The block and inline grammars follow the shape marked uses (that shape is
what pins down the exact behaviour, including the places where marked
departs from the spec), while the hot paths — inline text scanning, HTML
escaping, and numeric reference decoding — are hand-written character scans
rather than regular expressions. Rendering works directly on tokens, with no
needless copies of the source.

Behaviour target: marked 18.1.3 (MIT), github.com/markedjs/marked at tag
v18.1.3.

## Running it

```sh
node main.ts
```

Outside the harness container, `MAKEFUN_INPUT_DIR` and
`MAKEFUN_OUTPUT_DIR` redirect the input and output directories.

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/upayy9234-art/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/upayy9234-art/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
