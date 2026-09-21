import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  blankLineFindings,
  classStringFindings,
  colourTokenFindings,
  versionRangeFindings,
  withBlankLines,
} from './check-style';

function lines(file: string, source: string): string[] {
  return blankLineFindings(file, source).map(
    (finding) => `${finding.line} ${finding.message}`,
  );
}

function messages(findings: { message: string }[]): string[] {
  return findings.map((finding) => finding.message);
}

describe('a blank line before return', () => {
  test('the only statement in a block needs none', () => {
    const source = 'function one() {\n  return 1;\n}\n';

    assert.deepEqual(lines('a.ts', source), []);
  });

  test('a return under another statement needs one', () => {
    const source = 'function one(n: number) {\n  log(n);\n  return n;\n}\n';

    assert.deepEqual(lines('a.ts', source), [
      '3 blank line missing before `return`',
    ]);
  });

  test('it goes above a comment attached to the return', () => {
    const source =
      'function one(n: number) {\n  log(n);\n  // Negative reads as unknown upstream.\n  return -n;\n}\n';

    assert.equal(
      withBlankLines('a.ts', source),
      'function one(n: number) {\n  log(n);\n\n  // Negative reads as unknown upstream.\n  return -n;\n}\n',
    );
  });

  test('the sole statement of an arrow body is still sole', () => {
    const source =
      'const one = () => {\n  return 1;\n};\nconst two = (n: number) => {\n  log(n);\n  return n;\n};\n';

    assert.deepEqual(lines('a.ts', source), [
      '6 blank line missing before `return`',
    ]);
  });

  test('a switch case is a statement list of its own', () => {
    const source =
      "function pick(n: number) {\n  switch (n) {\n    case 1: {\n      log(n);\n      return 'one';\n    }\n    default:\n      log(n);\n      return 'many';\n  }\n}\n";

    assert.deepEqual(lines('a.ts', source), [
      '5 blank line missing before `return`',
      '9 blank line missing before `return`',
    ]);
  });
});

describe('a blank line after a run of declarations', () => {
  test('consecutive declarations stay together', () => {
    const source =
      'function one() {\n  const a = 1;\n  const b = 2;\n  const c = a + b;\n\n  log(c);\n}\n';

    assert.deepEqual(lines('a.ts', source), []);
  });

  test('the statement after the run is separated once', () => {
    const source =
      'function one() {\n  const a = 1;\n  const b = 2;\n  log(a + b);\n}\n';

    assert.deepEqual(lines('a.ts', source), [
      '4 blank line missing after the declarations above',
    ]);
  });
});

/**
 * `<T>(x) => x` is a generic arrow in TypeScript and an unclosed JSX element in
 * TSX, where it swallows the rest of the file. Nothing else found here parses
 * differently enough to notice, so this is what pins the kind to the extension.
 */
const KIND_SENSITIVE =
  'const id = <T>(x: T) => x;\n\nfunction tail(n: number) {\n  const m = n;\n  log(m);\n  return m;\n}\n';

describe('parsing', () => {
  test('the extension chooses the script kind', () => {
    assert.deepEqual(lines('generic.ts', KIND_SENSITIVE), [
      '5 blank line missing after the declarations above',
      '6 blank line missing before `return`',
    ]);
    assert.deepEqual(lines('generic.tsx', KIND_SENSITIVE), []);
  });

  test('a .tsx file keeps its JSX and its class strings', () => {
    const source =
      'function Chip(props: { n: number }) {\n  const label = String(props.n);\n  return <span className="text-xs">{label}</span>;\n}\n';

    assert.deepEqual(lines('Chip.tsx', source), [
      '3 blank line missing before `return`',
    ]);
    assert.deepEqual(classStringFindings('Chip.tsx', source), []);
  });

  test('a namespace body is a statement list too', () => {
    const source = 'namespace N {\n  const a = 1;\n  log(a);\n}\n';

    assert.deepEqual(lines('a.ts', source), [
      '3 blank line missing after the declarations above',
    ]);
  });

  test('fixing twice changes nothing the second time', () => {
    const source =
      'function one(n: number) {\n  const a = n;\n  log(a);\n  return a;\n}\n';
    const once = withBlankLines('a.ts', source);

    assert.equal(withBlankLines('a.ts', once), once);
    assert.equal(once.split('\n').length, source.split('\n').length + 2);
  });

  test('a CRLF file keeps its line endings', () => {
    const source =
      'function one(n: number) {\r\n  const a = n;\r\n  log(a);\r\n  return a;\r\n}\r\n';
    const fixed = withBlankLines('a.ts', source);

    assert.equal(fixed.includes('\n\n'), false);
    assert.equal(fixed.split('\r\n\r\n').length, 3);
  });
});

describe('colours and type sizes in class strings', () => {
  test('a colour literal is reported unless the file hands it to the platform', () => {
    const source = "export const meta = { themeColor: '#0d1117' };\n";

    assert.equal(classStringFindings('src/site/meta.ts', source).length, 1);
    assert.deepEqual(classStringFindings('src/app/manifest.ts', source), []);
  });

  test('the platform files are excused the literal, not the utilities', () => {
    const source =
      "const cls = 'text-red-500 dark:bg-blue-200';\nconst bg = '#0d1117';\n";

    assert.deepEqual(
      messages(classStringFindings('src/app/layout.tsx', source)),
      [
        'Tailwind palette utility `text-red-500`',
        'Tailwind palette utility `bg-blue-200`',
        '`dark:` variant, not a palette token',
      ],
    );
  });

  test('palette utilities and dark variants are reported', () => {
    const source = "const cls = 'text-red-500 dark:bg-blue-200';\n";

    assert.deepEqual(messages(classStringFindings('src/ui/Chip.tsx', source)), [
      'Tailwind palette utility `text-red-500`',
      'Tailwind palette utility `bg-blue-200`',
      '`dark:` variant, not a palette token',
    ]);
  });

  test('the dark variant needs a utility after the colon', () => {
    const prose = "const help = 'the dark: prefix is not used here';\n";
    const real = "const cls = 'dark:bg-surface';\n";

    assert.deepEqual(classStringFindings('src/ui/Chip.tsx', prose), []);
    assert.equal(classStringFindings('src/ui/Chip.tsx', real).length, 1);
  });

  test('only the named fixture file may write the forbidden strings', () => {
    const source = "const cls = 'text-red-500';\n";

    assert.deepEqual(
      classStringFindings('scripts/check-style.test.ts', source),
      [],
    );
    assert.equal(classStringFindings('src/ui/Chip.test.tsx', source).length, 1);
  });

  test('the message says whether the brackets hold a length', () => {
    const source = "const cls = 'text-[13px] text-[var(--edge)]';\n";

    assert.deepEqual(messages(classStringFindings('src/ui/Chip.tsx', source)), [
      'type size `text-[13px]` is off the five-step scale',
      'arbitrary type size `text-[var(--edge)]`: type comes from the five-step scale',
    ]);
  });

  test('the pixel face keeps its own two sizes', () => {
    const source = "const cls = 'text-[8px] text-[0.9em]';\n";

    assert.equal(
      classStringFindings('src/review/ReviewNote.tsx', source).length,
      2,
    );
    assert.equal(
      classStringFindings('src/landing/Tutorial.tsx', source).length,
      1,
    );
  });
});

const FIVE_PLACES = `@theme inline {
  --color-page: var(--page);
  --color-ink: var(--ink);
}
:root {
  --page: #ffffff;
  --ink: #1f2328;
}
:root {
  --dark-page: #0d1117;
  --dark-ink: #e6edf3;
}
:root[data-theme="dark"] {
  --page: var(--dark-page);
  --ink: var(--dark-ink);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --page: var(--dark-page);
    --ink: var(--dark-ink);
  }
}
`;

function withoutLine(css: string, line: string): string {
  assert.equal(css.includes(line), true);

  return css.replace(line, '');
}

describe('the colour-token invariant', () => {
  test('a token written in all five places passes', () => {
    assert.deepEqual(colourTokenFindings('globals.css', FIVE_PLACES), []);
  });

  test('a token missing from the `@theme inline` mapping is reported', () => {
    const css = withoutLine(FIVE_PLACES, '  --color-ink: var(--ink);\n');

    assert.deepEqual(messages(colourTokenFindings('globals.css', css)), [
      'colour token `--ink` is missing from `@theme inline`',
    ]);
  });

  test('a token missing from the light `:root` is reported', () => {
    const css = withoutLine(FIVE_PLACES, '  --ink: #1f2328;\n');

    assert.deepEqual(messages(colourTokenFindings('globals.css', css)), [
      'colour token `--ink` is missing from the light `:root`',
    ]);
  });

  test('a token missing from the `--dark-*` root is reported', () => {
    const css = withoutLine(FIVE_PLACES, '  --dark-ink: #e6edf3;\n');

    assert.deepEqual(messages(colourTokenFindings('globals.css', css)), [
      'colour token `--ink` is missing from the `--dark-*` `:root`',
    ]);
  });

  test('a token missing from the explicit dark switch is reported', () => {
    const css = withoutLine(FIVE_PLACES, '  --ink: var(--dark-ink);\n');

    assert.deepEqual(messages(colourTokenFindings('globals.css', css)), [
      'colour token `--ink` is missing from `:root[data-theme="dark"]`',
    ]);
  });

  test('a token missing from the system switch is reported', () => {
    const css = withoutLine(FIVE_PLACES, '    --ink: var(--dark-ink);\n');

    assert.deepEqual(messages(colourTokenFindings('globals.css', css)), [
      'colour token `--ink` is missing from the `prefers-color-scheme` block',
    ]);
  });

  test('a token missing from two places names both', () => {
    const css = withoutLine(
      withoutLine(FIVE_PLACES, '  --dark-ink: #e6edf3;\n'),
      '    --ink: var(--dark-ink);\n',
    );

    assert.deepEqual(messages(colourTokenFindings('globals.css', css)), [
      'colour token `--ink` is missing from the `--dark-*` `:root`, the `prefers-color-scheme` block',
    ]);
  });

  test('a brace inside a CSS string is text, not structure', () => {
    const holed = withoutLine(FIVE_PLACES, '  --dark-ink: #e6edf3;\n');
    const rule = 'a::after {\n  content: "{";\n}\n';

    assert.deepEqual(
      colourTokenFindings('globals.css', rule + FIVE_PLACES),
      [],
    );
    assert.deepEqual(
      messages(colourTokenFindings('globals.css', rule + holed)),
      ['colour token `--ink` is missing from the `--dark-*` `:root`'],
    );
  });

  test('a theme wrapped in @layer is still in the same place', () => {
    const holed = withoutLine(FIVE_PLACES, '  --dark-ink: #e6edf3;\n');

    assert.deepEqual(
      colourTokenFindings('globals.css', `@layer base {\n${FIVE_PLACES}}\n`),
      [],
    );
    assert.deepEqual(
      messages(
        colourTokenFindings('globals.css', `@layer base {\n${holed}}\n`),
      ),
      ['colour token `--ink` is missing from the `--dark-*` `:root`'],
    );
  });

  test('a `:root` under a width query is an override, not a definition', () => {
    const css = `${FIVE_PLACES}@media (width >= 64rem) {\n  :root {\n    --text-xs: 11px;\n  }\n}\n`;

    assert.deepEqual(colourTokenFindings('globals.css', css), []);
  });

  test('a last declaration without a semicolon still counts', () => {
    const css = withoutLine(FIVE_PLACES, '  --ink: #1f2328;\n').replace(
      '  --page: #ffffff;\n',
      '  --page: #ffffff;\n  --ink: #1f2328\n',
    );

    assert.deepEqual(colourTokenFindings('globals.css', css), []);
  });

  test('a comment hides its braces and semicolons', () => {
    const holed = withoutLine(FIVE_PLACES, '  --dark-ink: #e6edf3;\n');
    const note = '/* a note with { and ; and :root inside it */\n';

    assert.deepEqual(
      colourTokenFindings('globals.css', note + FIVE_PLACES),
      [],
    );
    assert.deepEqual(
      messages(colourTokenFindings('globals.css', note + holed)),
      ['colour token `--ink` is missing from the `--dark-*` `:root`'],
    );
  });

  test('an escaped quote does not end a CSS string', () => {
    const holed = withoutLine(FIVE_PLACES, '  --dark-ink: #e6edf3;\n');
    const rule = 'a::after {\n  content: "a\\"{b";\n}\n';

    assert.deepEqual(
      messages(colourTokenFindings('globals.css', rule + holed)),
      ['colour token `--ink` is missing from the `--dark-*` `:root`'],
    );
  });

  test('a brace inside an unquoted url is part of the url', () => {
    const holed = withoutLine(FIVE_PLACES, '  --dark-ink: #e6edf3;\n');
    const rule = 'body {\n  background: url(img/a{b.png);\n}\n';

    assert.deepEqual(
      messages(colourTokenFindings('globals.css', rule + holed)),
      ['colour token `--ink` is missing from the `--dark-*` `:root`'],
    );
  });

  test('@supports is transparent too, at any depth', () => {
    const holed = withoutLine(FIVE_PLACES, '  --dark-ink: #e6edf3;\n');
    const wrap = (css: string): string =>
      `@layer base {\n@supports (color: oklch(0 0 0)) {\n${css}}\n}\n`;

    assert.deepEqual(colourTokenFindings('globals.css', wrap(FIVE_PLACES)), []);
    assert.deepEqual(
      messages(colourTokenFindings('globals.css', wrap(holed))),
      ['colour token `--ink` is missing from the `--dark-*` `:root`'],
    );
  });

  test('a scan that loses its place says so instead of going quiet', () => {
    const holed = withoutLine(FIVE_PLACES, '  --dark-ink: #e6edf3;\n');

    assert.deepEqual(
      messages(colourTokenFindings('globals.css', `a {\n${holed}`)),
      ['unreadable: the `a` block is never closed'],
    );
    assert.deepEqual(
      messages(
        colourTokenFindings(
          'globals.css',
          `${holed}b::after {\n  content: "oops;\n}\n`,
        ),
      ),
      ['unreadable: a string or comment is never closed'],
    );
    assert.deepEqual(
      messages(colourTokenFindings('globals.css', `${holed}/* oops\n`)),
      ['unreadable: a string or comment is never closed'],
    );
  });

  test('a token is reported at the line that declares it', () => {
    const holed = withoutLine(FIVE_PLACES, '  --dark-ink: #e6edf3;\n');
    const found = colourTokenFindings('globals.css', holed);

    assert.equal(found.length, 1);
    assert.equal(
      holed.split('\n')[(found[0].line ?? 0) - 1],
      '  --ink: #1f2328;',
    );
  });

  test('a token with no declaration line is reported without one', () => {
    const css = FIVE_PLACES.replace(
      '  --color-page: var(--page);',
      '  --color-brand: var(--brand);\n  --color-page: var(--page);',
    );
    const found = colourTokenFindings('globals.css', css);

    assert.equal(found.length, 1);
    assert.equal(found[0].line, null);
  });
});

describe('version ranges', () => {
  const committed =
    '{\n  "dependencies": { "ai": "^7.0.93", "zod": "4.5.4" },\n  "devDependencies": { "knip": "^6.36.0" }\n}';

  function current(dependencies: string, dev = '"knip": "^6.36.0"'): string {
    return `{\n  "dependencies": { ${dependencies} },\n  "devDependencies": { ${dev} }\n}`;
  }

  test('the committed spelling passes', () => {
    assert.deepEqual(
      versionRangeFindings('package.json', committed, committed),
      [],
    );
  });

  test('a new caret dependency fails', () => {
    const found = versionRangeFindings(
      'package.json',
      committed,
      current('"ai": "^7.0.93", "zod": "4.5.4", "nanoid": "^5.1.0"'),
    );

    assert.deepEqual(messages(found), [
      '`nanoid`: add with an exact version (`bun add --exact`), not `^5.1.0`',
    ]);
  });

  test('widening a committed range is a new range', () => {
    const found = versionRangeFindings(
      'package.json',
      committed,
      current('"ai": "^99.0.0", "zod": "4.5.4"'),
    );

    assert.deepEqual(messages(found), [
      '`ai`: add with an exact version (`bun add --exact`), not `^99.0.0`',
    ]);
  });

  test('tilde, comparison and wildcard ranges are ranges too', () => {
    const found = versionRangeFindings(
      'package.json',
      committed,
      current('"ai": "^7.0.93", "zod": "~4.5.4", "a": ">=1.0.0", "b": "*"'),
    );

    assert.deepEqual(
      found.map((finding) =>
        finding.message.slice(0, finding.message.indexOf(':')),
      ),
      ['`zod`', '`a`', '`b`'],
    );
  });

  test('every dependency section is read', () => {
    const manifest =
      '{\n  "dependencies": { "ai": "^7.0.93" },\n  "devDependencies": { "knip": "^6.36.0", "d": "^1.0.0" },\n  "peerDependencies": { "p": "^2.0.0" },\n  "optionalDependencies": { "o": "^3.0.0" }\n}';

    assert.deepEqual(
      versionRangeFindings('package.json', committed, manifest).map((finding) =>
        finding.message.slice(0, finding.message.indexOf(':')),
      ),
      ['`d`', '`p`', '`o`'],
    );
  });

  test('a malformed manifest names itself', () => {
    assert.throws(
      () => versionRangeFindings('package.json', committed, '{ oops'),
      /^Error: package\.json is not valid JSON:/,
    );
    assert.throws(
      () => versionRangeFindings('package.json', '{ oops', committed),
      /^Error: package\.json at HEAD is not valid JSON:/,
    );
  });

  test('no baseline makes every range new', () => {
    assert.deepEqual(
      versionRangeFindings('package.json', '{}', committed).map((finding) =>
        finding.message.slice(0, finding.message.indexOf(':')),
      ),
      ['`ai`', '`knip`'],
    );
  });

  test('a dependency is reported at the line that declares it', () => {
    const manifest =
      '{\n  "dependencies": {\n    "ai": "^7.0.93",\n    "nanoid": "^5.1.0"\n  }\n}';
    const found = versionRangeFindings('package.json', committed, manifest);

    assert.equal(found.length, 1);
    assert.equal(found[0].line, 4);
  });

  test('moving a dependency between sections is not a new range', () => {
    const found = versionRangeFindings(
      'package.json',
      committed,
      current('"zod": "4.5.4"', '"knip": "^6.36.0", "ai": "^7.0.93"'),
    );

    assert.deepEqual(found, []);
  });

  test('an exact version passes wherever it came from', () => {
    const found = versionRangeFindings(
      'package.json',
      committed,
      current('"ai": "^7.0.93", "zod": "4.5.4", "nanoid": "5.1.0"'),
    );

    assert.deepEqual(found, []);
  });

  test('a name that cannot be located is reported without a line', () => {
    const found = versionRangeFindings(
      'package.json',
      committed,
      current('"ai": "^7.0.93", "zod": "4.5.4", "nanoid": "^5.1.0"'),
    );

    assert.equal(found[0].line, null);
  });
});
