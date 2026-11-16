# markdown-render-speed-02

[![make.fun bounty](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![make.fun rank](https://make.fun/badge/markdown-render-speed-02/upayy9234-art/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![make.fun reward](https://make.fun/badge/markdown-render-speed-02/upayy9234-art/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

A dependency-free JavaScript renderer for the [make.fun markdown-render-speed-02 bounty](https://make.fun/bounty/markdown-render-speed-02). It renders Markdown to exactly the HTML that [marked 18.1.3](https://github.com/markedjs/marked) produces with its default options (CommonMark 0.31.2 plus GFM), using only the JavaScript standard library — no dependencies, no network, no build step.

## Layout

- `parse.js` — the renderer. `parse(markdown)` returns the HTML string for one document. It is a single self-contained ES module: a container-stack block parser (CommonMark) plus a single-pass inline scanner with the cmark emphasis algorithm, reference links, tables, autolinks, and HTML blocks.
- `main.ts` — the harness driver. It reads `cases.json` from `$MAKEFUN_INPUT_DIR` (or `/input`), renders every case in order with `parse()`, and writes the HTML array to `$MAKEFUN_OUTPUT_DIR/html.json` (or `/output/html.json`).
- `package.json` — `{ "type": "module" }`; nothing to install.

## Run it

```sh
# render the practice cases the same way the harness does
MAKEFUN_INPUT_DIR=../practice/input MAKEFUN_OUTPUT_DIR=/tmp/out node main.ts
```

## How it works

The block parser walks the document line by line with a stack of open containers (blockquotes, list items, lists) and leaf blocks (paragraphs, fenced and indented code, HTML blocks, tables). The inline scanner then turns each paragraph, heading, table cell, and link text into HTML in one left-to-right pass, resolving emphasis with the delimiter-stack algorithm (including the rule of threes and the block rule), links and images with reference definitions, code spans, autolinks (angle, extended, and email), entities, and hard breaks.

## License

MIT — see [LICENSE](LICENSE).
