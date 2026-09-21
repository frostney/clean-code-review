/**
 * Where a file's comments are, per language. Used by the second judging pass,
 * which asks the code questions of the file with its comments removed.
 *
 * Hand-written scanners rather than a parser: `typescript` is a dev dependency
 * and 9.1 MB in the function bundle, and six of the seven languages here would
 * need their own parser anyway. `scan.test.ts` checks these ranges against the
 * TypeScript scanner's over every `.ts` and `.tsx` file in the repository.
 *
 * A comment is never recognised inside a string, template literal, regex, JSX
 * text or a CSS `url()`, because those are scanned and skipped whole.
 */

export interface CommentRange {
  start: number;
  /** Exclusive. */
  end: number;
}

type Family = 'c' | 'csharp' | 'css' | 'go' | 'java' | 'js' | 'python' | 'rust';

const FAMILY_BY_EXTENSION: Readonly<Record<string, Family>> = {
  c: 'c',
  cc: 'c',
  cjs: 'js',
  cpp: 'c',
  cs: 'csharp',
  css: 'css',
  cts: 'js',
  cxx: 'c',
  go: 'go',
  h: 'c',
  hh: 'c',
  hpp: 'c',
  hxx: 'c',
  java: 'java',
  js: 'js',
  jsx: 'js',
  less: 'css',
  m: 'c',
  mjs: 'js',
  mm: 'c',
  mts: 'js',
  py: 'python',
  pyi: 'python',
  rs: 'rust',
  sass: 'css',
  scss: 'css',
  ts: 'js',
  tsx: 'js',
};

/**
 * `<` opens an element only where the file cannot also mean a type argument or
 * a cast, so `.ts` is scanned without JSX even though `.tsx` is not.
 */
const JSX_EXTENSIONS = new Set(['cjs', 'js', 'jsx', 'mjs', 'tsx']);

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** Null for a language with no scanner here, which gets no second pass. */
export function familyOf(path: string): Family | null {
  return FAMILY_BY_EXTENSION[extensionOf(path)] ?? null;
}

const NOT_FOUND = -1;

function endOfLine(text: string, from: number): number {
  const nl = text.indexOf('\n', from);
  return nl === NOT_FOUND ? text.length : nl;
}

/** The index after the closing delimiter, or the end of the text. */
function closeOf(text: string, from: number, close: string): number {
  const at = text.indexOf(close, from);
  return at === NOT_FOUND ? text.length : at + close.length;
}

function nestedBlockEnd(
  text: string,
  from: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  let i = from;
  while (i < text.length) {
    if (text.startsWith(open, i)) {
      depth++;
      i += open.length;
    } else if (text.startsWith(close, i)) {
      depth--;
      i += close.length;
      if (depth === 0) {
        return i;
      }
    } else {
      i++;
    }
  }
  return text.length;
}

interface StringSpec {
  open: string;
  close: string;
  /** A backslash escapes the next character. Raw strings set this false. */
  escape: boolean;
  /** A doubled closing delimiter stands for one (C# verbatim strings). */
  doubled?: boolean;
}

/** The index after the string, or the end of the text for an unterminated one. */
function stringEnd(text: string, from: number, spec: StringSpec): number {
  let i = from + spec.open.length;
  while (i < text.length) {
    if (spec.escape && text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text.startsWith(spec.close, i)) {
      const after = i + spec.close.length;
      if (spec.doubled && text.startsWith(spec.close, after)) {
        i = after + spec.close.length;
        continue;
      }
      return after;
    }
    i++;
  }
  return text.length;
}

// ---------------------------------------------------------------------------
// The C-like languages, CSS and Python: no construct here needs to know what
// came before it, so one loop over delimiters is enough.

interface Syntax {
  line: readonly string[];
  block: readonly (readonly [string, string])[];
  /** Rust and Swift nest block comments; C does not. */
  nestedBlock: boolean;
  strings: readonly StringSpec[];
  /** `'a` is a lifetime, `'a'` a character literal. */
  rustQuote?: boolean;
  /** `r"…"`, `r#"…"#`. */
  rustRaw?: boolean;
  /** `R"delim(…)delim"`. */
  cppRaw?: boolean;
  /** `@"…"`. */
  verbatim?: boolean;
  /** An unquoted `url(…)` may hold a `//`. */
  cssUrl?: boolean;
  /** `f"…{expr}…"`, whose expression may hold the string's own quote. */
  formatStrings?: boolean;
}

const SLASH_COMMENTS = {
  block: [['/*', '*/']] as const,
  line: ['//'] as const,
  nestedBlock: false,
};

const QUOTED: readonly StringSpec[] = [
  { close: '"', escape: true, open: '"' },
  { close: "'", escape: true, open: "'" },
];

const SYNTAX: Readonly<Record<Exclude<Family, 'js'>, Syntax>> = {
  c: { ...SLASH_COMMENTS, cppRaw: true, strings: QUOTED },
  csharp: { ...SLASH_COMMENTS, strings: QUOTED, verbatim: true },
  css: {
    block: [['/*', '*/']],
    cssUrl: true,
    // Plain CSS has no line comment; SCSS, Sass and Less do, and reading one
    // in a `.css` file would only ever remove a line that cannot be there.
    line: ['//'],
    nestedBlock: false,
    strings: QUOTED,
  },
  go: {
    ...SLASH_COMMENTS,
    strings: [...QUOTED, { close: '`', escape: false, open: '`' }],
  },
  java: {
    ...SLASH_COMMENTS,
    strings: [{ close: '"""', escape: true, open: '"""' }, ...QUOTED],
  },
  python: {
    block: [],
    formatStrings: true,
    line: ['#'],
    nestedBlock: false,
    strings: [
      { close: '"""', escape: true, open: '"""' },
      { close: "'''", escape: true, open: "'''" },
      ...QUOTED,
    ],
  },
  rust: {
    block: [['/*', '*/']],
    line: ['//'],
    nestedBlock: true,
    rustQuote: true,
    rustRaw: true,
    strings: [{ close: '"', escape: true, open: '"' }],
  },
};

const MAX_RAW_PREFIX_CHARS = 24;

const CSS_URL = /^url\(/i;

const CSS_URL_CHARS = 4;

const RUST_CHAR = /^'(?:\\.|[^\\'])'/;
const RUST_RAW = /^r(#*)"/;
const CPP_RAW = /^R"([^\s()\\]{0,16})\(/;

/** The index after a literal that needs more than a delimiter to recognise, else null. */
function specialLiteralEnd(
  text: string,
  i: number,
  syntax: Syntax,
): number | null {
  const rest = text.slice(i, i + MAX_RAW_PREFIX_CHARS);
  if (syntax.rustRaw) {
    const raw = RUST_RAW.exec(rest);
    if (raw) {
      return closeOf(text, i + raw[0].length, `"${raw[1]}`);
    }
  }
  if (syntax.cppRaw) {
    const raw = CPP_RAW.exec(rest);
    if (raw) {
      return closeOf(text, i + raw[0].length, `)${raw[1]}"`);
    }
  }
  if (syntax.verbatim && text.startsWith('@"', i)) {
    return stringEnd(text, i + 1, {
      close: '"',
      doubled: true,
      escape: false,
      open: '"',
    });
  }
  if (syntax.rustQuote && text[i] === "'") {
    const char = RUST_CHAR.exec(rest);
    return i + (char ? char[0].length : 1);
  }
  return null;
}

function blockCommentEnd(
  text: string,
  i: number,
  syntax: Syntax,
): number | null {
  const pair = syntax.block.find(([open]) => text.startsWith(open, i));
  if (!pair) {
    return null;
  }
  const [open, close] = pair;
  return syntax.nestedBlock
    ? nestedBlockEnd(text, i, open, close)
    : closeOf(text, i + open.length, close);
}

const PREFIX_CHARS = /[A-Za-z_]/;

/** True when the quote at `i` is preceded by an `f` string prefix. */
function isFormatString(text: string, i: number): boolean {
  let at = i;
  while (at > 0 && PREFIX_CHARS.test(text[at - 1])) {
    at--;
  }
  return /f/i.test(text.slice(at, i));
}

/**
 * PEP 701 lets an f-string's expression reuse the string's own quote
 * (`f"{d["k"]}"`), which cannot be told from the end of the string without
 * parsing the expression. UNSAFE means: judge this file on one pass rather
 * than risk cutting code out of it.
 */
const UNSAFE = -1;

/** A doubled brace is a literal brace, not the start or end of an expression. */
function braceStep(text: string, i: number): number {
  const ch = text[i];
  if (ch !== '{' && ch !== '}') {
    return 0;
  }
  if (text[i + 1] === ch) {
    return 0;
  }
  return ch === '{' ? 1 : -1;
}

function formatStringEnd(text: string, from: number, spec: StringSpec): number {
  let i = from + spec.open.length;
  let depth = 0;
  while (i < text.length) {
    if (text[i] === '\\' && spec.escape) {
      i += 2;
      continue;
    }
    const brace = braceStep(text, i);
    if (brace === 0 && text.startsWith(spec.close, i)) {
      return depth === 0 ? i + spec.close.length : UNSAFE;
    }
    depth = Math.max(0, depth + brace);
    i += brace === 0 && (text[i] === '{' || text[i] === '}') ? 2 : 1;
  }
  return text.length;
}

/** UNSAFE when the text holds a construct this scanner will not guess at. */
function scanSyntax(text: string, syntax: Syntax): CommentRange[] | null {
  const out: CommentRange[] = [];
  let i = 0;
  while (i < text.length) {
    if (syntax.cssUrl && CSS_URL.test(text.slice(i, i + CSS_URL_CHARS))) {
      i = closeOf(text, i, ')');
      continue;
    }
    const block = blockCommentEnd(text, i, syntax);
    if (block !== null) {
      out.push({ end: block, start: i });
      i = block;
      continue;
    }
    if (syntax.line.some((open) => text.startsWith(open, i))) {
      const end = endOfLine(text, i);
      out.push({ end, start: i });
      i = end;
      continue;
    }
    const next = literalEnd(text, i, syntax);
    if (next === UNSAFE) {
      return null;
    }
    i = next !== null && next > i ? next : i + 1;
  }
  return out;
}

function literalEnd(text: string, i: number, syntax: Syntax): number | null {
  const special = specialLiteralEnd(text, i, syntax);
  if (special !== null) {
    return special;
  }
  const spec = syntax.strings.find((s) => text.startsWith(s.open, i));
  if (spec === undefined) {
    return null;
  }
  return syntax.formatStrings && isFormatString(text, i)
    ? formatStringEnd(text, i, spec)
    : stringEnd(text, i, spec);
}

// ---------------------------------------------------------------------------
// JavaScript, TypeScript and JSX. `/` opens a regex or divides, and `<` opens
// an element or compares, and only the preceding token tells them apart, so
// this scanner carries that token and a stack of the contexts it has entered.

/** After these words a `/` opens a regex and a `<` opens an element. */
const VALUE_KEYWORDS = new Set([
  'await',
  'case',
  'default',
  'delete',
  'do',
  'else',
  'extends',
  'in',
  'instanceof',
  'new',
  'of',
  'return',
  'throw',
  'typeof',
  'void',
  'yield',
]);

/** `value` is anything a `/` would divide: a name, a literal, `)` or `]`. */
type Previous =
  | { kind: 'start' }
  | { kind: 'value' }
  | { kind: 'punctuation' }
  | { kind: 'word'; text: string };

const VALUE: Previous = { kind: 'value' };
const PUNCTUATION: Previous = { kind: 'punctuation' };

function startsValue(previous: Previous): boolean {
  return previous.kind === 'word'
    ? VALUE_KEYWORDS.has(previous.text)
    : previous.kind !== 'value';
}

interface CodeFrame {
  kind: 'code';
  /** Open braces within this frame; the frame ends at the brace past them. */
  depth: number;
  /** The `{` of the JSX expression container this frame is, else null. */
  container: number | null;
  /** How many ranges had been found when this frame opened. */
  found: number;
}

type Frame =
  | CodeFrame
  | { kind: 'template' }
  | { kind: 'tag' }
  | { kind: 'children' };

interface Scan {
  text: string;
  jsx: boolean;
  out: CommentRange[];
  stack: Frame[];
  i: number;
  previous: Previous;
}

const IDENTIFIER_START = /[A-Za-z_$]/;
const IDENTIFIER_PART = /[\w$]/;
const DIGIT = /\d/;

function runEnd(text: string, from: number, part: RegExp): number {
  let i = from;
  while (i < text.length && part.test(text[i])) {
    i++;
  }
  return i;
}

/** The index after the regex literal, or null when the `/` is a division. */
function regexEnd(text: string, from: number): number | null {
  let i = from + 1;
  let inClass = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '\n') {
      return null;
    }
    if (ch === '[') {
      inClass = true;
    } else if (ch === ']') {
      inClass = false;
    } else if (ch === '/' && !inClass) {
      return runEnd(text, i + 1, IDENTIFIER_PART);
    }
    i++;
  }
  return null;
}

function slash(s: Scan): void {
  const { text, i } = s;
  if (text.startsWith('//', i)) {
    const end = endOfLine(text, i);
    s.out.push({ end, start: i });
    s.i = end;
    return;
  }
  if (text.startsWith('/*', i)) {
    const end = closeOf(text, i + 2, '*/');
    s.out.push({ end, start: i });
    s.i = end;
    return;
  }
  const regex = startsValue(s.previous) ? regexEnd(text, i) : null;
  if (regex === null) {
    s.i = i + 1;
    s.previous = PUNCTUATION;
    return;
  }
  s.i = regex;
  s.previous = VALUE;
}

/** A JSX expression container holding nothing but comments goes as a whole. */
function closeContainer(s: Scan, frame: CodeFrame): void {
  if (frame.container === null) {
    return;
  }
  let rest = '';
  let at = frame.container + 1;
  for (const range of s.out.slice(frame.found)) {
    rest += s.text.slice(at, range.start);
    at = Math.max(at, range.end);
  }
  rest += s.text.slice(at, s.i);
  if (rest.trim() === '') {
    s.out.push({ end: s.i + 1, start: frame.container });
  }
}

function closeBrace(s: Scan, frame: CodeFrame): void {
  if (frame.depth > 0) {
    frame.depth--;
  } else if (s.stack.length > 1) {
    closeContainer(s, frame);
    s.stack.pop();
  }
  s.i++;
  s.previous = PUNCTUATION;
}

function pushCode(s: Scan, container: number | null): void {
  s.stack.push({ container, depth: 0, found: s.out.length, kind: 'code' });
}

function opensElement(s: Scan): boolean {
  return (
    s.jsx &&
    startsValue(s.previous) &&
    (s.text[s.i + 1] === '>' || IDENTIFIER_START.test(s.text[s.i + 1] ?? ''))
  );
}

function stepCode(s: Scan, frame: CodeFrame): void {
  const { text, i } = s;
  const ch = text[i];
  if (ch === '/') {
    slash(s);
    return;
  }
  if (ch === '"' || ch === "'") {
    s.i = stringEnd(text, i, { close: ch, escape: true, open: ch });
    s.previous = VALUE;
    return;
  }
  if (ch === '`') {
    s.stack.push({ kind: 'template' });
    s.i = i + 1;
    return;
  }
  if (ch === '}') {
    closeBrace(s, frame);
    return;
  }
  if (ch === '<' && opensElement(s)) {
    s.stack.push({ kind: 'tag' });
    s.i = i + 1;
    return;
  }
  stepPlainCode(s, frame);
}

function stepPlainCode(s: Scan, frame: CodeFrame): void {
  const { text, i } = s;
  const ch = text[i];
  if (ch === '{') {
    frame.depth++;
  }
  if (IDENTIFIER_START.test(ch)) {
    const end = runEnd(text, i, IDENTIFIER_PART);
    s.previous = { kind: 'word', text: text.slice(i, end) };
    s.i = end;
    return;
  }
  if (DIGIT.test(ch)) {
    s.i = runEnd(text, i, /[\w.]/);
    s.previous = VALUE;
    return;
  }
  if (ch === ')' || ch === ']') {
    s.previous = VALUE;
  } else if ((ch === '+' || ch === '-') && text[i + 1] === ch) {
    s.previous = VALUE;
    s.i = i + 2;
    return;
  } else if (!/\s/.test(ch)) {
    s.previous = PUNCTUATION;
  }
  s.i = i + 1;
}

/** Anything else in a tag means the `<` was a comparison or a type argument. */
const TAG_CHARS = /[\w$.:=\-\s]/;

function stepTag(s: Scan): void {
  const { text, i } = s;
  const ch = text[i];
  if (ch === '>') {
    s.stack.pop();
    s.stack.push({ kind: 'children' });
    s.i = i + 1;
    return;
  }
  if (ch === '/' && text[i + 1] === '>') {
    s.stack.pop();
    s.i = i + 2;
    s.previous = VALUE;
    return;
  }
  if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
    // A comment between attributes.
    slash(s);
    return;
  }
  if (ch === '"' || ch === "'") {
    s.i = stringEnd(text, i, { close: ch, escape: true, open: ch });
    return;
  }
  if (ch === '{') {
    pushCode(s, null);
    s.i = i + 1;
    return;
  }
  if (!TAG_CHARS.test(ch)) {
    s.stack.pop();
    s.previous = PUNCTUATION;
    return;
  }
  s.i = i + 1;
}

function stepChildren(s: Scan): void {
  const { text, i } = s;
  if (text[i] === '{') {
    pushCode(s, i);
    s.i = i + 1;
    return;
  }
  if (text[i] !== '<') {
    s.i = i + 1;
    return;
  }
  if (text[i + 1] === '/') {
    s.stack.pop();
    s.i = closeOf(text, i, '>');
    s.previous = VALUE;
    return;
  }
  s.stack.push({ kind: 'tag' });
  s.i = i + 1;
}

function stepTemplate(s: Scan): void {
  const { text, i } = s;
  if (text[i] === '\\') {
    s.i = i + 2;
    return;
  }
  if (text[i] === '`') {
    s.stack.pop();
    s.i = i + 1;
    s.previous = VALUE;
    return;
  }
  if (text[i] === '$' && text[i + 1] === '{') {
    pushCode(s, null);
    s.i = i + 2;
    return;
  }
  s.i = i + 1;
}

function scanJs(text: string, jsx: boolean): CommentRange[] {
  const s: Scan = {
    i: 0,
    jsx,
    out: [],
    previous: { kind: 'start' },
    stack: [{ container: null, depth: 0, found: 0, kind: 'code' }],
    text,
  };
  while (s.i < text.length) {
    const before = s.i;
    const frames = s.stack.length;
    const frame = s.stack.at(-1) as Frame;
    if (frame.kind === 'code') {
      stepCode(s, frame);
    } else if (frame.kind === 'template') {
      stepTemplate(s);
    } else if (frame.kind === 'tag') {
      stepTag(s);
    } else {
      stepChildren(s);
    }
    if (s.i <= before && s.stack.length === frames) {
      // No step may stand still unless it changed context: abandoning a tag
      // re-reads its `<` as code, but a bad guess must not hang the scan.
      s.i = before + 1;
    }
  }
  return s.out;
}

/**
 * Ranges in source order. Null for a language with no scanner here, or for a
 * file holding a construct the scanner will not guess at.
 */
export function commentRanges(
  text: string,
  path: string,
): CommentRange[] | null {
  const family = familyOf(path);
  if (family === null) {
    return null;
  }
  const ranges =
    family === 'js'
      ? scanJs(text, JSX_EXTENSIONS.has(extensionOf(path)))
      : scanSyntax(text, SYNTAX[family]);
  // A JSX container is found after the comments inside it.
  return ranges?.sort((a, b) => a.start - b.start) ?? null;
}
