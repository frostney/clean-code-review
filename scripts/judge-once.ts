/**
 * Smoke test: send every preset review to the running agent and print one
 * line per judged file — turn latency, tokens, cost, and headline answers.
 * One session, cleared between turns, exactly as the page does it.
 *
 *   bun run judge [host]
 *
 * Defaults to the local eve dev server (`npx eve dev --no-ui`).
 */
import { Client } from "eve/client";
import { PRESETS } from "../agent/lib/presets";
import { judgeMessage } from "../agent/lib/prompt";
import { questionsFor } from "../agent/lib/questions";
import { type Answers, parseReview } from "../agent/lib/schema";

const host = process.argv[2] ?? "http://127.0.0.1:2000";
const client = new Client({ host });

console.log("health", (await client.health()).status);
console.log("model", (await client.info()).agent.model.id);

function headline(a: Answers, id: string): string {
  const x = a[id];
  if (!x) return "—";
  if (x.type === "noul") return `${Math.round(x.noul * 100)}%`;
  if (x.type === "score") return x.score.toFixed(1);
  return x.choice;
}

let session: Awaited<ReturnType<typeof client.sessions.create>>["session"] | undefined;
let failures = 0;
for (const preset of PRESETS) {
  const started = performance.now();
  let response;
  const message = judgeMessage({ files: preset.files });
  if (!session) {
    ({ session, response } = await client.sessions.create({ message }));
  } else {
    await session.clear();
    response = await session.send(message);
  }
  const result = await response.result();
  const ms = Math.round(performance.now() - started);
  const steps = result.events.filter((e) => e.type === "step.completed");
  const cost = steps.reduce((acc, e: any) => acc + (e.data?.usage?.costUsd ?? 0), 0);
  const review = parseReview(result.message);
  const budgetPrompt = result.events.some((e) => e.type === "input.requested");
  const judged = Object.keys(review?.files ?? {}).length;
  const complete = preset.files.every((file) => Object.keys(review?.files[file.path]?.answers ?? {}).length === questionsFor(file).length);
  if (result.status === "failed" || budgetPrompt || !review || judged !== preset.files.length || !complete || steps.length !== 1) failures++;
  console.log(
    `${preset.label.padEnd(15)} ${result.status.padEnd(8)} steps=${steps.length} turn=${String(ms).padStart(5)}ms ` +
      `files=${judged}/${preset.files.length} tokens=${review?.usage.input_tokens ?? 0}→${review?.usage.output_tokens ?? 0} $${cost.toFixed(5)} model=${review?.model ?? "?"}`,
  );
  for (const [path, f] of Object.entries(review?.files ?? {})) {
    console.log(
      `    ${path.padEnd(24)} ${String(f.ms).padStart(4)}ms answers=${Object.keys(f.answers).length} ` +
        `many_things=${headline(f.answers, "does_more_than_one_thing")} names_hide=${headline(f.answers, "names_hide_intent")} ` +
        `null=${headline(f.answers, "returns_null")} size=${headline(f.answers, "function_size")} verdict=${headline(f.answers, "verdict")}`,
    );
  }
}
console.log(failures === 0 ? "OK" : `FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
