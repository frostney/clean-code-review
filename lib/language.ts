import { type BundledLanguage, bundledLanguagesInfo } from 'shiki/langs';

/**
 * What language a file is written in, named the way shiki names it.
 *
 * The grammars are shiki's whole bundled registry — every language it ships,
 * fetched on first use in `lib/highlight.ts` — so nothing here is a list of
 * languages we support. What is written down is the one thing shiki does not
 * know: which file extension means which of its languages. "text" is shiki's
 * own no-op grammar and the answer whenever nothing places a file, so an
 * unknown extension renders as plain monospace rather than as the wrong
 * language.
 */
export type Lang = BundledLanguage | 'text';

/** Every id and alias shiki ships, pointing at the name it prints for itself. */
const NAME_BY_ID = new Map<string, string>(
  bundledLanguagesInfo.flatMap((info) => [
    [info.id, info.name] as [string, string],
    ...(info.aliases ?? []).map((alias): [string, string] => [
      alias,
      info.name,
    ]),
  ]),
);

/** A language's own alternative names, for the fence names derived below. */
const ALIASES_BY_ID = new Map<string, readonly string[]>(
  bundledLanguagesInfo.map((info) => [info.id, info.aliases ?? []]),
);

/**
 * Extension → language. The list is what a code review realistically meets
 * rather than everything shiki can colour: a grammar nothing here points at is
 * still in the registry, it just needs a file named for it to be reached.
 */
const BY_EXTENSION: Record<string, Lang> = {
  astro: 'astro',
  bash: 'shellscript',
  bat: 'bat',
  c: 'c',
  cc: 'cpp',
  cjs: 'javascript',
  clj: 'clojure',
  cljs: 'clojure',
  cmake: 'cmake',
  cmd: 'bat',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  cts: 'typescript',
  cxx: 'cpp',
  dart: 'dart',
  diff: 'diff',
  dockerfile: 'docker',
  elm: 'elm',
  erl: 'erlang',
  ex: 'elixir',
  exs: 'elixir',
  fish: 'fish',
  fs: 'fsharp',
  fsi: 'fsharp',
  fsx: 'fsharp',
  go: 'go',
  gql: 'graphql',
  gradle: 'groovy',
  graphql: 'graphql',
  groovy: 'groovy',
  h: 'c',
  hcl: 'hcl',
  hh: 'cpp',
  hpp: 'cpp',
  hrl: 'erlang',
  hs: 'haskell',
  html: 'html',
  ini: 'ini',
  java: 'java',
  jl: 'julia',
  js: 'javascript',
  json: 'json',
  json5: 'json5',
  jsonc: 'jsonc',
  jsx: 'jsx',
  kt: 'kotlin',
  kts: 'kotlin',
  less: 'less',
  lua: 'lua',
  m: 'objective-c',
  makefile: 'make',
  markdown: 'markdown',
  md: 'markdown',
  mdx: 'mdx',
  mjs: 'javascript',
  mk: 'make',
  ml: 'ocaml',
  mli: 'ocaml',
  mm: 'objective-cpp',
  mts: 'typescript',
  nim: 'nim',
  nix: 'nix',
  patch: 'diff',
  php: 'php',
  pl: 'perl',
  pm: 'perl',
  proto: 'proto',
  ps1: 'powershell',
  psm1: 'powershell',
  py: 'python',
  pyi: 'python',
  r: 'r',
  rb: 'ruby',
  rs: 'rust',
  sass: 'sass',
  scala: 'scala',
  scss: 'scss',
  sh: 'shellscript',
  sol: 'solidity',
  sql: 'sql',
  svelte: 'svelte',
  swift: 'swift',
  tf: 'terraform',
  tfvars: 'terraform',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  vue: 'vue',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zig: 'zig',
  zsh: 'shellscript',
};

/**
 * The files a repository names rather than extends. `Dockerfile` and
 * `Makefile` carry no extension at all, and both turn up in almost every
 * change that touches how a project is built.
 */
const BY_FILENAME: Record<string, Lang> = {
  dockerfile: 'docker',
  gnumakefile: 'make',
  makefile: 'make',
};

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

export function langOf(path: string): Lang {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  return BY_EXTENSION[extensionOf(path)] ?? BY_FILENAME[base] ?? 'text';
}

/** What the chip on a file header says: shiki's own name for the grammar. */
export function langLabel(lang: Lang): string {
  return lang === 'text' ? 'Text' : (NAME_BY_ID.get(lang) ?? 'Text');
}

/** `src/billing/refund.ts` → `["src/billing/", "refund.ts"]`, for the two-tone path. */
export function splitPath(path: string): [string, string] {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? ['', path] : [path.slice(0, cut + 1), path.slice(cut + 1)];
}

/** The shortest of a language's extensions, alphabetical between equals. */
function shortestExtension(extensions: readonly string[]): string {
  return extensions.reduce((best, extension) =>
    extension.length < best.length ||
    (extension.length === best.length && extension < best)
      ? extension
      : best,
  );
}

/**
 * Fence name → the extension a paste of that language is named after.
 *
 * Derived from the table above and shiki's own aliases rather than written a
 * second time: ```` ```c++ ```` places a paste because `cpp` is in the table
 * and `c++` is what shiki calls it, and a language added to the table is a
 * fence name the same day.
 */
function fenceExtensions(): Record<string, string> {
  const byLang = new Map<Lang, string[]>();
  for (const [extension, lang] of Object.entries(BY_EXTENSION)) {
    const known = byLang.get(lang);
    if (known) {
      known.push(extension);
    } else {
      byLang.set(lang, [extension]);
    }
  }
  const names: Record<string, string> = {};
  for (const [lang, extensions] of byLang) {
    const extension = shortestExtension(extensions);
    for (const name of [
      lang,
      ...(ALIASES_BY_ID.get(lang) ?? []),
      ...extensions,
    ]) {
      names[name] = extension;
    }
  }
  // The one fence name shiki does not carry as an alias of its own.
  names.golang = 'go';
  return names;
}

const EXTENSION_BY_FENCE = fenceExtensions();

/** The extension a fence or shebang on the first line implies, if any. */
export function extensionFromHint(firstLine: string): string | null {
  const line = firstLine.trim();
  const fence = /^```+\s*([A-Za-z0-9+#-]+)\s*$/.exec(line);
  if (fence) {
    return EXTENSION_BY_FENCE[fence[1].toLowerCase()] ?? null;
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
