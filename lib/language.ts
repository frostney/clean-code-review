/**
 * The languages the page can highlight, keyed the way shiki names them.
 * "text" is shiki's own no-op grammar: anything we cannot place renders as
 * plain monospace rather than as the wrong language.
 */
export const LANGS = [
  "typescript",
  "javascript",
  "tsx",
  "python",
  "java",
  "go",
  "rust",
  "json",
  "yaml",
  "css",
  "html",
  "diff",
  "bash",
] as const;

/**
 * Languages the page recognises and names, but does not colour: shiki's
 * JavaScript regex engine has no grammar loaded for them, so they render as
 * plain monospace. Naming one is still worth it — the chip says PHP rather
 * than Text, and a paste of one is recognised as code rather than prose.
 */
export const PLAIN_LANGS = ["php", "swift"] as const;

export type Lang = (typeof LANGS)[number] | (typeof PLAIN_LANGS)[number] | "text";

const BY_EXTENSION: Record<string, Lang> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "tsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  java: "java",
  go: "go",
  rs: "rust",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  css: "css",
  html: "html",
  sh: "bash",
  patch: "diff",
  diff: "diff",
  // Code the highlighter has no grammar for. They are here so a path like
  // `main.c` is recognised as a file rather than read as prose, and so a paste
  // of one is named after its language; "text" is deliberate — a lie about the
  // grammar would also be a lie on the chip, and plain monospace is neither.
  c: "text",
  h: "text",
  cpp: "text",
  hpp: "text",
  cs: "text",
  php: "php",
  kt: "text",
  swift: "swift",
  rb: "text",
  sql: "text",
  scala: "text",
  dart: "text",
  lua: "text",
  r: "text",
  m: "text",
  ex: "text",
  exs: "text",
  clj: "text",
  hs: "text",
  zig: "text",
};

/** What the chip on a file header says. */
const LABELS: Record<Lang, string> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  tsx: "TSX",
  python: "Python",
  java: "Java",
  go: "Go",
  rust: "Rust",
  json: "JSON",
  yaml: "YAML",
  css: "CSS",
  html: "HTML",
  diff: "Diff",
  bash: "Shell",
  php: "PHP",
  swift: "Swift",
  text: "Text",
};

export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

export function langOf(path: string): Lang {
  return BY_EXTENSION[extensionOf(path)] ?? "text";
}

export function langLabel(lang: Lang): string {
  return LABELS[lang];
}

/** `src/billing/refund.ts` → `["src/billing/", "refund.ts"]`, for the two-tone path. */
export function splitPath(path: string): [string, string] {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? ["", path] : [path.slice(0, cut + 1), path.slice(cut + 1)];
}

/** The extension a fence or shebang on the first line implies, if any. */
export function extensionFromHint(firstLine: string): string | null {
  const line = firstLine.trim();
  const fence = /^```+\s*([A-Za-z0-9+#-]+)\s*$/.exec(line);
  if (fence) {
    const named = fence[1].toLowerCase();
    const byName: Record<string, string> = {
      ts: "ts",
      typescript: "ts",
      tsx: "tsx",
      js: "js",
      javascript: "js",
      jsx: "jsx",
      py: "py",
      python: "py",
      java: "java",
      go: "go",
      golang: "go",
      rs: "rs",
      rust: "rs",
      json: "json",
      yml: "yml",
      yaml: "yml",
      css: "css",
      html: "html",
      sh: "sh",
      bash: "sh",
      shell: "sh",
      php: "php",
      swift: "swift",
    };
    return byName[named] ?? null;
  }
  if (/^#!.*\bpython[0-9.]*\b/.test(line)) return "py";
  if (/^#!.*\bnode\b/.test(line)) return "js";
  if (/^#!.*\b(ba|z|k)?sh\b/.test(line)) return "sh";
  // A first-line comment that names a file: `// src/thing.ts`, `# thing.py`.
  const named = /^(?:\/\/|#|\/\*)\s*\S*?\.([A-Za-z0-9]+)\b/.exec(line);
  if (named && BY_EXTENSION[named[1].toLowerCase()]) return named[1].toLowerCase();
  return null;
}

/**
 * The extension the code itself implies, when nothing names the file. Crude on
 * purpose: this only has to beat "txt", and a wrong grammar colours a few
 * keywords oddly rather than breaking anything.
 *
 * Most-specific first — Go, Rust and Java have keywords nothing else uses,
 * while `const` and `=>` are shared, so TypeScript has to be ruled in (types,
 * `import … from`) before JavaScript is the answer. PHP and Swift are ruled in
 * ahead of the JavaScript rules for the same reason: `function name($a)` and
 * `let x: Int` would otherwise be read as a `function`/`let` declaration.
 */
export function extensionFromContent(code: string): string | null {
  // The opening of a file is what places it; a whole paste is needless work.
  const text = code.slice(0, 4_000);
  if (/^\s*package\s+\w+/m.test(text) && /\bfunc\s/.test(text)) return "go";
  if (/\bfn\s+\w+\s*[(<]/.test(text) && (/\blet\s+mut\b/.test(text) || /\bimpl\s/.test(text))) return "rs";
  if (/\bpublic\s+(?:final\s+|abstract\s+)?class\b/.test(text) || /\bSystem\.out\b/.test(text)) return "java";
  // PHP: the open tag settles it; otherwise `$variables` plus `->` or a
  // function whose parameters are variables.
  if (/<\?php\b/.test(text)) return "php";
  if (/\$\w+/.test(text) && (/->\s*\w/.test(text) || /\bfunction\s+\w+\s*\([^)]*\$/.test(text))) return "php";
  // Swift: a Foundation-family import, a returning `func`, a typed binding, or
  // a guard statement — none of which read as anything else here.
  if (/^\s*import\s+(?:Foundation|SwiftUI|UIKit|Combine)\b/m.test(text)) return "swift";
  if (/\bfunc\s+\w+\s*\([^)]*\)\s*(?:async\s+|throws\s+)*->\s*\[?\w/.test(text)) return "swift";
  if (/\b(?:let|var)\s+\w+\s*:\s*(?:Int|Double|Float|Bool|String|Character|\[)/.test(text)) return "swift";
  if (/^\s*guard\s+.*\belse\s*\{/m.test(text)) return "swift";
  if (/^\s*import\s.*\sfrom\s/m.test(text) || /^\s*export\s/m.test(text)) return "ts";
  if (/=>/.test(text) && /:\s*(?:string|number|boolean)\b/.test(text)) return "ts";
  if (/^\s*def\s+\w+\s*\(/m.test(text) || /^\s*(?:import\s+os|from\s+\S+\s+import)\b/m.test(text)) return "py";
  if (/^\s+print\(/m.test(text)) return "py";
  if (/^\s*(?:function\s+\w+|const\s+\w+|let\s+\w+|var\s+\w+)/m.test(text) || /\brequire\(/.test(text)) return "js";
  return null;
}
