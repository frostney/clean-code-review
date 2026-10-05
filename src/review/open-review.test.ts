import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fromPaste, skippedText } from './open-review';

test('a pasted config file is listed as skipped, not judged', () => {
  const review = fromPaste(
    [
      '// file: src/a.ts',
      'export const a = 1;',
      '// file: config.yaml',
      'key: value',
    ].join('\n'),
    'paste',
  );

  assert.deepEqual(
    review?.files.map((f) => f.path),
    ['src/a.ts'],
  );
  assert.deepEqual(review?.skipped, [
    { path: 'config.yaml', reason: 'not_code' },
  ]);
});

test('the skipped line names data and config files', () => {
  assert.equal(
    skippedText(
      [{ reason: 'not_code' }, { reason: 'not_code' }, { reason: 'generated' }],
      3,
    ),
    'Skipped 1 generated file and 2 data, config or other non-code files',
  );
});

test('code under a comment that names a config file is still judged', () => {
  const review = fromPaste(
    '// package.json scripts run this\nexport function a() {\n  return 1;\n}',
    'paste',
  );

  assert.equal(review?.files.length, 1);
  assert.doesNotMatch(review?.files[0].path ?? '', /\.json$/);
  assert.deepEqual(review?.skipped, []);
});

test('a fenced JSON paste is skipped as not code', () => {
  const review = fromPaste('```json\n{"a": 1}\n```', 'paste');

  assert.deepEqual(review?.files, []);
  assert.deepEqual(review?.skipped, [
    { path: 'snippet.json', reason: 'not_code' },
  ]);
});
