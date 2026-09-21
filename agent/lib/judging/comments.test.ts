import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import {
  COMMENT_LEAN_THRESHOLD,
  strippedText,
  withoutComments,
} from './comments';
import { afterImage } from './patch';

/** The stripped text, or the kind of non-answer that came back instead. */
function strip(file: {
  path: string;
  content: string;
  patch?: boolean;
}): string {
  const out = withoutComments(file);

  return out.kind === 'stripped' ? strippedText(out.lines) : out.kind;
}

function stripTs(content: string): string {
  return strip({ content, path: 'a.ts' });
}

describe('withoutComments', () => {
  test('drops comment-only lines and trims the rest', () => {
    assert.equal(
      stripTs('// why\nconst a = 1; // because\nconst b = 2;\n'),
      'const a = 1;\nconst b = 2;\n',
    );
  });

  test('keeps comments a tool reads', () => {
    const source =
      '// biome-ignore lint/style/noVar: a reason\nvar a = 1;\n// prose\n';

    assert.equal(
      stripTs(source),
      '// biome-ignore lint/style/noVar: a reason\nvar a = 1;\n',
    );
  });

  test('keeps a shebang', () => {
    assert.equal(
      stripTs('#!/usr/bin/env bun\nconst a = 1; // gone\n'),
      '#!/usr/bin/env bun\nconst a = 1;\n',
    );
  });

  test('a file without comments needs no second pass', () => {
    assert.equal(stripTs('const a = 1;\n'), 'unchanged');
  });

  test('a language with no scanner has no second pass', () => {
    assert.equal(strip({ content: '-- a\nb;\n', path: 'a.sql' }), 'none');
  });

  test('leaves the code byte for byte', () => {
    const source = 'const r = /a\\/b/; // gone\nconst s = "// kept";\n';

    assert.equal(stripTs(source), 'const r = /a\\/b/;\nconst s = "// kept";\n');
  });

  test('strips every language it claims', () => {
    assert.equal(
      strip({ content: 'x = 1  # gone\n', path: 'a.py' }),
      'x = 1\n',
    );
    assert.equal(
      strip({ content: 'x := 1 // gone\n', path: 'a.go' }),
      'x := 1\n',
    );
    assert.equal(
      strip({ content: 'let x = 1; // gone\n', path: 'a.rs' }),
      'let x = 1;\n',
    );
    assert.equal(
      strip({ content: 'int x; // gone\n', path: 'A.java' }),
      'int x;\n',
    );
    assert.equal(
      strip({ content: 'int x; /* gone */\n', path: 'a.c' }),
      'int x;\n',
    );
    assert.equal(
      strip({ content: 'var x = 1; // gone\n', path: 'A.cs' }),
      'var x = 1;\n',
    );
    assert.equal(
      strip({ content: 'a { color: red } /* gone */\n', path: 'a.css' }),
      'a { color: red }\n',
    );
  });
});

describe('withoutComments on a diff', () => {
  const diff = [
    '@@ -1,4 +1,5 @@',
    ' const a = 1;',
    '-// old note',
    '-const b = 2;',
    '+// new note',
    '+const b = 3; // trailing',
    ' const c = 4;',
  ].join('\n');

  test('strips both sides and keeps the markers', () => {
    assert.equal(
      strip({ content: diff, patch: true, path: 'a.ts' }),
      [
        '@@ -1,4 +1,5 @@',
        ' const a = 1;',
        '-const b = 2;',
        '+const b = 3;',
        ' const c = 4;',
      ].join('\n'),
    );
  });

  test('a change to comments only leaves nothing to judge', () => {
    const commentsOnly = [
      '@@ -1,2 +1,2 @@',
      ' const a = 1;',
      '-// was',
      '+// is',
    ].join('\n');

    assert.equal(
      strip({ content: commentsOnly, patch: true, path: 'a.ts' }),
      'none',
    );
  });

  test('a comment marker inside a changed string is not a comment', () => {
    const strings = [
      '@@ -1,2 +1,2 @@',
      '-const a = "// one";',
      '+const a = "// two";',
    ].join('\n');

    assert.equal(
      strip({ content: strings, patch: true, path: 'a.ts' }),
      'unchanged',
    );
  });
});

test('the lean threshold clears the measured noise floor', () => {
  const runToRunNoise = 0.055;

  assert.ok(COMMENT_LEAN_THRESHOLD > 3 * runToRunNoise);
});

/**
 * The strongest check there is: parsing both the file and its stripped text and
 * printing each without comments must give the same program, byte for byte.
 * `typescript` is a dev dependency, so it may be imported here but not by the
 * agent.
 */
function printed(text: string, path: string): string {
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  return ts
    .createPrinter({ removeComments: true })
    .printFile(source)
    .replace(/\s+/g, ' ');
}

test('stripping changes nothing but the comments, across the repository', () => {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const paths = execFileSync(
    'git',
    ['ls-files', '-co', '--exclude-standard', '*.ts', '*.tsx'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  )
    .split('\n')
    .filter(Boolean);

  assert.ok(paths.length > 50);
  const changed = paths.filter((path) => {
    const content = readFileSync(join(root, path), 'utf8');
    const out = withoutComments({ content, path });

    return (
      out.kind === 'stripped' &&
      printed(strippedText(out.lines), path) !== printed(content, path)
    );
  });

  assert.deepEqual(changed, []);
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

describe('withoutComments on a git-formatted diff', () => {
  test('a comment-only change leaves nothing to judge', () => {
    const patch = gitPatch(
      '@@ -1,2 +1,2 @@',
      ' const a = 1;',
      '-// was',
      '+// is',
    );

    // The `+++ b/a.ts` header is not a change; without that the stripped diff
    // looks like a change to nothing and pass B judges an empty patch.
    assert.equal(strip({ content: patch, patch: true, path: 'a.ts' }), 'none');
  });

  test('a real change survives with its headers', () => {
    const patch = gitPatch(
      '@@ -1,2 +1,2 @@',
      ' const a = 1;',
      '-// was',
      '+const b = 2; // is',
    );

    assert.equal(
      strip({ content: patch, patch: true, path: 'a.ts' }),
      gitPatch('@@ -1,2 +1,2 @@', ' const a = 1;', '+const b = 2;'),
    );
  });
});

describe('a multi-file patch in one content field', () => {
  const twoFiles = [
    ...gitPatch('@@ -1,2 +1,2 @@', ' const a = 1;', '-// was', '+// is'),
  ]
    .join('')
    .concat(
      '\n',
      [
        'diff --git a/b.ts b/b.ts',
        'index 3333333..4444444 100644',
        '--- a/b.ts',
        '+++ b/b.ts',
        '@@ -1,2 +1,2 @@',
        ' const c = 3;',
        '-// old',
        '+// new',
      ].join('\n'),
    );

  test('the second file’s +++ header is not read as a change', () => {
    // Not reachable through `filesFromPatch`, which splits per file, but the
    // same mistake one level up: without it a comment-only two-file patch
    // looks like a change to a `+++` line.
    assert.equal(
      strip({ content: twoFiles, patch: true, path: 'a.ts' }),
      'none',
    );
  });

  test('afterImage does not read the second file’s header as code', () => {
    assert.ok(!afterImage(twoFiles).includes('+ b/b.ts'));
    assert.ok(!afterImage(twoFiles).includes('diff --git'));
  });
});
