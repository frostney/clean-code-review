/**
 * Ask Jev directly (no eve in the loop) to judge one preset, or a file given
 * on the command line, and print the raw answers with timing. Proves gateway
 * access and shows what a single evaluation looks like.
 *
 *   npx tsx --env-file=.env.local scripts/jev-once.ts [preset-index | path/to/file]
 */
import { readFileSync } from "node:fs";
import { judgeFile } from "../agent/lib/judge";
import { filesFromPatch, looksLikePatch } from "../agent/lib/patch";
import { PRESETS } from "../agent/lib/presets";
import type { ReviewFile } from "../agent/lib/review";

const arg = process.argv[2] ?? "0";
let files: ReviewFile[];
if (/^\d+$/.test(arg)) {
  const preset = PRESETS[Number(arg)];
  if (!preset) {
    console.error(`No preset ${arg}; pick 0–${PRESETS.length - 1}.`);
    process.exit(1);
  }
  files = preset.files;
} else {
  const text = readFileSync(arg, "utf8");
  files = looksLikePatch(text) ? filesFromPatch(text) : [{ path: arg, content: text }];
}

for (const file of files) {
  const { judgment, cost, warnings, model } = await judgeFile(file);
  console.log(`${file.path}: ${judgment.ms} ms, ${judgment.usage.input_tokens}→${judgment.usage.output_tokens} tokens, $${cost.toFixed(6)}, model ${model}, warnings ${JSON.stringify(warnings)}`);
  for (const [id, a] of Object.entries(judgment.answers)) console.log("   ", id.padEnd(26), JSON.stringify(a));
}
