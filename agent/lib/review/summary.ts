/**
 * Luna writes plain text rather than structured output so the page can
 * stream it; `parseSummaryText` tolerates partial text:
 *
 *   Decision: request_changes
 *   ## Overall
 *   <three to five sentences>
 *   ## src/path/one.ts
 *   <one or two sentences>
 *   …
 *
 * HTML-comment lines are signals only the adapter may write. File parts have
 * read untrusted code, so `withoutSignalLines` strips signal-shaped model
 * lines, `onlyOwnSections` strips sections a part was not asked for, and the
 * parser accepts the decision, overall text and rewrites only before the
 * first file section.
 */

/**
 * Discards the overall part's earlier text before its retry. File parts need
 * no equivalent: a repeated file section replaces the earlier one.
 */
export const OVERALL_REWRITE_LINE = '<!-- overall written again -->';

export const OVERALL_SECTION = 'overall';

const CUT_OFF = /^<!-- cut off: (.+) -->$/;

const SIGNAL_START = '<!--';

/**
 * A line is held only while it could still become a signal. `\r` ends a line
 * too, because the parser treats it as one.
 */
export function withoutSignalLines(push: (delta: string) => void): {
  write(delta: string): void;
  end(): void;
} {
  let held = '';
  let plain = false;
  const settleHeld = () => {
    const head = held.trimStart();
    if (
      head.length > 0 &&
      !SIGNAL_START.startsWith(head) &&
      !head.startsWith(SIGNAL_START)
    ) {
      push(held);
      held = '';
      plain = true;
    }
  };
  const endLine = () => {
    // A line still held here is a comment line or blank.
    if (!held.trimStart().startsWith(SIGNAL_START)) {
      push(held);
    }
    held = '';
    plain = false;
  };
  return {
    end: endLine,
    write(delta) {
      for (const piece of delta.split(/(\r\n|\r|\n)/)) {
        if (piece === '\n' || piece === '\r' || piece === '\r\n') {
          endLine();
          push(piece);
        } else if (plain) {
          push(piece);
        } else if (piece) {
          held += piece;
          settleHeld();
        }
      }
    },
  };
}

/** `section` is a path or `OVERALL_SECTION`. */
export function cutOffLine(section: string): string {
  return `<!-- cut off: ${section} -->`;
}

export const REVIEW_BATCH_SIZE = 6;

type ReviewPartRole = 'files' | 'overall';

export interface ReviewPart {
  role: ReviewPartRole;
  index: number;
  /** Every path for the overall part. */
  paths: string[];
}

export const REVIEWER_MODEL = 'openai/gpt-5.6-luna-fast';

type Decision = 'approve' | 'comment' | 'request_changes';

export interface Summary {
  overall: string;
  decision: Decision;
  files: { path: string; summary: string; incomplete?: true }[];
  overallIncomplete?: true;
  partial?: boolean;
  /**
   * The open section: a path, `OVERALL_SECTION`, or null. Not always the
   * last in `files`, because a retried part repeats sections that keep their
   * first place.
   */
  writing: string | null;
}

const DECISIONS: readonly Decision[] = [
  'approve',
  'comment',
  'request_changes',
];

interface SummaryParse {
  /** Aliases `overall` while the overall section is open. */
  current: string[] | null;
  currentPath: string | null;
  decision: Decision;
  files: { path: string; summary: string; incomplete?: true }[];
  incomplete: Set<string>;
  overall: string[];
  overallIncomplete: boolean;
  /** Once true, nothing may set the decision or touch the overall text. */
  filesStarted: boolean;
}

/** Null when the line is not a decision line at all. */
function readDecisionLine(line: string): Decision | 'unrecognised' | null {
  const match = /^\s*\**decision\**\s*[:：]\s*\**\s*([a-z_ ]+)/i.exec(line);
  if (!match) {
    return null;
  }
  const named = match[1].trim().toLowerCase().replace(/\s+/g, '_') as Decision;
  return DECISIONS.includes(named) ? named : 'unrecognised';
}

function readHeading(line: string): string | null {
  const heading = /^\s*#{1,6}\s+(.+?)\s*$/.exec(line);
  // Models decorate headings: `path`, **path**, _path_.
  return heading ? heading[1].replace(/^[`*_\s]+|[`*_\s]+$/g, '').trim() : null;
}

/** Shared by the live stream (`onlyOwnSections`) and the cache (`partText`) so they never disagree. */
export function ownsSection(part: ReviewPart, title: string): boolean {
  return part.role === 'overall'
    ? /^overall$/i.test(title)
    : part.paths.includes(title);
}

/**
 * Without this, a later part could write a heading for an earlier batch's
 * file, and the parser (last text wins) would replace that file's review.
 * Uses the parser's `readHeading` so both agree on what a path is. A file
 * part's text before its first own heading is dropped, since it would run on
 * into another part's section. Runs after `withoutSignalLines`.
 */
export function onlyOwnSections(
  push: (delta: string) => void,
  part: ReviewPart,
): { write(delta: string): void; end(): void } {
  let skipping = part.role === 'files';
  let held = '';
  /** Null until the line is known to be kept or dropped. */
  let keep: boolean | null = null;

  const settleHeld = () => {
    const head = held.trimStart();
    if (head.length === 0 || head.startsWith('#')) {
      return;
    }
    keep = !skipping;
    if (keep) {
      push(held);
    }
    held = '';
  };
  const endLine = (newline: string) => {
    if (keep === null) {
      const title = readHeading(held);
      if (title !== null) {
        skipping = !ownsSection(part, title);
      }
      keep = !skipping;
      if (keep) {
        push(held);
      }
    }
    if (keep && newline) {
      push(newline);
    }
    held = '';
    keep = null;
  };
  return {
    end: () => endLine(''),
    write(delta) {
      for (const piece of delta.split(/(\r\n|\r|\n)/)) {
        if (piece === '\n' || piece === '\r' || piece === '\r\n') {
          endLine(piece);
        } else if (keep === true) {
          push(piece);
        } else if (keep === null && piece) {
          held += piece;
          settleHeld();
        }
      }
    },
  };
}

/** A repeated path keeps its first position and its last text, because a retried part repeats sections. */
function flushSection(parse: SummaryParse): void {
  if (parse.currentPath !== null && parse.current) {
    const section = {
      path: parse.currentPath,
      summary: parse.current.join('\n').trim(),
    };
    const earlier = parse.files.findIndex((f) => f.path === section.path);
    if (earlier === -1) {
      parse.files.push(section);
    } else {
      parse.files[earlier] = section;
    }
  }
  parse.current = null;
  parse.currentPath = null;
}

function readSignalLine(parse: SummaryParse, line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === OVERALL_REWRITE_LINE) {
    // Ignored after files start: only the overall part, which comes first, may rewrite.
    if (parse.filesStarted) {
      return true;
    }
    flushSection(parse);
    // Emptying `overall` also lets a new decision line be read.
    parse.overall.length = 0;
    parse.overallIncomplete = false;
    parse.current = parse.overall;
    return true;
  }
  const cut = CUT_OFF.exec(trimmed)?.[1];
  if (cut === undefined) {
    return false;
  }
  if (cut === OVERALL_SECTION) {
    parse.overallIncomplete = true;
  } else {
    parse.incomplete.add(cut);
  }
  return true;
}

/** An `Overall` heading after a file section is read into nothing. */
function openSection(parse: SummaryParse, title: string): void {
  flushSection(parse);
  if (/^overall$/i.test(title)) {
    parse.currentPath = null;
    parse.current = parse.filesStarted ? [] : parse.overall;
    return;
  }
  parse.filesStarted = true;
  parse.currentPath = title;
  parse.current = [];
}

function readSummaryLine(parse: SummaryParse, raw: string): void {
  const line = raw.trimEnd();
  if (readSignalLine(parse, line)) {
    return;
  }
  const named = readDecisionLine(line);
  if (
    named &&
    !parse.filesStarted &&
    parse.currentPath === null &&
    parse.overall.length === 0
  ) {
    if (named !== 'unrecognised') {
      parse.decision = named;
    }
    return;
  }
  // A bare "##" is a heading still arriving: hold it out of the text.
  if (/^\s*#{1,6}\s*$/.test(line)) {
    return;
  }
  const title = readHeading(line);
  if (title !== null) {
    openSection(parse, title);
    return;
  }
  parse.current?.push(line);
}

export function parseSummaryText(text: string, partial = false): Summary {
  const parse: SummaryParse = {
    current: null,
    currentPath: null,
    decision: 'comment',
    files: [],
    filesStarted: false,
    incomplete: new Set(),
    overall: [],
    overallIncomplete: false,
  };
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    readSummaryLine(parse, raw);
  }
  const writing =
    parse.currentPath ??
    (parse.current === parse.overall ? OVERALL_SECTION : null);
  flushSection(parse);
  return {
    decision: parse.decision,
    files: [
      ...parse.files.map((f) =>
        parse.incomplete.has(f.path) ? { ...f, incomplete: true as const } : f,
      ),
      // Sections a cut-off part never reached are still reported as missing.
      ...[...parse.incomplete]
        .filter((path) => !parse.files.some((f) => f.path === path))
        .map((path) => ({ incomplete: true as const, path, summary: '' })),
    ],
    overall: parse.overall.join('\n').trim(),
    ...(parse.overallIncomplete ? { overallIncomplete: true as const } : {}),
    ...(partial ? { partial: true } : {}),
    writing,
  };
}
