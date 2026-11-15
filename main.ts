// Driver: renders every case in the input set with parse() and writes the
// HTML strings, in order, to the output file. The harness runs
// `node /bot/main.ts` (node 22); outside a container, MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

type Case = { id: string; markdown: string };

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
  const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as Case[];
  const html = cases.map((c) => parse(c.markdown));
  writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
}

main();
