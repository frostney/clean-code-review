/**
 * The languages the page can highlight, keyed the way shiki names them.
 * "text" is shiki's own no-op grammar: anything we cannot place renders as
 * plain monospace rather than as the wrong language.
 */
const LANGS = [
  'typescript',
  'javascript',
  'tsx',
  'python',
  'java',
  'go',
  'rust',
  'json',
  'yaml',
  'css',
  'html',
  'diff',
  'bash',
] as const;

/**
 * Languages the page recognises and names, but does not colour: shiki's
 * JavaScript regex engine has no grammar loaded for them, so they render as
 * plain monospace. Naming one is still worth it — the chip says PHP rather
 * than Text, and a paste of one is recognised as code rather than prose.
 */
const PLAIN_LANGS = ['php', 'swift'] as const;

export type Lang =
  | (typeof LANGS)[number]
  | (typeof PLAIN_LANGS)[number]
  | 'text';

const BY_EXTENSION: Record<string, Lang> = {
  // Code the highlighter has no grammar for. They are here so a path like
  // `main.c` is recognised as a file rather than read as prose, and so a paste
  // of one is named after its language; "text" is deliberate — a lie about the
  // grammar would also be a lie on the chip, and plain monospace is neither.
  c: 'text',
  cjs: 'javascript',
  clj: 'text',
  cpp: 'text',
  cs: 'text',
  css: 'css',
  dart: 'text',
  diff: 'diff',
  ex: 'text',
  exs: 'text',
  go: 'go',
  h: 'text',
  hpp: 'text',
  hs: 'text',
  html: 'html',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'tsx',
  kt: 'text',
  lua: 'text',
  m: 'text',
  mjs: 'javascript',
  patch: 'diff',
  php: 'php',
  py: 'python',
  r: 'text',
  rb: 'text',
  rs: 'rust',
  scala: 'text',
  sh: 'bash',
  sql: 'text',
  swift: 'swift',
  ts: 'typescript',
  tsx: 'tsx',
  yaml: 'yaml',
  yml: 'yaml',
  zig: 'text',
};

/** What the chip on a file header says. */
const LABELS: Record<Lang, string> = {
  bash: 'Shell',
  css: 'CSS',
  diff: 'Diff',
  go: 'Go',
  html: 'HTML',
  java: 'Java',
  javascript: 'JavaScript',
  json: 'JSON',
  php: 'PHP',
  python: 'Python',
  rust: 'Rust',
  swift: 'Swift',
  text: 'Text',
  tsx: 'TSX',
  typescript: 'TypeScript',
  yaml: 'YAML',
};

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

export function langOf(path: string): Lang {
  return BY_EXTENSION[extensionOf(path)] ?? 'text';
}

export function langLabel(lang: Lang): string {
  return LABELS[lang];
}

/** `src/billing/refund.ts` → `["src/billing/", "refund.ts"]`, for the two-tone path. */
export function splitPath(path: string): [string, string] {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? ['', path] : [path.slice(0, cut + 1), path.slice(cut + 1)];
}

/** The extension a fence or shebang on the first line implies, if any. */
export function extensionFromHint(firstLine: string): string | null {
  const line = firstLine.trim();
  const fence = /^```+\s*([A-Za-z0-9+#-]+)\s*$/.exec(line);
  if (fence) {
    const named = fence[1].toLowerCase();
    const byName: Record<string, string> = {
      bash: 'sh',
      css: 'css',
      go: 'go',
      golang: 'go',
      html: 'html',
      java: 'java',
      javascript: 'js',
      js: 'js',
      json: 'json',
      jsx: 'jsx',
      php: 'php',
      py: 'py',
      python: 'py',
      rs: 'rs',
      rust: 'rs',
      sh: 'sh',
      shell: 'sh',
      swift: 'swift',
      ts: 'ts',
      tsx: 'tsx',
      typescript: 'ts',
      yaml: 'yml',
      yml: 'yml',
    };
    return byName[named] ?? null;
  }
  if (/^#!.*\bpython[0-9.]*\b/.test(line)) {
    return 'py';
  }
  if (/^#!.*\bnode\b/.test(line)) {
    return 'js';
  }
  if (/^#!.*\b(ba|z|k)?sh\b/.test(line)) {
    return 'sh';
  }
  // A first-line comment that names a file: `// src/thing.ts`, `# thing.py`.
  const named = /^(?:\/\/|#|\/\*)\s*\S*?\.([A-Za-z0-9]+)\b/.exec(line);
  if (named && BY_EXTENSION[named[1].toLowerCase()]) {
    return named[1].toLowerCase();
  }
  return null;
}

/**
 * How much of a paste is read when the language has to be guessed from the
 * code. The opening of a file is what places it; a whole paste is needless work.
 */
const CONTENT_SAMPLE_CHARS = 4_000;

/**
 * The guesses, in the order they are tried.
 *
 * Most-specific first — Go, Rust and Java have keywords nothing else uses,
 * while `const` and `=>` are shared, so TypeScript has to be ruled in (types,
 * `import … from`) before JavaScript is the answer. PHP and Swift are ruled in
 * ahead of the JavaScript rules for the same reason: `function name($a)` and
 * `let x: Int` would otherwise be read as a `function`/`let` declaration.
 */
const CONTENT_RULES: readonly {
  extension: string;
  matches: (text: string) => boolean;
}[] = [
  {
    extension: 'go',
    matches: (t) => /^\s*package\s+\w+/m.test(t) && /\bfunc\s/.test(t),
  },
  {
    extension: 'rs',
    matches: (t) =>
      /\bfn\s+\w+\s*[(<]/.test(t) &&
      (/\blet\s+mut\b/.test(t) || /\bimpl\s/.test(t)),
  },
  {
    extension: 'java',
    matches: (t) =>
      /\bpublic\s+(?:final\s+|abstract\s+)?class\b/.test(t) ||
      /\bSystem\.out\b/.test(t),
  },
  // PHP: the open tag settles it; otherwise `$variables` plus `->` or a
  // function whose parameters are variables.
  { extension: 'php', matches: (t) => /<\?php\b/.test(t) },
  {
    extension: 'php',
    matches: (t) =>
      /\$\w+/.test(t) &&
      (/->\s*\w/.test(t) || /\bfunction\s+\w+\s*\([^)]*\$/.test(t)),
  },
  // Swift: a Foundation-family import, a returning `func`, a typed binding, or
  // a guard statement — none of which read as anything else here.
  {
    extension: 'swift',
    matches: (t) =>
      /^\s*import\s+(?:Foundation|SwiftUI|UIKit|Combine)\b/m.test(t),
  },
  {
    extension: 'swift',
    matches: (t) =>
      /\bfunc\s+\w+\s*\([^)]*\)\s*(?:async\s+|throws\s+)*->\s*\[?\w/.test(t),
  },
  {
    extension: 'swift',
    matches: (t) =>
      /\b(?:let|var)\s+\w+\s*:\s*(?:Int|Double|Float|Bool|String|Character|\[)/.test(
        t,
      ),
  },
  { extension: 'swift', matches: (t) => /^\s*guard\s+.*\belse\s*\{/m.test(t) },
  {
    extension: 'ts',
    matches: (t) =>
      /^\s*import\s.*\sfrom\s/m.test(t) || /^\s*export\s/m.test(t),
  },
  {
    extension: 'ts',
    matches: (t) => /=>/.test(t) && /:\s*(?:string|number|boolean)\b/.test(t),
  },
  {
    extension: 'py',
    matches: (t) =>
      /^\s*def\s+\w+\s*\(/m.test(t) ||
      /^\s*(?:import\s+os|from\s+\S+\s+import)\b/m.test(t),
  },
  { extension: 'py', matches: (t) => /^\s+print\(/m.test(t) },
  {
    extension: 'js',
    matches: (t) =>
      /^\s*(?:function\s+\w+|const\s+\w+|let\s+\w+|var\s+\w+)/m.test(t) ||
      /\brequire\(/.test(t),
  },
];

/**
 * The extension the code itself implies, when nothing names the file. Crude on
 * purpose: this only has to beat "txt", and a wrong grammar colours a few
 * keywords oddly rather than breaking anything.
 */
export function extensionFromContent(code: string): string | null {
  const text = code.slice(0, CONTENT_SAMPLE_CHARS);
  return CONTENT_RULES.find((rule) => rule.matches(text))?.extension ?? null;
}
