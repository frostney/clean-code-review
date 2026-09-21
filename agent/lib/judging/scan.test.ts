import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { commentRanges } from './scan';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));

function stripped(text: string, path: string): string {
  const ranges = commentRanges(text, path);
  if (ranges === null) {
    throw new Error(`no scanner for ${path}`);
  }
  const mask = new Uint8Array(text.length);
  for (const { start, end } of ranges) {
    mask.fill(1, start, end);
  }
  return [...text].filter((_, i) => !mask[i]).join('');
}

/** What the scanner must not touch: every trap is code that looks like a comment. */
function keeps(path: string, text: string, ...traps: string[]): void {
  const out = stripped(text, path);
  for (const trap of traps) {
    assert.ok(out.includes(trap), `${trap} was taken out of ${out}`);
  }
}

describe('JavaScript and TypeScript', () => {
  test('takes line and block comments', () => {
    assert.equal(stripped('a; // one\nb; /* two */ c;', 'a.ts'), 'a; \nb;  c;');
  });

  test('leaves strings that hold comment markers', () => {
    keeps(
      'a.ts',
      `const u = 'http://example.com/a'; const v = "/* not a comment */";`,
      'http://example.com/a',
      '/* not a comment */',
    );
  });

  // biome-ignore-start lint/suspicious/noTemplateCurlyInString: the placeholders are the subject under test
  test('leaves template literals, including their expressions', () => {
    keeps(
      'a.ts',
      'const t = `see // here ${x} and /* here */ ${ { a: `${b}//c` } }`;',
      'see // here',
      'and /* here */',
      '`${b}//c`',
    );
  });
  // biome-ignore-end lint/suspicious/noTemplateCurlyInString: end of the subject

  test('leaves regex literals that contain slashes', () => {
    keeps(
      'a.ts',
      'const r = /https?:\\/\\/[^/]+/g; const s = /[/*]/; x = a / b; // gone',
      'https?:',
      '/[/*]/',
    );
    assert.ok(!stripped('const r = /a/; // gone', 'a.ts').includes('gone'));
  });

  test('division after a value is not a regex', () => {
    keeps('a.ts', 'const x = a[0] / b; const y = f() / 2; // gone', 'a[0] / b');
    assert.ok(!stripped('const y = f() / 2; // gone', 'a.ts').includes('gone'));
  });

  test('leaves JSX text that looks like a comment', () => {
    keeps(
      'a.tsx',
      '<p>Visit http://example.com and /* keep */ this</p>',
      'http://example.com',
      '/* keep */',
    );
  });

  test('takes a JSX comment container whole', () => {
    assert.equal(stripped('<p>{/* gone */}x</p>', 'a.tsx'), '<p>x</p>');
  });

  test('keeps a JSX expression that also holds a comment', () => {
    keeps('a.tsx', '<p>{/* why */ value}</p>', '{ value}');
  });

  test('a generic arrow is not an element', () => {
    keeps(
      'a.tsx',
      'const f = <T,>(x: T) => x;\nconst g = 1; // gone',
      'const g = 1;',
    );
  });

  test('a comparison is not an element', () => {
    keeps(
      'a.tsx',
      'const b = a <c && d> e;\nconst g = 1; // gone',
      'const g = 1;',
    );
  });

  test('an unterminated block comment ends at the file', () => {
    assert.equal(stripped('a; /* forever', 'a.ts'), 'a; ');
  });
});

describe('other languages', () => {
  test('Python: # inside strings and docstrings', () => {
    keeps(
      'a.py',
      'u = "http://x/#y"\nd = """a # b\n# c"""\nz = 1  # gone\n',
      'http://x/#y',
      'a # b',
    );
    assert.ok(!stripped('z = 1  # gone\n', 'a.py').includes('gone'));
  });

  test('Go: raw strings and directives', () => {
    keeps(
      'a.go',
      'var s = `a // b`\nvar t = "/* c */"\n// gone',
      'a // b',
      '/* c */',
    );
    assert.ok(!stripped('x := 1 // gone', 'a.go').includes('gone'));
  });

  test('Rust: lifetimes, raw strings, nested block comments', () => {
    keeps(
      'a.rs',
      "fn f<'a>(s: &'a str) {}\nlet r = r#\"a // b\"#;\nlet c = '/';\n",
      "&'a str",
      'a // b',
    );
    assert.equal(
      stripped('let x = 1; /* a /* b */ c */ let y = 2;', 'a.rs'),
      'let x = 1;  let y = 2;',
    );
  });

  test('Java: text blocks', () => {
    keeps(
      'A.java',
      'String s = """\n// not a comment\n""";\n// gone',
      '// not a comment',
    );
    assert.ok(!stripped('int x = 1; // gone', 'A.java').includes('gone'));
  });

  test('C++: raw strings and char literals', () => {
    keeps('a.cpp', 'auto s = R"x(a // b)x"; char c = \'/\'; // gone', 'a // b');
    assert.ok(!stripped('int x; // gone', 'a.cpp').includes('gone'));
  });

  test('C#: verbatim strings', () => {
    keeps('A.cs', 'var s = @"a // b ""q"" c"; // gone', 'a // b');
    assert.ok(!stripped('var x = 1; // gone', 'A.cs').includes('gone'));
  });

  test('CSS: url() and strings', () => {
    keeps(
      'a.css',
      'a { background: url(http://x/y.png); content: "/* q */"; }\n/* gone */',
      'http://x/y.png',
      '"/* q */"',
    );
    assert.ok(
      !stripped('a { color: red } /* gone */', 'a.css').includes('gone'),
    );
  });

  test('Python: f-strings keep their expressions', () => {
    keeps(
      'a.py',
      'print(f"{d[\'#k\']} done")  # gone\nx = f"{a}#{b}"\n',
      "d['#k']",
      '{a}#{b}',
    );
    assert.ok(!stripped('print(f"{a}")  # gone', 'a.py').includes('gone'));
  });

  test('Python: a quote nested in an f-string is refused, not guessed at', () => {
    // PEP 701. Reading it wrong would eat the rest of the line as a comment.
    assert.equal(
      commentRanges('print(f"{d["#k"]} done")  # real\n', 'a.py'),
      null,
    );
  });

  test('an unknown language has no scanner', () => {
    assert.equal(commentRanges('-- a\n', 'a.sql'), null);
    assert.equal(commentRanges('# a\n', 'Makefile'), null);
  });
});

/**
 * The oracle: every comment is trivia of some token, so the TypeScript
 * scanner's ranges over the repository's own sources are the answer this
 * scanner has to reproduce. Both leading and trailing are needed — a comment
 * on the same line as the token before it is only ever trailing.
 * `typescript` is a dev dependency, so it may be imported here but not by the
 * agent.
 */
function typescriptRanges(text: string, path: string): Set<string> {
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out = new Set<string>();
  const visit = (node: ts.Node): void => {
    const children = node.getChildren(source);
    if (children.length === 0) {
      const at = node.getFullStart();
      for (const r of [
        ...(ts.getLeadingCommentRanges(text, at) ?? []),
        ...(ts.getTrailingCommentRanges(text, at) ?? []),
      ]) {
        out.add(`${r.pos}:${r.end}`);
      }
      return;
    }
    for (const child of children) {
      visit(child);
    }
  };
  visit(source);
  return out;
}

/** Empty when the two scanners agree about `path`. */
function disagreements(path: string, text: string): string[] {
  const expected = typescriptRanges(text, path);
  const found = new Set(
    (commentRanges(text, path) ?? []).map((r) => `${r.start}:${r.end}`),
  );
  const out = [...expected]
    .filter((range) => !found.has(range))
    .map((range) => `${path} missed ${range}`);
  for (const range of found) {
    const [start, end] = range.split(':').map(Number);
    const slice = text.slice(start, end);
    // An extra range is allowed only for a `{/* … */}` container, which this
    // scanner removes whole.
    if (!expected.has(range) && !/^\{[\s\S]*\}$/.test(slice)) {
      out.push(`${path} invented ${range}: ${JSON.stringify(slice)}`);
    }
  }
  return out;
}

describe('against the TypeScript scanner', () => {
  const paths = execFileSync(
    'git',
    ['ls-files', '-co', '--exclude-standard', '*.ts', '*.tsx'],
    {
      cwd: REPO,
      encoding: 'utf8',
    },
  )
    .split('\n')
    .filter(Boolean);

  test(`finds every comment TypeScript finds, in all ${paths.length} sources`, () => {
    assert.ok(paths.length > 50);
    const disagreed = paths.flatMap((path) =>
      disagreements(path, readFileSync(join(REPO, path), 'utf8')),
    );
    assert.deepEqual(disagreed, []);
  });
});
