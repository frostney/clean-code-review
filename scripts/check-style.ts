#!/usr/bin/env bun
/**
 * The rules of docs/code-style.md that Biome cannot express: the blank lines
 * around returns and declaration runs, the colour-token invariant in
 * globals.css, colour and type-scale escapes in components, and version ranges
 * that were not already committed.
 *
 *   bun run check:style            # `--all`: every tracked file
 *   bun run check:style --fix      # and insert the blank lines the first two rules want
 *   bun scripts/check-style.ts a.ts b.tsx   # only these, as lefthook passes staged files
 *
 * The scope is always stated: without `--all` the files have to be named, so a
 * hook can never widen into a whole-repository run by accident. Exits 0 when
 * clean and 1 when not.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import ts from 'typescript';

export interface Finding {
  file: string;
  /** Null when the rule knows the file but cannot point at a line in it. */
  line: number | null;
  message: string;
}

/** A blank line to insert, at the offset the line it goes above starts at. */
interface Insertion {
  line: number;
  offset: number;
  message: string;
}

const STYLESHEET = 'src/app/globals.css';
const MANIFEST = 'package.json';

// Colours these three hand to the platform, which never loads our stylesheet.
const PLATFORM_COLOUR_FILES = [
  'src/app/opengraph-image.tsx',
  'src/app/manifest.ts',
  'src/app/layout.tsx',
];

// The pixel face is a bitmap: it renders only at the two sizes it was drawn at.
const PIXEL_TYPE_EXCEPTION = {
  file: 'src/landing/Tutorial.tsx',
  sizes: ['8px', '12px'],
};

// This one file has to write the strings the rules forbid, to prove they fire.
const FIXTURE_FILES = ['scripts/check-style.test.ts'];

const MESSAGES = {
  afterDeclarations: 'blank line missing after the declarations above',
  beforeReturn: 'blank line missing before `return`',
} as const;

/* --- Rules 1 and 2: blank lines, the only two the fixer can write --- */

function lineOf(source: ts.SourceFile, position: number): number {
  return source.getLineAndCharacterOfPosition(position).line;
}

function statementLists(source: ts.SourceFile): ts.NodeArray<ts.Statement>[] {
  const lists: ts.NodeArray<ts.Statement>[] = [source.statements];

  const visit = (node: ts.Node): void => {
    if (
      ts.isBlock(node) ||
      ts.isModuleBlock(node) ||
      ts.isCaseOrDefaultClause(node)
    ) {
      lists.push(node.statements);
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  return lists;
}

function messageFor(
  previous: ts.Statement,
  statement: ts.Statement,
): string | null {
  if (ts.isReturnStatement(statement)) {
    return MESSAGES.beforeReturn;
  }

  if (ts.isVariableStatement(previous) && !ts.isVariableStatement(statement)) {
    return MESSAGES.afterDeclarations;
  }

  return null;
}

/** The blank line goes above a comment written for the statement, not between them. */
function anchorOf(
  source: ts.SourceFile,
  previous: ts.Statement,
  statement: ts.Statement,
): number {
  const previousLine = lineOf(source, previous.getEnd());
  const comments =
    ts.getLeadingCommentRanges(
      source.getFullText(),
      statement.getFullStart(),
    ) ?? [];

  for (const comment of comments) {
    if (lineOf(source, comment.pos) > previousLine) {
      return comment.pos;
    }
  }

  return statement.getStart(source);
}

function insertionsIn(source: ts.SourceFile): Insertion[] {
  const insertions: Insertion[] = [];

  for (const list of statementLists(source)) {
    for (let index = 1; index < list.length; index++) {
      const previous = list[index - 1];
      const statement = list[index];
      const message = messageFor(previous, statement);

      if (message === null) {
        continue;
      }

      const anchorLine = lineOf(source, anchorOf(source, previous, statement));

      // A further line down already reads as separated, and a statement sharing
      // the line above cannot take a blank one without reflowing the code.
      if (anchorLine !== lineOf(source, previous.getEnd()) + 1) {
        continue;
      }

      insertions.push({
        line: anchorLine + 1,
        message,
        offset: source.getPositionOfLineAndCharacter(anchorLine, 0),
      });
    }
  }

  return insertions;
}

/** .tsx parsed as TS silently recovers from every `<`, so the kind is not optional. */
function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

export function blankLineFindings(file: string, text: string): Finding[] {
  return insertionsIn(parse(file, text)).map((insertion) => ({
    file,
    line: insertion.line,
    message: insertion.message,
  }));
}

export function withBlankLines(file: string, text: string): string {
  const insertions = [...insertionsIn(parse(file, text))].sort(
    (a, b) => b.offset - a.offset,
  );
  // A bare "\n" in a CRLF file would leave a line the editor shows as broken.
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  let fixed = text;

  for (const insertion of insertions) {
    fixed = `${fixed.slice(0, insertion.offset)}${newline}${fixed.slice(insertion.offset)}`;
  }

  return fixed;
}

/* --- Rules 4 and 5: colours and type sizes written into class strings --- */

const COLOUR_LITERAL =
  /#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color-mix)\(/i;

const PALETTE_FAMILIES =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
const PALETTE_PROPERTIES =
  'bg|text|border|ring|outline|fill|stroke|from|via|to|decoration|divide|placeholder|caret|accent|shadow';
const PALETTE_UTILITY = new RegExp(
  String.raw`\b(?:${PALETTE_PROPERTIES})-(?:${PALETTE_FAMILIES})-\d{2,3}\b`,
  'g',
);

// Nothing tells a class string from prose, so the rule only asks that a utility
// character follow the colon. A sentence quoting a real utility still trips it;
// that sentence then has to be reworded or the file named an exception.
const DARK_VARIANT = /(?:^|[\s:'"`])dark:[a-z[]/;
const ARBITRARY_TYPE_SIZE = /text-\[([^\]]+)\]/g;
const TYPE_LENGTH = /^-?\d+(?:\.\d+)?(?:px|em|rem|pt|%)$/;

function stringLiteralsIn(source: ts.SourceFile): ts.LiteralLikeNode[] {
  const literals: ts.LiteralLikeNode[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isTemplateLiteralToken(node)) {
      literals.push(node);
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  return literals;
}

function colourFindings(
  source: ts.SourceFile,
  file: string,
  literal: ts.LiteralLikeNode,
): Finding[] {
  const text = literal.text;
  const line = lineOf(source, literal.getStart(source)) + 1;
  const found: Finding[] = [];
  // Only the literal is excused: these files render our utilities as well.
  const literalAllowed = PLATFORM_COLOUR_FILES.includes(file);

  if (COLOUR_LITERAL.test(text) && !literalAllowed) {
    found.push({
      file,
      line,
      message: `colour literal, outside ${STYLESHEET}`,
    });
  }

  for (const match of text.matchAll(PALETTE_UTILITY)) {
    found.push({
      file,
      line,
      message: `Tailwind palette utility \`${match[0]}\``,
    });
  }

  if (DARK_VARIANT.test(text)) {
    found.push({ file, line, message: '`dark:` variant, not a palette token' });
  }

  return found;
}

/** Says what the brackets hold, because only some of them hold a length. */
function typeSizeMessage(utility: string, size: string): string {
  if (TYPE_LENGTH.test(size)) {
    return `type size \`${utility}\` is off the five-step scale`;
  }

  return `arbitrary type size \`${utility}\`: type comes from the five-step scale`;
}

function typeSizeFindings(
  source: ts.SourceFile,
  file: string,
  literal: ts.LiteralLikeNode,
): Finding[] {
  const text = literal.text;
  const line = lineOf(source, literal.getStart(source)) + 1;
  const found: Finding[] = [];

  for (const match of text.matchAll(ARBITRARY_TYPE_SIZE)) {
    const size = match[1];
    const excepted =
      file === PIXEL_TYPE_EXCEPTION.file &&
      PIXEL_TYPE_EXCEPTION.sizes.includes(size);

    if (!excepted) {
      found.push({ file, line, message: typeSizeMessage(match[0], size) });
    }
  }

  return found;
}

export function classStringFindings(file: string, text: string): Finding[] {
  if (FIXTURE_FILES.includes(file)) {
    return [];
  }

  const source = parse(file, text);

  return stringLiteralsIn(source).flatMap((literal) => [
    ...colourFindings(source, file, literal),
    ...typeSizeFindings(source, file, literal),
  ]);
}

/* --- Rule 3: a colour token exists in all five places or in none --- */

interface CssBlock {
  prelude: string;
  declarations: Map<string, string>;
  blocks: CssBlock[];
}

/** A run of text the scanner steps over whole, and whether it was terminated. */
interface Span {
  end: number;
  closed: boolean;
}

/** From the opening quote to just past the closing one. */
function stringSpan(css: string, quote: number): Span {
  for (let index = quote + 1; index < css.length; index++) {
    if (css[index] === '\\') {
      index++;
    } else if (css[index] === css[quote]) {
      return { closed: true, end: index + 1 };
    }
  }

  return { closed: false, end: css.length };
}

function commentSpan(css: string, open: number): Span {
  const close = css.indexOf('*/', open + 2);

  return close < 0
    ? { closed: false, end: css.length }
    : { closed: true, end: close + 2 };
}

const URL_OPEN = 'url(';

/**
 * An unquoted `url(…)` may hold any character but whitespace, quotes and
 * parentheses, braces included, so it is a token and not structure.
 */
function isUnquotedUrl(text: string, index: number): boolean {
  if (text.slice(index, index + URL_OPEN.length).toLowerCase() !== URL_OPEN) {
    return false;
  }

  let at = index + URL_OPEN.length;

  while (at < text.length && text[at].trim() === '') {
    at++;
  }

  return at < text.length && !'"\')'.includes(text[at]);
}

function urlSpan(css: string, open: number): Span {
  const close = css.indexOf(')', open);

  return close < 0
    ? { closed: false, end: css.length }
    : { closed: true, end: close + 1 };
}

/** Comments become blanks, so a brace inside one cannot read as structure. */
function blankComments(css: string): { text: string; closed: boolean } {
  let text = '';
  let closed = true;
  let index = 0;

  while (index < css.length) {
    const char = css[index];

    if (char === '"' || char === "'") {
      const span = stringSpan(css, index);

      text += css.slice(index, span.end);
      index = span.end;
    } else if (css.startsWith('/*', index)) {
      const span = commentSpan(css, index);

      closed = closed && span.closed;
      text += css.slice(index, span.end).replace(/[^\n]/g, ' ');
      index = span.end;
    } else {
      text += char;
      index++;
    }
  }

  return { closed, text };
}

function addDeclaration(block: CssBlock | undefined, source: string): void {
  const colon = source.indexOf(':');

  if (!block || colon < 0) {
    return;
  }

  block.declarations.set(
    source.slice(0, colon).trim(),
    source.slice(colon + 1).trim(),
  );
}

function punctuate(
  char: string,
  pending: string,
  stack: CssBlock[],
  roots: CssBlock[],
): void {
  if (char === '{') {
    const block = {
      blocks: [],
      declarations: new Map<string, string>(),
      prelude: pending.trim(),
    };

    (stack.at(-1)?.blocks ?? roots).push(block);
    stack.push(block);

    return;
  }

  // A block's last declaration may end at the brace rather than a semicolon.
  addDeclaration(stack.at(-1), pending);

  if (char === '}') {
    stack.pop();
  }
}

/** A scan that did not end where it should have; the blocks cannot be trusted. */
function unbalanced(stack: CssBlock[], closed: boolean): string | null {
  if (!closed) {
    return 'a string or comment is never closed';
  }

  const open = stack[0];

  if (open) {
    return `the \`${open.prelude}\` block is never closed`;
  }

  return null;
}

interface Stylesheet {
  blocks: CssBlock[];
  /** What stopped the scan making sense of the file, or null when it did. */
  problem: string | null;
}

/**
 * Enough of CSS to find blocks and declarations. Strings, comments and unquoted
 * urls keep their braces and semicolons to themselves; anything that still ends
 * the file mid-structure is reported rather than parsed into silence.
 */
function cssBlocks(css: string): Stylesheet {
  const { text, closed: commentsClosed } = blankComments(css);
  const roots: CssBlock[] = [];
  const stack: CssBlock[] = [];
  let closed = commentsClosed;
  let start = 0;
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    const span = spanAt(text, index);

    if (span) {
      closed = closed && span.closed;
      index = span.end;
    } else if (char === '{' || char === '}' || char === ';') {
      punctuate(char, text.slice(start, index), stack, roots);
      index++;
      start = index;
    } else {
      index++;
    }
  }

  return { blocks: roots, problem: unbalanced(stack, closed) };
}

/** The token starting here that the scanner steps over whole, if any. */
function spanAt(text: string, index: number): Span | null {
  const char = text[index];

  if (char === '"' || char === "'") {
    return stringSpan(text, index);
  }

  if (isUnquotedUrl(text, index)) {
    return urlSpan(text, index);
  }

  return null;
}

function everyDeclaration(blocks: CssBlock[]): Map<string, string> {
  const all = new Map<string, string>();

  for (const block of blocks) {
    for (const [name, value] of [
      ...block.declarations,
      ...everyDeclaration(block.blocks),
    ]) {
      all.set(name, value);
    }
  }

  return all;
}

function customProperties(blocks: CssBlock[], prefix: string): Set<string> {
  const names = new Set<string>();

  for (const name of everyDeclaration(blocks).keys()) {
    if (name.startsWith(prefix)) {
      names.add(name.slice(prefix.length));
    }
  }

  return names;
}

/** `--color-page: var(--page)` names the token in its value, not in its own name. */
function mappedTokens(blocks: CssBlock[]): Set<string> {
  const names = new Set<string>();

  for (const value of everyDeclaration(blocks).values()) {
    const mapped = /^var\(--([\w-]+)\)$/.exec(value);

    if (mapped) {
      names.add(mapped[1]);
    }
  }

  return names;
}

// `@layer` and `@supports` wrap rules without changing which elements they
// match, so a theme moved inside one is still in the same place. `@media` is
// not transparent: the `:root` under a width query is an override, not a
// definition, and reading it as one would report every token it does not hold.
// The residual is that a token defined only inside a media query is in none of
// the five places, so it is never reported at all. Define tokens outside one.
const TRANSPARENT_WRAPPER = /^@(?:layer|supports)\b/;

function reachable(blocks: CssBlock[]): CssBlock[] {
  return blocks.flatMap((block) =>
    TRANSPARENT_WRAPPER.test(block.prelude)
      ? [block, ...reachable(block.blocks)]
      : [block],
  );
}

function select(
  blocks: CssBlock[],
  matches: (prelude: string) => boolean,
): CssBlock[] {
  return blocks.filter((block) => matches(block.prelude));
}

/** The five places a colour token has to exist in, read out of the real structure. */
function colourPlaces(
  roots: CssBlock[],
): { label: string; tokens: Set<string> }[] {
  const blocks = reachable(roots);
  const plainRoot = select(blocks, (prelude) => prelude === ':root');
  const systemDark = select(blocks, (prelude) =>
    prelude.includes('prefers-color-scheme: dark'),
  );

  return [
    {
      label: '`@theme inline`',
      tokens: mappedTokens(
        select(blocks, (prelude) => prelude === '@theme inline'),
      ),
    },
    { label: 'the light `:root`', tokens: lightTokens(plainRoot) },
    {
      label: 'the `--dark-*` `:root`',
      tokens: customProperties(plainRoot, '--dark-'),
    },
    {
      label: '`:root[data-theme="dark"]`',
      tokens: customProperties(
        select(blocks, (prelude) => prelude === ':root[data-theme="dark"]'),
        '--',
      ),
    },
    {
      label: 'the `prefers-color-scheme` block',
      tokens: customProperties(systemDark, '--'),
    },
  ];
}

/**
 * Every custom property on a top-level `:root` is a colour today: the type scale
 * is in `@theme`, and the per-breakpoint and per-navigation variables sit inside
 * the media queries that need them. A non-colour variable added here would be
 * read as a token and reported against the four dark places, so it belongs in
 * `@theme` or under its own rule instead.
 */
function lightTokens(plainRoot: CssBlock[]): Set<string> {
  const light = new Set<string>();

  for (const name of customProperties(plainRoot, '--')) {
    if (!name.startsWith('dark-')) {
      light.add(name);
    }
  }

  return light;
}

function lineOfToken(css: string, token: string): number | null {
  const at = css.split('\n').findIndex((line) => line.includes(`--${token}:`));

  return at < 0 ? null : at + 1;
}

export function colourTokenFindings(file: string, css: string): Finding[] {
  const sheet = cssBlocks(css);

  // Silence from a scan that lost its place would read as a clean stylesheet.
  if (sheet.problem !== null) {
    return [{ file, line: null, message: `unreadable: ${sheet.problem}` }];
  }

  const places = colourPlaces(sheet.blocks);
  const every = new Set(places.flatMap((place) => [...place.tokens]));

  return [...every].flatMap((token) => {
    const missing = places.filter((place) => !place.tokens.has(token));

    if (missing.length === 0) {
      return [];
    }

    return [
      {
        file,
        line: lineOfToken(css, token),
        message: `colour token \`--${token}\` is missing from ${missing.map((place) => place.label).join(', ')}`,
      },
    ];
  });
}

/* --- Rule 6: a version range passes only if it is the one already committed --- */

const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

/** An exact version. Everything else is a range, however it is spelled. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/;

/**
 * Keyed by name across every section, so moving a dependency from `dependencies`
 * to `devDependencies` is not read as introducing it.
 */
function ranges(label: string, manifest: string): Map<string, string> {
  const parsed = parseManifest(label, manifest);
  const all = new Map<string, string>();

  for (const section of DEPENDENCY_SECTIONS) {
    for (const [name, range] of Object.entries(parsed[section] ?? {})) {
      all.set(name, range);
    }
  }

  return all;
}

function parseManifest(
  label: string,
  manifest: string,
): Record<string, Record<string, string> | undefined> {
  try {
    return JSON.parse(manifest) as Record<
      string,
      Record<string, string> | undefined
    >;
  } catch (cause) {
    const why = cause instanceof Error ? cause.message : String(cause);

    throw new Error(`${label} is not valid JSON: ${why}`);
  }
}

export function versionRangeFindings(
  file: string,
  committed: string,
  current: string,
): Finding[] {
  const before = ranges(`${file} at HEAD`, committed);

  return [...ranges(file, current)].flatMap(([name, range]) => {
    // Only the committed spelling is grandfathered: widening an old range is a
    // new range, and so is a `~`, a `>=` or a `*`.
    if (EXACT_VERSION.test(range) || before.get(name) === range) {
      return [];
    }

    return [
      {
        file,
        line: lineOfDependency(current, name),
        message: `\`${name}\`: add with an exact version (\`bun add --exact\`), not \`${range}\``,
      },
    ];
  });
}

function lineOfDependency(manifest: string, name: string): number | null {
  const at = manifest
    .split('\n')
    .findIndex((line) => line.trimStart().startsWith(`"${name}":`));

  return at < 0 ? null : at + 1;
}

/* --- Running --- */

/**
 * Loud on failure: a swallowed error here would compare package.json with
 * itself and turn rule 6 off without saying so.
 */
function git(root: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (cause) {
    const stderr =
      cause instanceof Error && 'stderr' in cause ? String(cause.stderr) : '';
    const detail = stderr.trim();
    const suffix = detail.length > 0 ? `: ${detail}` : '';

    throw new Error(`\`git ${args.join(' ')}\` failed${suffix}`);
  }
}

function repoRoot(): string {
  return git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
}

function trackedFiles(root: string): string[] {
  return git(root, ['ls-files', '--cached', '--others', '--exclude-standard'])
    .split('\n')
    .filter((file) => file.length > 0);
}

function isSource(file: string): boolean {
  return file.endsWith('.ts') || file.endsWith('.tsx');
}

async function checkSource(
  root: string,
  file: string,
  fix: boolean,
): Promise<{ found: Finding[]; rewrote: boolean }> {
  const path = `${root}/${file}`;
  const text = await readFile(path, 'utf8');

  if (!fix) {
    return {
      found: [
        ...blankLineFindings(file, text),
        ...classStringFindings(file, text),
      ],
      rewrote: false,
    };
  }

  const fixed = withBlankLines(file, text);

  if (fixed !== text) {
    await writeFile(path, fixed);
  }

  return { found: classStringFindings(file, fixed), rewrote: fixed !== text };
}

async function checkWholeFiles(
  root: string,
  files: string[],
): Promise<Finding[]> {
  const found: Finding[] = [];

  if (files.includes(STYLESHEET)) {
    found.push(
      ...colourTokenFindings(
        STYLESHEET,
        await readFile(`${root}/${STYLESHEET}`, 'utf8'),
      ),
    );
  }

  if (files.includes(MANIFEST)) {
    const current = await readFile(`${root}/${MANIFEST}`, 'utf8');

    found.push(...versionRangeFindings(MANIFEST, baseline(root), current));
  }

  return found;
}

/**
 * The committed manifest, or an empty one when there is no commit to read it
 * from: then every range is new, which is the right answer for a first commit.
 */
function baseline(root: string): string {
  try {
    return git(root, ['show', `HEAD:${MANIFEST}`]);
  } catch (cause) {
    const why = cause instanceof Error ? cause.message : String(cause);

    console.log(`no committed ${MANIFEST} to compare against (${why})`);

    return '{}';
  }
}

function requested(root: string, args: string[]): string[] {
  const named = args
    .filter((arg) => !arg.startsWith('--'))
    .map((arg) => relative(root, resolve(process.cwd(), arg)));

  if (!args.includes('--all') && named.length === 0) {
    throw new Error(
      'name the files to check, or pass --all for the whole repository',
    );
  }

  const files = args.includes('--all') ? trackedFiles(root) : named;

  // A deletion is staged before the file leaves the index, so both the staged
  // set and `ls-files` can name a path that is no longer on disk.
  return files.filter((file) => existsSync(`${root}/${file}`));
}

function report(found: Finding[], rewritten: string[]): void {
  const ordered = [...found].sort(
    (a, b) => a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0),
  );

  for (const finding of ordered) {
    const where =
      finding.line === null ? finding.file : `${finding.file}:${finding.line}`;

    console.log(`${where}  ${finding.message}`);
  }

  for (const file of rewritten) {
    console.log(`${file}  rewritten`);
  }

  if (found.length > 0) {
    console.log(`${found.length} style finding(s)`);
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const fix = args.includes('--fix');
  const root = repoRoot();
  const files = requested(root, args);
  const found = await checkWholeFiles(root, files);
  const rewritten: string[] = [];

  for (const file of files.filter(isSource)) {
    const result = await checkSource(root, file, fix);

    found.push(...result.found);

    if (result.rewrote) {
      rewritten.push(file);
    }
  }

  report(found, rewritten);

  return found.length === 0 ? 0 : 1;
}

async function run(): Promise<number> {
  try {
    return await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));

    return 1;
  }
}

if (import.meta.main) {
  process.exit(await run());
}
