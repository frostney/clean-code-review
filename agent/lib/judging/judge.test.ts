import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MAX_JUDGED_CHARS, REVIEW_LIMITS } from '../review/review';
import { judgePlan } from './judge';
import { afterImage, isHunkHeader } from './patch';

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
