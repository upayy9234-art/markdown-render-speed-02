// Driver: me-render setiap case pada set masukan dengan parse() lalu
// menulis string HTML-nya, berurutan, ke file keluaran. Harness menjalankan
// `node /bot/main.ts` (Node 22); di luar container, MAKEFUN_INPUT_DIR dan
// MAKEFUN_OUTPUT_DIR menggantikan /input dan /output.

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
