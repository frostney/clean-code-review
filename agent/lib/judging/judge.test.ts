import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  MAX_JUDGED_CHARS,
  REVIEW_LIMITS,
  type ReviewFile,
} from '../review/review';
import { judgeFile, judgePlan, judgeReview } from './judge';
import { afterImage, isHunkHeader } from './patch';
import { parseReview } from './schema';

const LINE = 'const a = 1;\n';

function lines(chars: number): string {
  return LINE.repeat(Math.ceil(chars / LINE.length));
}

describe('judgePlan', () => {
  test('a short file is one window of each pass', () => {
    const plan = judgePlan({ content: '// why\nconst a = 1;\n', path: 'a.ts' });

    assert.equal(plan.a.length, 1);
    assert.equal(plan.b.length, 1);
    assert.equal(plan.cut, false);
  });

  test('a file without comments is judged once, with a lean of zero', () => {
    const plan = judgePlan({ content: LINE, path: 'a.ts' });

    assert.equal(plan.b.length, 0);
    assert.equal(plan.leanWithoutB, 0);
  });

  test('a language with no scanner is judged once, with no lean', () => {
    const plan = judgePlan({ content: '-- why\nselect 1;\n', path: 'a.sql' });

    assert.equal(plan.b.length, 0);
    assert.equal(plan.leanWithoutB, undefined);
  });

  test('a long file is split into windows that cover it', () => {
    // Short of three full windows, because each one stops at a line boundary.
    const content = lines(2.5 * REVIEW_LIMITS.maxCharsPerFile);
    const plan = judgePlan({ content, path: 'a.ts' });

    assert.equal(plan.a.length, 3);
    assert.equal(plan.cut, false);
    const windows = plan.a.map((call) => call.file.content);

    assert.equal(windows.join('\n'), content);
    for (const window of windows) {
      assert.ok(window.length <= REVIEW_LIMITS.maxCharsPerFile);
    }
  });

  test('both passes are cut at the same lines', () => {
    const body = `${LINE}// why\n`.repeat(2000);
    const plan = judgePlan({ content: body, path: 'a.ts' });

    assert.ok(plan.a.length > 1);
    assert.equal(plan.b.length, plan.a.length);
    // Window n of each pass is the same code, with and without its comments.
    plan.a.forEach((call, i) => {
      assert.ok(call.file.content.includes('// why'));
      assert.ok(!plan.b[i].file.content.includes('// why'));
      assert.equal(
        plan.b[i].file.content,
        call.file.content
          .split('\n')
          .filter((l) => l !== '// why')
          .join('\n'),
      );
    });
  });

  test('past the window cap the file is cut, and says so', () => {
    const plan = judgePlan({
      content: lines(5 * MAX_JUDGED_CHARS),
      path: 'a.ts',
    });

    assert.equal(plan.a.length, REVIEW_LIMITS.maxWindowsPerFile);
    assert.equal(plan.cut, true);
  });

  test('the two passes and the windows have different cache keys', () => {
    const content = `// why\n${lines(2 * REVIEW_LIMITS.maxCharsPerFile)}`;
    const plan = judgePlan({ content, path: 'a.ts' });
    const keys = [...plan.a, ...plan.b].map((call) => call.key);

    assert.equal(new Set(keys).size, keys.length);
  });
});

test('a windowed diff carries its hunk header into every window', () => {
  const hunk = `@@ -1,1 +1,1 @@\n${LINE.replace('const', '+const').repeat(2000)}`;
  const plan = judgePlan({ content: hunk, patch: true, path: 'a.ts' });

  assert.ok(plan.a.length > 1);
  for (const call of plan.a) {
    assert.ok(call.file.content.startsWith('@@ '));
  }
});

/** What every real path supplies: `git diff` output, headers and all. */
function gitPatch(...body: string[]): string {
  return [
    'diff --git a/a.ts b/a.ts',
    'index 1111111..2222222 100644',
    '--- a/a.ts',
    '+++ b/a.ts',
    ...body,
  ].join('\n');
}

describe('judgePlan on a windowed diff', () => {
  const added = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => `+const v${from + i} = ${from + i};`);
  // Two hunks, the first long enough that a window boundary falls inside it,
  // so the second hunk's header lands in the middle of a later window.
  const patch = gitPatch(
    '@@ -1,1 +1,1400 @@',
    ...added(1400),
    '@@ -900,1 +2300,40 @@',
    ...added(40, 9000),
  );

  test('every window past the first begins with a hunk header', () => {
    const plan = judgePlan({ content: patch, patch: true, path: 'a.ts' });

    assert.ok(plan.a.length > 1);
    assert.ok(plan.a[0].file.content.startsWith('diff --git '));
    for (const call of plan.a.slice(1)) {
      assert.ok(call.file.content.startsWith('@@ '));
    }
  });

  test('no changed line is lost between the windows', () => {
    const plan = judgePlan({ content: patch, patch: true, path: 'a.ts' });
    const seen = plan.a.flatMap((call) =>
      afterImage(call.file.content).split('\n').filter(Boolean),
    );

    assert.equal(seen.length, 1440);
    assert.ok(seen.includes('const v0 = 0;'));
    assert.ok(seen.includes('const v1399 = 1399;'));
    assert.ok(seen.includes('const v9039 = 9039;'));
  });
});

test('a line longer than a window is cut, not sent whole', () => {
  const content = `const a = "${'x'.repeat(3 * REVIEW_LIMITS.maxCharsPerFile)}";`;
  const plan = judgePlan({ content, path: 'a.ts' });

  assert.equal(plan.a.length, 1);
  assert.equal(plan.a[0].file.content.length, REVIEW_LIMITS.maxCharsPerFile);
  assert.equal(plan.cut, true);
});

describe('the per-window cap', () => {
  const longHeader = (context: number) =>
    `@@ -1,900 +1,900 @@ ${'c'.repeat(context)}`;
  // Uniform-width lines, so a window fills to within a character of the cap
  // and any restored header pushes it over.
  const body = (n: number) =>
    Array.from({ length: n }, (_, i) => `+x[${String(i).padStart(9, '0')}];`);

  test('holds on a diff whose hunk header carries function context', () => {
    // Enough body that every window but the last fills, so a header pushes
    // each of them over rather than landing in slack.
    for (const context of [0, 200, 9_000]) {
      const patch = [longHeader(context), ...body(3000)].join('\n');
      const plan = judgePlan({ content: patch, patch: true, path: 'a.ts' });

      assert.ok(plan.a.length > 1);
      for (const call of plan.a) {
        assert.ok(
          call.file.content.length <= REVIEW_LIMITS.maxCharsPerFile,
          `${context}-character context gave a window of ${call.file.content.length}`,
        );
      }
      // The restored header keeps its counts, which is all `afterImage` reads.
      for (const call of plan.a.slice(1)) {
        assert.ok(call.file.content.startsWith('@@ -1,900 +1,900 @@'));
      }
    }
  });

  test('holds on both passes of a commented diff', () => {
    const lines = body(3000).flatMap((line, i) => [`+// note ${i}`, line]);
    const patch = [longHeader(400), ...lines].join('\n');
    const plan = judgePlan({ content: patch, patch: true, path: 'a.ts' });

    for (const call of [...plan.a, ...plan.b]) {
      assert.ok(call.file.content.length <= REVIEW_LIMITS.maxCharsPerFile);
    }
  });

  test('cuts on a code-point boundary', () => {
    // The window falls in the middle of a surrogate pair unless it is moved.
    const head = 'x'.repeat(REVIEW_LIMITS.maxCharsPerFile - 1);
    const plan = judgePlan({ content: `${head}🙂${head}`, path: 'a.ts' });
    const sent = plan.a[0].file.content;

    assert.ok(sent.length < REVIEW_LIMITS.maxCharsPerFile);
    assert.equal([...sent].length, sent.length);
  });
});

/** A surrogate that lost its pair, which is what a raw slice leaves behind. */
function hasLoneSurrogate(text: string): boolean {
  return [...text].some((c) => {
    const code = c.codePointAt(0) ?? 0;

    return code >= 0xd800 && code <= 0xdfff;
  });
}

describe('cuts fall on code-point boundaries', () => {
  test('a restored hunk header is truncated whole characters at a time', () => {
    // An emoji straddling the header cap would otherwise be halved into every
    // window that gets the header back.
    const header = `@@ -1,900 +1,900 @@ ${'c'.repeat(179)}🙂${'c'.repeat(9_000)}`;
    const patch = [
      header,
      ...Array.from({ length: 3000 }, (_, i) => `+x[${i}];`),
    ].join('\n');
    const plan = judgePlan({ content: patch, patch: true, path: 'a.ts' });

    assert.ok(plan.a.length > 1);
    for (const call of plan.a) {
      assert.ok(!hasLoneSurrogate(call.file.content));
    }
  });
});

test('a long line that still fits with its header is not reported as cut', () => {
  const line = 'const a = 1; '.repeat(1224);
  const plan = judgePlan({
    content: ['@@ -1,1 +1,1 @@', `+${line}`].join('\n'),
    patch: true,
    path: 'a.ts',
  });

  // Nothing was dropped: the long line arrives whole in its own window, with
  // the header put back in front of it.
  assert.equal(plan.cut, false);
  assert.ok(plan.a.at(-1)?.file.content.endsWith(line));
});

test('every reader agrees where a hunk starts', () => {
  const combined = ['@@@ -1,1 -1,1 +1,2 @@@', '+ const a = 1;'].join('\n');

  assert.ok(isHunkHeader(combined.split('\n')[0]));
  assert.ok(afterImage(combined).includes('const a = 1;'));
  const plan = judgePlan({ content: combined, patch: true, path: 'a.ts' });

  assert.ok(afterImage(plan.a[0].file.content).includes('const a = 1;'));
});

/** A certain answer at `level` of `levels`, counting from the top when negative. */
function scored(levels: number, level: number) {
  const score = level < 0 ? levels + level : level;
  const probabilities = Object.fromEntries(
    Array.from({ length: levels }, (_, i) => [String(i), i === score ? 1 : 0]),
  );

  return { probabilities, score, type: 'score' };
}

/**
 * Stands in for AI Gateway's evaluation endpoint. Every call is recorded by
 * the code it carried; `fails` picks the calls that answer 503. A window with
 * `BAD` in it is judged "Rewrite it" with every smell, anything else "Ship it".
 */
function gateway(fails: (code: string) => boolean = () => false, delayMs = 0) {
  const real = globalThis.fetch;
  const key = process.env.AI_GATEWAY_API_KEY;
  let open = 0;
  const state = {
    calls: [] as string[],
    /** The most calls in flight at once. */
    peak: 0,
    restore() {
      globalThis.fetch = real;
      if (key === undefined) {
        delete process.env.AI_GATEWAY_API_KEY;
      } else {
        process.env.AI_GATEWAY_API_KEY = key;
      }
    },
  };

  // Never used: the fetch below answers before any credential is checked.
  process.env.AI_GATEWAY_API_KEY = 'test';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);

    assert.ok(url.endsWith('/evaluation-model'), `unexpected fetch ${url}`);
    const body = JSON.parse(String(init?.body)) as {
      questions: Record<string, { type: string; criteria?: string[] }>;
      state: { code?: string; diff?: string };
    };
    const code = body.state.code ?? body.state.diff ?? '';

    state.calls.push(code);
    open++;
    state.peak = Math.max(state.peak, open);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    open--;
    if (fails(code)) {
      return Response.json(
        {
          error: {
            message: 'Service temporarily unavailable',
            type: 'internal_server_error',
          },
        },
        // `withOneRetry` honours this, so the retry does not wait out a jitter.
        { headers: { 'retry-after-ms': '0' }, status: 503 },
      );
    }
    const bad = code.includes('BAD');
    const answers = Object.fromEntries(
      Object.entries(body.questions).map(([id, q]) => [
        id,
        q.type === 'score'
          ? scored(q.criteria?.length ?? 1, bad ? 0 : -1)
          : { probability: bad ? 0.9 : 0.1, type: 'boolean' },
      ]),
    );

    return Response.json({
      answers,
      providerMetadata: { gateway: { cost: '0' } },
      rounding: { probabilityDecimals: 2, scoreDecimals: 2 },
      usage: { inputTokens: 10, outputTokens: 1 },
      warnings: [],
    });
  }) as typeof fetch;

  return state;
}

/**
 * Two windows with comments, so four calls, the first exactly one window long
 * so `second` is only in the other. `name` keeps each test's cache keys its
 * own, since the judgment cache outlives a test.
 */
function twoWindows(
  name: string,
  second = `const ${name.replaceAll('-', '_')} = 2; // why`,
): ReviewFile {
  const lines = (line: string, chars: number) =>
    Array.from({ length: Math.floor(chars / (line.length + 1)) }, () => line);
  const head = [`// ${name}`, ...lines('const a = 1; // why', 15_000)].join(
    '\n',
  );
  // A comment line that fills the window, so nothing after it fits.
  const fill = `//${'x'.repeat(REVIEW_LIMITS.maxCharsPerFile - head.length - 3)}`;

  return {
    content: [head, fill, ...lines(second, 10_000)].join('\n'),
    path: `${name}.ts`,
  };
}

function sentOf(file: ReviewFile) {
  const plan = judgePlan(file);

  return {
    a: plan.a.map((call) => call.file.content),
    b: plan.b.map((call) => call.file.content),
  };
}

describe('coverage', () => {
  test('a window lost to the gateway is counted, not hidden', async () => {
    const file = twoWindows('lost-window');
    const sent = sentOf(file);
    const jev = gateway((code) => code === sent.a[1]);

    try {
      assert.equal(sent.a.length, 2);
      assert.ok(!sent.a[0].includes('lost_window'));
      const { judgment } = await judgeFile(file);

      assert.equal(judgment.windowsPlanned, 2);
      assert.equal(judgment.windows, 1);
      // Its code was still read, without the comments.
      assert.equal(judgment.strippedOnly, 1);
      assert.equal(judgment.strippedMissing, undefined);
      // The passes cover different code, so they are not compared.
      assert.equal(judgment.commentLean, undefined);
    } finally {
      jev.restore();
    }
  });

  test('a window read only with its comments says so', async () => {
    const file = twoWindows('stripped-lost');
    const sent = sentOf(file);
    const jev = gateway((code) => code === sent.b[0]);

    try {
      const { judgment } = await judgeFile(file);

      assert.equal(judgment.windowsPlanned, 2);
      assert.equal(judgment.windows, 2);
      assert.equal(judgment.strippedMissing, true);
      assert.equal(judgment.commentLean, undefined);
    } finally {
      jev.restore();
    }
  });

  test('a whole file says nothing is missing', async () => {
    const jev = gateway();

    try {
      const { judgment } = await judgeFile(twoWindows('whole'));

      assert.equal(judgment.windowsPlanned, 2);
      assert.equal(judgment.windows, 2);
      assert.equal(judgment.strippedOnly, undefined);
      assert.equal(judgment.strippedMissing, undefined);
      assert.equal(judgment.commentLean, 0);
    } finally {
      jev.restore();
    }
  });

  test('reaches the page through the judge reply', async () => {
    const lost = twoWindows('reply-lost');
    const stripped = twoWindows('reply-stripped');
    const failing = new Set([sentOf(lost).a[1], sentOf(stripped).b[1]]);
    const jev = gateway((code) => failing.has(code));

    try {
      const { result } = await judgeReview({ files: [lost, stripped] });
      // As `jev-model.ts` writes the reply and the page reads it.
      const read = parseReview(JSON.stringify({ kind: 'judged', ...result }));

      assert.equal(read?.files[lost.path].windows, 1);
      assert.equal(read?.files[lost.path].windowsPlanned, 2);
      assert.equal(read?.files[lost.path].strippedOnly, 1);
      assert.equal(read?.files[stripped.path].windows, 2);
      assert.equal(read?.files[stripped.path].strippedMissing, true);
    } finally {
      jev.restore();
    }
  });
});

describe('judging a partly judged file again', () => {
  test('sends only the windows that did not answer', async () => {
    const file = twoWindows('retry', 'const BAD_retry = 2; // why');
    const sent = sentOf(file);
    let down = true;
    const jev = gateway((code) => down && code === sent.a[1]);

    try {
      const first = await judgeFile(file);

      // The lost window was tried twice, as `withOneRetry` does.
      assert.equal(first.judgment.windows, 1);
      assert.equal(jev.calls.filter((code) => code === sent.a[1]).length, 2);
      down = false;
      jev.calls.length = 0;
      // A fresh object with the same text, as the page's next turn sends it.
      const again = await judgeFile({ ...file });

      assert.deepEqual(jev.calls, [sent.a[1]]);
      assert.equal(again.judgment.windows, 2);
      assert.equal(again.judgment.windowsPlanned, 2);
    } finally {
      jev.restore();
    }
  });

  test('can only lower the verdict of the windows read', async () => {
    const file = twoWindows('retry-verdict', 'const BAD_verdict = 2; // why');
    const sent = sentOf(file);
    let down = true;
    // Both readings of the second window are lost, so nothing saw BAD.
    const jev = gateway(
      (code) => down && (code === sent.a[1] || code === sent.b[1]),
    );

    try {
      const first = await judgeFile(file);
      const verdict = (answers: typeof first.judgment.answers) =>
        answers.verdict?.type === 'score' ? answers.verdict.score : null;

      assert.equal(verdict(first.judgment.answers), 4);
      down = false;
      const again = await judgeFile({ ...file });

      assert.equal(verdict(again.judgment.answers), 0);
    } finally {
      jev.restore();
    }
  });
});

test('one review keeps at most eight Jev calls in flight', async () => {
  const files = ['cap-a', 'cap-b', 'cap-c', 'cap-d', 'cap-e'].map((name) =>
    twoWindows(name),
  );
  const jev = gateway(undefined, 20);

  try {
    await judgeReview({ files });

    assert.equal(jev.calls.length, 20);
    assert.equal(jev.peak, 8);
  } finally {
    jev.restore();
  }
});

test('a review past its signal returns what answered and names the rest', async () => {
  const quick = twoWindows('deadline-quick');
  const stuck = twoWindows('deadline-stuck');
  const held = new Set(sentOf(stuck).a.concat(sentOf(stuck).b));
  const real = gateway();
  // Answers everything but `stuck`, which it holds until the caller gives up.
  const answer = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      state: { code?: string };
    };

    if (!held.has(body.state.code ?? '')) {
      return answer(input, init);
    }

    return await new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(init.signal?.reason),
      );
    });
  }) as typeof fetch;
  try {
    const judged = await judgeReview(
      { files: [quick, stuck] },
      AbortSignal.timeout(200),
    );

    assert.ok(judged.result.files[quick.path]);
    assert.equal(judged.result.files[stuck.path], undefined);
    assert.equal(judged.errors.length, 1);
    assert.deepEqual(judged.stopped, [stuck.path]);
  } finally {
    real.restore();
  }
});
