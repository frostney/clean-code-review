/**
 * The questions, in one place. Jev's instructions, the payload the page reads
 * and the meters on screen all derive from this list, so adding a row here is
 * the whole change.
 *
 * Every smell is a yes/no ("noul") phrased so that **yes is a finding**: a lit
 * row is a problem. Three scales sit alongside (size, nesting, verdict). The
 * groups follow the chapters of Robert C. Martin's *Clean Code* (2008).
 *
 * Answer types are TypeSafe's:
 *  - noul:   probability that the statement is true (0–1)
 *  - score:  a position on a five-level scale (0–4, fractions welcome)
 */

export type GroupId =
  | "names"
  | "functions"
  | "comments"
  | "formatting"
  | "objects"
  | "errors"
  | "tests"
  | "classes"
  | "smells"
  | "verdict";

/** Rows that only make sense for some files. */
export type AppliesTo = "all" | "patch" | "test";

interface Base {
  id: string;
  label: string;
  group: GroupId;
  /** The instruction Jev receives, phrased so a "yes" is a finding. */
  ask: string;
  /** Default "all". "patch": only diffs. "test": only files whose path looks like a test. */
  appliesTo?: AppliesTo;
}

export type Question =
  | (Base & { type: "noul" })
  | (Base & { type: "score"; levels: readonly [string, string, string, string, string] });

export interface Group {
  id: GroupId;
  title: string;
  blurb: string;
}

export const GROUPS: readonly Group[] = [
  { id: "names", title: "Names", blurb: "Chapter 2 · Meaningful names." },
  { id: "functions", title: "Functions", blurb: "Chapter 3 · Small. Do one thing." },
  { id: "comments", title: "Comments", blurb: "Chapter 4 · Explain yourself in code." },
  { id: "formatting", title: "Formatting", blurb: "Chapter 5 · Vertical and horizontal order." },
  { id: "objects", title: "Objects & data", blurb: "Chapter 6 · Law of Demeter." },
  { id: "errors", title: "Error handling", blurb: "Chapter 7 · Don't return null." },
  { id: "tests", title: "Unit tests", blurb: "Chapter 9 · Clean tests." },
  { id: "classes", title: "Classes", blurb: "Chapter 10 · Cohesion and change." },
  { id: "smells", title: "Smells", blurb: "Chapter 17 · Smells and heuristics." },
  { id: "verdict", title: "Verdict", blurb: "What Uncle Bob would say." },
];

const noul = (id: string, group: GroupId, label: string, ask: string, appliesTo?: AppliesTo): Question => ({
  id,
  group,
  label,
  ask,
  type: "noul",
  ...(appliesTo ? { appliesTo } : {}),
});

export const QUESTIONS: readonly Question[] = [
  // Chapter 2 — Meaningful Names
  noul("names_hide_intent", "names", "Names hide intent", "Do names hide intent: cryptic abbreviations, vague words, or names that mislead about what the thing is or does?"),
  noul("encodings_noise_words", "names", "Encodings or noise words", "Do names carry encodings or noise words: type prefixes, Hungarian notation, member prefixes, or filler like data, info, manager, object?"),
  noul("inconsistent_naming", "names", "One concept, several words", "Is one concept named in several ways (fetch/get/retrieve, or the same word used for different things)?"),

  // Chapter 3 — Functions
  noul("does_more_than_one_thing", "functions", "Does more than one thing", "Does any function do more than one thing (you could extract a second function whose name is not just a restatement of the first)?"),
  noul("too_many_arguments", "functions", "Too many arguments", "Does any function take three or more arguments?"),
  noul("flag_or_output_arguments", "functions", "Flag or output arguments", "Are boolean flag arguments or output arguments (a function writing its result into an argument) used?"),
  noul("hidden_side_effects", "functions", "Hidden side effects", "Does any function have side effects its name does not promise: mutating globals, arguments, or shared state, doing I/O, or changing something the caller would not expect?"),
  noul("mixed_abstraction_levels", "functions", "Mixed levels of abstraction", "Does any function mix levels of abstraction, such as high-level business steps next to string concatenation or byte handling?"),
  noul("long_function", "functions", "Long function", "Is any function longer than about thirty lines?"),

  // Chapter 4 — Comments
  noul("redundant_or_misleading_comments", "comments", "Redundant or misleading comments", "Are there comments that only restate the code, or that are out of date or wrong?"),
  noul("commented_out_code", "comments", "Commented-out code", "Is there commented-out code left in place?"),
  noul("noise_comments", "comments", "Noise comments", "Are there noise comments: change journals, attributions, closing-brace markers, mandated boilerplate, or comments that compensate for unclear code?"),

  // Chapter 5 — Formatting
  noul("related_code_far_apart", "formatting", "Related code far apart", "Are related things placed far apart: variables declared far from their use, callers far from callees, no blank lines separating concepts?"),
  noul("inconsistent_formatting", "formatting", "Inconsistent formatting", "Is formatting inconsistent within the file: indentation, spacing, line length, or brace style varying without reason?"),

  // Chapter 6 — Objects and Data Structures
  noul("train_wrecks", "objects", "Train wrecks", "Are there chains of calls that navigate through several objects (a.getB().getC().doD()), breaking the Law of Demeter?"),
  noul("exposed_internals", "objects", "Exposed internals or hybrids", "Are object internals exposed (public fields, getters and setters on everything) or are there hybrids that are half object, half data structure?"),

  // Chapter 7 — Error Handling
  noul("returns_null", "errors", "Returns null or sentinels", "Does the code return null, undefined, -1 or another sentinel to signal failure?"),
  noul("error_codes", "errors", "Error codes instead of exceptions", "Are error codes or status booleans the caller must check used instead of exceptions?"),
  noul("swallowed_errors", "errors", "Swallowed or empty catch", "Is any error caught and ignored, logged and dropped, or handled with an empty catch block?"),
  noul("error_handling_tangled", "errors", "Error handling tangled with logic", "Is error handling interleaved with the main logic rather than separated from it?"),

  // Chapter 9 — Unit Tests
  noul("hard_to_test", "tests", "Hard to test", "Would this be hard to unit-test as written: hidden dependencies, globals, clocks, randomness, or I/O tangled with logic?"),
  noul("unclear_tests", "tests", "Unclear or multi-assert tests", "Are the tests unclear: several concepts or assertions per test, no clear build-operate-check structure, or names that do not say what is tested?", "test"),

  // Chapter 10 — Classes
  noul("class_does_too_much", "classes", "Class does too much", "Does a class or module have more than one responsibility or low cohesion (methods that do not share the instance variables)?"),
  noul("rigid_to_change", "classes", "Rigid to change", "Would a likely change require modifying existing code in several places rather than extending it (Open-Closed Principle violated)?"),

  // Chapter 17 — Smells and Heuristics
  noul("duplication", "smells", "Duplication", "Is there duplicated logic that should be one function or abstraction?"),
  noul("magic_numbers", "smells", "Magic numbers", "Are there unexplained literal numbers or strings where a named constant belongs?"),
  noul("dead_code_or_clutter", "smells", "Dead code or clutter", "Is there dead code, unused variables or imports, uncalled functions, or other clutter?"),
  noul("obscured_intent", "smells", "Obscured intent", "Is intent obscured by dense expressions, clever tricks, or missing explanatory variables?"),
  noul("switch_over_polymorphism", "smells", "Switch chains over polymorphism", "Are if/else or switch chains on a type or flag used where polymorphism would be cleaner?"),
  noul("feature_envy", "smells", "Feature envy", "Does a method work more with another object's data than its own?"),

  // Scales
  {
    id: "function_size",
    group: "verdict",
    label: "Function size",
    type: "score",
    ask: "How large are the functions? Sprawling (screens long), Long (30+ lines), Moderate (10–30), Short (under 10), Tiny (a handful of lines). Judge the typical function.",
    levels: ["Sprawling", "Long", "Moderate", "Short", "Tiny"],
  },
  {
    id: "nesting",
    group: "verdict",
    label: "Nesting",
    type: "score",
    ask: "How deep is the control-flow nesting? Arrow-shaped (5+ levels), Deep (4), Moderate (3), Shallow (2), Flat (1 or guard clauses only).",
    levels: ["Arrow-shaped", "Deep", "Moderate", "Shallow", "Flat"],
  },
  noul("leaves_it_worse", "verdict", "Leaves it worse than found", "Judging the change shown in the diff: does it leave the code worse than it found it (the Boy Scout Rule broken)?", "patch"),
  {
    id: "verdict",
    group: "verdict",
    label: "Verdict",
    type: "score",
    ask: "What would Uncle Bob say in review? Rewrite it, Refactor (substantial restructuring), Tidy up (a few extractions and renames), Nitpicks (cosmetic), Ship it.",
    levels: ["Rewrite it", "Refactor", "Tidy up", "Nitpicks", "Ship it"],
  },
];

export const QUESTION_COUNT = QUESTIONS.length;

/** Ids of the yes/no smell rows (everything that is not a scale). */
export const SMELL_IDS: readonly string[] = QUESTIONS.filter((q) => q.type === "noul").map((q) => q.id);

/** True for paths that look like tests. */
export function isTestPath(path: string): boolean {
  return /(^|\/)(__tests__|tests?|specs?)\//i.test(path) || /\.(test|spec)\.[a-z]+$/i.test(path) || /(^|\/)test_[^/]+\.py$/i.test(path);
}

/** The rows that apply to one file: all rows, minus patch-only rows for whole files and test-only rows for non-test paths. */
export function questionsFor(file: { path: string; patch?: boolean }): Question[] {
  const test = isTestPath(file.path);
  return QUESTIONS.filter((q) => {
    const scope = q.appliesTo ?? "all";
    if (scope === "patch") return !!file.patch;
    if (scope === "test") return test;
    return true;
  });
}

export function questionById(id: string): Question | undefined {
  return QUESTIONS.find((q) => q.id === id);
}
