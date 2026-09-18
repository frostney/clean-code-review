/**
 * Ask Jev directly (no eve in the loop) to judge one preset, or a file given
 * on the command line, and print the raw answers with timing. Proves gateway
 * access and shows what a single evaluation looks like.
 *
 *   bun run jev [preset-index | path/to/file]
 */
import { readFileSync } from 'node:fs';

import { judgeFile } from '../agent/lib/judging/judge';
import { filesFromPatch, looksLikePatch } from '../agent/lib/judging/patch';
import type { ReviewFile } from '../agent/lib/review/review';
import { PRESETS } from '../examples/presets';

const arg = process.argv[2] ?? '0';
let files: ReviewFile[];
if (/^\d+$/.test(arg)) {
  const preset = PRESETS[Number(arg)];
  if (!preset) {
    console.error(`No preset ${arg}; pick 0–${PRESETS.length - 1}.`);
    process.exit(1);
  }
  files = preset.files;
} else {
  const text = readFileSync(arg, 'utf8');
  files = looksLikePatch(text)
    ? filesFromPatch(text)
    : [{ content: text, path: arg }];
}

/** Dollars per file are printed fine enough to see a fraction of a cent. */
const COST_DIGITS = 6;

/** How wide the question-id column is. */
const ID_WIDTH = 26;

for (const file of files) {
  const { judgment, cost, warnings, model } = await judgeFile(file);
  console.log(
    `${file.path}: ${judgment.ms} ms, ${judgment.usage.input_tokens}→${judgment.usage.output_tokens} tokens, $${cost.toFixed(COST_DIGITS)}, model ${model}, warnings ${JSON.stringify(warnings)}`,
  );
  for (const [id, a] of Object.entries(judgment.answers)) {
    console.log('   ', id.padEnd(ID_WIDTH), JSON.stringify(a));
  }
}
