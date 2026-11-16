// Driver for the markdown-render-speed-02 entry.
//
// The harness runs `node /bot/main.ts`. It hands us a directory of cases
// and expects one HTML string per case, in order, written back out.
// Input lives at $MAKEFUN_INPUT_DIR/cases.json (or /input/cases.json when
// the variable is absent); output goes to $MAKEFUN_OUTPUT_DIR/html.json
// (or /output/html.json). Each case is rendered on its own by parse()
// from parse.js, which mirrors marked 18.1.3 with its default options.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

function inputDir() {
  return process.env.MAKEFUN_INPUT_DIR ?? '/input';
}

function outputDir() {
  return process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
}

function loadCases(dir) {
  const raw = readFileSync(join(dir, 'cases.json'), 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('cases.json is not an array');
  return parsed;
}

function renderAll(cases) {
  const out = new Array(cases.length);
  for (let k = 0; k < cases.length; k++) {
    out[k] = parse(cases[k].markdown);
  }
  return out;
}

const cases = loadCases(inputDir());
const html = renderAll(cases);
writeFileSync(join(outputDir(), 'html.json'), JSON.stringify(html));
