/**
 * Single source for Jev's questions, the page payload and the meters, so
 * adding a row here is the whole change. Changing wording or a yes/no
 * definition requires bumping `QUESTIONS_VERSION` in `./judge.ts`.
 *
 * Every noul is phrased so that yes is a finding. Scores are 0–4 and may be
 * fractional.
 */

export type GroupId =
  | 'names'
  | 'functions'
  | 'comments'
  | 'formatting'
  | 'objects'
  | 'errors'
  | 'tests'
  | 'classes'
  | 'smells'
  | 'verdict';

type AppliesTo = 'all' | 'patch' | 'test';

interface Base {
  id: string;
  label: string;
  group: GroupId;
  ask: string;
  /** Defaults to "all". */
  appliesTo?: AppliesTo;
}

interface Noul extends Base {
  type: 'noul';
  /** What counts as yes, sent to Jev as the question's `true` criterion. */
  yes?: string;
  /** What does not, sent as the `false` criterion. */
  no?: string;
  /**
   * P(yes) at or above this is a finding. Jev's probabilities are not
   * calibrated alike, so even odds flags far too much on some questions and
   * almost nothing on others. Each cutoff was fitted on 876 code files from
   * 200 public pull requests labelled by blind reviewers and kept only where
   * it raised agreement (Cohen's kappa) by 0.02 or more; on 100 files from 25
   * other pull requests it raised kappa from 0.39 to 0.51. The `yes`/`no`
   * definitions were checked the same way. Applied after judging, so changing
   * one needs no `QUESTIONS_VERSION` bump.
   */
  cutoff: number;
}

export type Question =
  | Noul
  | (Base & {
      type: 'score';
      levels: readonly [string, string, string, string, string];
    });

export interface Group {
  id: GroupId;
  title: string;
  blurb: string;
}

export const GROUPS: readonly Group[] = [
  { blurb: 'Chapter 2 · Meaningful names.', id: 'names', title: 'Names' },
  {
    blurb: 'Chapter 3 · Small. Do one thing.',
    id: 'functions',
    title: 'Functions',
  },
  {
    blurb: 'Chapter 4 · Explain yourself in code.',
    id: 'comments',
    title: 'Comments',
  },
  {
    blurb: 'Chapter 5 · Vertical and horizontal order.',
    id: 'formatting',
    title: 'Formatting',
  },
  {
    blurb: 'Chapter 6 · Law of Demeter.',
    id: 'objects',
    title: 'Objects & data',
  },
  {
    blurb: "Chapter 7 · Don't return null.",
    id: 'errors',
    title: 'Error handling',
  },
  { blurb: 'Chapter 9 · Clean tests.', id: 'tests', title: 'Unit tests' },
  {
    blurb: 'Chapter 10 · Cohesion and change.',
    id: 'classes',
    title: 'Classes',
  },
  {
    blurb: 'Chapter 17 · Smells and heuristics.',
    id: 'smells',
    title: 'Smells',
  },
  { blurb: 'What Uncle Bob would say.', id: 'verdict', title: 'Verdict' },
];

export const DEFAULT_CUTOFF = 0.5;

const noul = (
  id: string,
  group: GroupId,
  label: string,
  ask: string,
  extra: Partial<Pick<Noul, 'appliesTo' | 'cutoff' | 'no' | 'yes'>> = {},
): Question => ({
  ask,
  cutoff: DEFAULT_CUTOFF,
  group,
  id,
  label,
  type: 'noul',
  ...extra,
});

export const QUESTIONS: readonly Question[] = [
  // Chapter 2 — Meaningful Names
  noul(
    'names_hide_intent',
    'names',
    'Names hide intent',
    'Would a reader need to read the implementation to know what a name means (Clean Code ch. 2, intention-revealing names)?',
    {
      cutoff: 0.25,
      no: "Conventional short names (`i`, `j`, `err`, `ctx`, `e`, `T`, `id`, `url`, `x`/`y` for coordinates), abbreviations standard in the domain, names in the language's idiom.",
      yes: 'Cryptic abbreviations (`cfgMgr`, `tmpBuf2`, `procRes`), single letters outside tiny loops and lambdas, vague names (`data`, `handle`, `process`, `doStuff`, `result2`, `flag`, `val`), or names that mislead about type or behaviour (`accountList` holding a map, `getX` that writes).',
    },
  ),
  noul(
    'encodings_noise_words',
    'names',
    'Encodings or noise words',
    'Do names carry encodings or noise words (Clean Code ch. 2): type prefixes, Hungarian notation, member prefixes, or filler words that hide what the thing is?',
    {
      no: "Conventions required or standard for the language or framework: C# and TypeScript-interop `IFoo` interfaces, Python `_private`, Swift/Kotlin/C++ backing `_field` where that is the project's style, Go short receivers, `ctx`, `err`, `req`, `res`, `props`, `state`; domain or API names that contain these words (`Metadata`, `UserInfo` from an SDK); one filler word inside an otherwise clear name.",
      yes: 'Hungarian or type prefixes (`strName`, `iCount`, `bFlag`, `arrItems`), `m_` member prefixes, or a name whose main word is filler (`data`, `info`, `object`, `manager`, `processor`, `helper`, `thing`) where a precise word was available.',
    },
  ),
  noul(
    'inconsistent_naming',
    'names',
    'One concept, several words',
    'Is one concept named in several ways (fetch/get/retrieve, or the same word used for different things)?',
  ),

  // Chapter 3 — Functions
  noul(
    'does_more_than_one_thing',
    'functions',
    'Does more than one thing',
    'Does any function do more than one thing (you could extract a second function whose name is not just a restatement of the first)?',
    {
      cutoff: 0.65,
    },
  ),
  noul(
    'too_many_arguments',
    'functions',
    'Too many arguments',
    'Count the parameters each function or method DECLARES in its signature in the shown code. Does any declared signature have three or more parameters?',
    {
      cutoff: 0.55,
      no: 'Arguments passed at a call site (`foo(a, b, c)` calling another function), constructor or builder calls, `self`/`this`/receivers, generic type parameters, a single options object or destructured props, functions whose signature is not shown.',
      yes: 'A definition such as `def f(a, b, c)`, `func f(a, b string, c int)`, `void f(int a, int b, int c)`, `fun f(a: A, b: B, c: C)` in the shown code.',
    },
  ),
  noul(
    'flag_or_output_arguments',
    'functions',
    'Flag or output arguments',
    'Are boolean flag arguments or output arguments (a function writing its result into an argument) used?',
    {
      cutoff: 0.65,
    },
  ),
  noul(
    'hidden_side_effects',
    'functions',
    'Hidden side effects',
    'Does any function have side effects its name does not promise: mutating globals, arguments, or shared state, doing I/O, or changing something the caller would not expect?',
    {
      cutoff: 0.6,
    },
  ),
  noul(
    'mixed_abstraction_levels',
    'functions',
    'Mixed levels of abstraction',
    'Does any function mix levels of abstraction, such as high-level business steps next to string concatenation or byte handling?',
  ),
  noul(
    'long_function',
    'functions',
    'Long function',
    'Is any function longer than about thirty lines?',
    {
      cutoff: 0.35,
    },
  ),

  // Chapter 4 — Comments
  noul(
    'redundant_or_misleading_comments',
    'comments',
    'Redundant or misleading comments',
    'Are there comments that only restate the code, or that are out of date or wrong (Clean Code ch. 4)?',
    {
      cutoff: 0.4,
      no: 'Comments explaining why, a constraint, a workaround or a link; public API docs that add information; license headers.',
      yes: 'A comment that says what the next line plainly says (`// increment i`, `// constructor`, docs that restate the signature), or one that no longer matches the code: wrong names, describes removed or changed behaviour, a TODO already done.',
    },
  ),
  noul(
    'commented_out_code',
    'comments',
    'Commented-out code',
    'Is there commented-out code left in place?',
    {
      cutoff: 0.55,
    },
  ),
  noul(
    'noise_comments',
    'comments',
    'Noise comments',
    'Are there noise comments: change journals, attributions, closing-brace markers, mandated boilerplate, or comments that compensate for unclear code?',
  ),

  // Chapter 5 — Formatting
  noul(
    'related_code_far_apart',
    'formatting',
    'Related code far apart',
    'Are related things placed far apart: variables declared far from their use, callers far from callees, no blank lines separating concepts?',
    {
      cutoff: 0.45,
    },
  ),
  noul(
    'inconsistent_formatting',
    'formatting',
    'Inconsistent formatting',
    'Is formatting inconsistent within the file: indentation, spacing, line length, or brace style varying without reason?',
    {
      cutoff: 0.6,
    },
  ),

  // Chapter 6 — Objects and Data Structures
  noul(
    'train_wrecks',
    'objects',
    'Train wrecks',
    'Are there chains of calls that navigate through several objects (a.getB().getC().doD()), breaking the Law of Demeter?',
  ),
  noul(
    'exposed_internals',
    'objects',
    'Exposed internals or hybrids',
    'Are object internals exposed (public fields, getters and setters on everything) or are there hybrids that are half object, half data structure?',
    {
      cutoff: 0.8,
    },
  ),

  // Chapter 7 — Error Handling
  noul(
    'returns_null',
    'errors',
    'Returns null or sentinels',
    'Does the code return null, undefined, -1 or another sentinel to signal failure?',
    {
      cutoff: 0.75,
    },
  ),
  noul(
    'error_codes',
    'errors',
    'Error codes instead of exceptions',
    "Does a function report failure through an error code or status boolean that every caller must check, instead of an exception or the language's error type (Clean Code ch. 7)?",
    {
      no: 'Go `(value, error)`, Rust `Result`/`Option`, Swift `throws`/`Result`, Kotlin `Result`; HTTP status codes in HTTP handlers or responses; process exit codes in a CLI entry point; booleans that answer a question (`isValid`, `contains`, `hasAccess`); framework hooks whose contract returns a boolean.',
      yes: 'A function returns `-1`, an error number, a status enum or `false` to mean "failed", and callers must check it, e.g. `if (save(x) != OK)`, `if (!tryParse(...))` used as the failure channel of the function\'s own API.',
    },
  ),
  noul(
    'swallowed_errors',
    'errors',
    'Swallowed or empty catch',
    'Is any error caught and ignored, logged and dropped, or handled with an empty catch block?',
  ),
  noul(
    'error_handling_tangled',
    'errors',
    'Error handling tangled with logic',
    "Is error handling tangled with the main logic (Clean Code ch. 7, 'error handling is one thing')?",
    {
      cutoff: 0.35,
      no: "Guard clauses or early returns at the top; Go's single `if err != nil { return ... }` after a call; Rust `?`; Swift `try`; one try/catch around a function whose job is translating errors; tests asserting on errors.",
      yes: 'The happy path of a function is repeatedly interrupted by try/catch blocks, error branches or status checks, so the main logic is hard to follow and the error handling could be extracted.',
    },
  ),

  // Chapter 9 — Unit Tests
  noul(
    'hard_to_test',
    'tests',
    'Hard to test',
    'Would this be hard to unit-test as written: hidden dependencies, globals, clocks, randomness, or I/O tangled with logic?',
    {
      cutoff: 0.6,
    },
  ),
  noul(
    'unclear_tests',
    'tests',
    'Unclear or multi-assert tests',
    'Are the tests unclear (Clean Code ch. 9: one concept per test, build-operate-check, readable names)?',
    {
      appliesTo: 'test',
      cutoff: 0.2,
      no: 'One behaviour per test, even with several asserts on that one outcome; table-driven or parameterised tests with clear case names; short helper setup.',
      yes: 'A test exercises several unrelated behaviours, asserts on several different concepts, lacks a visible arrange/act/assert structure, hides what it checks inside long inline setup, or has a name that does not say what is tested (`test1`, `testFoo`, `works`).',
    },
  ),

  // Chapter 10 — Classes
  noul(
    'class_does_too_much',
    'classes',
    'Class does too much',
    'Does a class or module have more than one responsibility or low cohesion (methods that do not share the instance variables)?',
    {
      cutoff: 0.55,
    },
  ),
  noul(
    'rigid_to_change',
    'classes',
    'Rigid to change',
    'Would a likely change require modifying existing code in several places rather than extending it (Open-Closed Principle violated)?',
  ),

  // Chapter 17 — Smells and Heuristics
  noul(
    'duplication',
    'smells',
    'Duplication',
    'Is there duplicated logic that should be one function or abstraction?',
    {
      cutoff: 0.4,
    },
  ),
  noul(
    'magic_numbers',
    'smells',
    'Magic numbers',
    'Are there unexplained literal numbers or strings where a named constant belongs?',
    {
      cutoff: 0.6,
    },
  ),
  noul(
    'dead_code_or_clutter',
    'smells',
    'Dead code or clutter',
    'Is there dead code, unused variables or imports, uncalled functions, or other clutter?',
  ),
  noul(
    'obscured_intent',
    'smells',
    'Obscured intent',
    'Is intent obscured (Clean Code G16, G19): would a reader have to decode an expression to understand what it is for?',
    {
      cutoff: 0.2,
      no: 'Idiomatic short expressions, simple conditions, well-named helper calls, standard library idioms.',
      yes: 'Dense one-liners, nested ternaries, long compound boolean conditions with no explaining variable or function, bit tricks, unexplained regexes, index arithmetic, clever constructs whose purpose is not evident from names.',
    },
  ),
  noul(
    'switch_over_polymorphism',
    'smells',
    'Switch chains over polymorphism',
    'Are if/else or switch chains on a type or flag used where polymorphism would be cleaner?',
    {
      cutoff: 0.65,
    },
  ),
  noul(
    'feature_envy',
    'smells',
    'Feature envy',
    "Feature envy (Clean Code G14): does a method reach into ONE other object's fields or getters repeatedly to compute something that belongs on that object?",
    {
      cutoff: 0.25,
      no: 'Calling collaborators, services, framework or library APIs; delegating; reading plain data (DTOs, records, structs, maps, JSON, props, config, options objects); free functions or scripts in languages without classes working on their arguments; tests calling the code under test; UI code reading view-model state.',
      yes: 'A method reads several fields or getters of one other object (not its own, not a parameter of plain data type) and computes with them, e.g. `order.getItems()`, `order.getDiscount()`, `order.getTax()` used outside Order to total an order.',
    },
  ),

  // Scales
  {
    ask: 'How large are the functions? Sprawling (screens long), Long (30+ lines), Moderate (10–30), Short (under 10), Tiny (a handful of lines). Judge the typical function.',
    group: 'verdict',
    id: 'function_size',
    label: 'Function size',
    levels: ['Sprawling', 'Long', 'Moderate', 'Short', 'Tiny'],
    type: 'score',
  },
  {
    ask: 'How deep is the control-flow nesting? Arrow-shaped (5+ levels), Deep (4), Moderate (3), Shallow (2), Flat (1 or guard clauses only).',
    group: 'verdict',
    id: 'nesting',
    label: 'Nesting',
    levels: ['Arrow-shaped', 'Deep', 'Moderate', 'Shallow', 'Flat'],
    type: 'score',
  },
  noul(
    'leaves_it_worse',
    'verdict',
    'Leaves it worse than found',
    'Comparing the code before and after this change: does the change leave the code worse than it found it (the Boy Scout Rule)?',
    {
      appliesTo: 'patch',
      cutoff: 0.25,
      no: 'The change adds new, reasonably clean code, fixes a bug cleanly, or improves the code; a brand-new file cannot leave existing code worse.',
      yes: 'The change makes existing code harder to read or change: lengthens an already long function, adds nesting, adds duplication, introduces unclear names, leaves a comment stale, removes or weakens tests, adds a hack or special case.',
    },
  ),
  {
    ask: 'What would Uncle Bob say in review? Rewrite it, Refactor (substantial restructuring), Tidy up (a few extractions and renames), Nitpicks (cosmetic), Ship it.',
    group: 'verdict',
    id: 'verdict',
    label: 'Verdict',
    levels: ['Rewrite it', 'Refactor', 'Tidy up', 'Nitpicks', 'Ship it'],
    type: 'score',
  },
];

export const QUESTION_COUNT = QUESTIONS.length;

export const SMELL_IDS: readonly string[] = QUESTIONS.filter(
  (q) => q.type === 'noul',
).map((q) => q.id);

function isTestPath(path: string): boolean {
  return (
    /(^|\/)(__tests__|tests?|specs?)\//i.test(path) ||
    /\.(test|spec)\.[a-z]+$/i.test(path) ||
    /(^|\/)test_[^/]+\.py$/i.test(path)
  );
}

export function questionsFor(file: {
  path: string;
  patch?: boolean;
}): Question[] {
  const test = isTestPath(file.path);

  return QUESTIONS.filter((q) => {
    const scope = q.appliesTo ?? 'all';

    if (scope === 'patch') {
      return file.patch === true;
    }
    if (scope === 'test') {
      return test;
    }

    return true;
  });
}

export function questionById(id: string): Question | undefined {
  return QUESTIONS.find((q) => q.id === id);
}

export function cutoffOf(id: string): number {
  const q = questionById(id);

  return q?.type === 'noul' ? q.cutoff : DEFAULT_CUTOFF;
}

/** Whether a yes/no answer is a finding, by its question's own cutoff. */
export function isFinding(id: string, probability: number): boolean {
  return probability >= cutoffOf(id);
}

/**
 * How far a finding clears its cutoff, from 0 at the cutoff to 1 at
 * certainty, so findings compare across questions with different cutoffs.
 */
export function findingMargin(id: string, probability: number): number {
  const cutoff = cutoffOf(id);

  return (probability - cutoff) / (1 - cutoff);
}

/** TypeSafe's "noul" is the SDK's "boolean". */
export function questionsOf(rows: readonly Question[]) {
  return Object.fromEntries(
    rows.map((q) =>
      q.type === 'noul'
        ? [
            q.id,
            {
              instructions: q.ask,
              type: 'boolean' as const,
              ...(q.yes || q.no
                ? { criteria: { false: q.no ?? null, true: q.yes ?? null } }
                : {}),
            },
          ]
        : [
            q.id,
            {
              criteria: [...q.levels],
              instructions: q.ask,
              type: 'score' as const,
            },
          ],
    ),
  );
}

/** Sent beside a diff so Jev judges the code after the change, not the markers. */
const DIFF_NOTE =
  "Judge the code as it stands after this change. The diff shows what changed: '+' lines were added, '-' lines removed.";

/**
 * The keys a call sends beside the questions, with the code itself left empty:
 * the one definition of the payload's shape. `evaluateFile` spreads it and
 * fills the code in, and the spend estimate measures it, so a key added here
 * reaches both.
 */
export const JUDGE_STATE = {
  patch: { code_after_change: '', diff: '', note: DIFF_NOTE, path: '' },
  whole: { code: '', path: '' },
} as const;

/**
 * Everything one call carries besides the code itself, measured rather than
 * guessed at, so the spend estimate follows a change of wording. The path is
 * counted separately by the caller.
 */
export const QUESTIONS_OVERHEAD_CHARS = JSON.stringify({
  questions: questionsOf(QUESTIONS),
  state: JUDGE_STATE.patch,
}).length;
