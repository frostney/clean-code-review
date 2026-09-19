import type { BundledLanguage } from 'shiki/langs';

import { isProsePath } from '@/agent/lib/review/review';

/** "text" is shiki's no-op grammar, used when nothing places a file. */
export type Lang = BundledLanguage | 'text';

/**
 * Copied from shiki's `bundledLanguagesInfo` rather than imported: that module
 * carries a loader for all 200+ grammars and would put them in every page's
 * bundle. Keyed by shiki's ids so a dropped language is a type error;
 * `language.test.ts` checks names and aliases against the registry.
 */
export const SHIKI_NAMES = {
  astro: {
    aliases: [],
    name: 'Astro',
  },
  bat: {
    aliases: ['batch', 'cmd'],
    name: 'Batch File',
  },
  c: {
    aliases: [],
    name: 'C',
  },
  clojure: {
    aliases: ['clj'],
    name: 'Clojure',
  },
  cmake: {
    aliases: [],
    name: 'CMake',
  },
  cpp: {
    aliases: ['c++'],
    name: 'C++',
  },
  csharp: {
    aliases: ['c#', 'cs'],
    name: 'C#',
  },
  css: {
    aliases: [],
    name: 'CSS',
  },
  dart: {
    aliases: [],
    name: 'Dart',
  },
  diff: {
    aliases: [],
    name: 'Diff',
  },
  docker: {
    aliases: ['dockerfile'],
    name: 'Dockerfile',
  },
  elixir: {
    aliases: [],
    name: 'Elixir',
  },
  elm: {
    aliases: [],
    name: 'Elm',
  },
  erlang: {
    aliases: ['erl'],
    name: 'Erlang',
  },
  fish: {
    aliases: [],
    name: 'Fish',
  },
  fsharp: {
    aliases: ['f#', 'fs'],
    name: 'F#',
  },
  go: {
    aliases: [],
    name: 'Go',
  },
  graphql: {
    aliases: ['gql'],
    name: 'GraphQL',
  },
  groovy: {
    aliases: [],
    name: 'Groovy',
  },
  haskell: {
    aliases: ['hs'],
    name: 'Haskell',
  },
  hcl: {
    aliases: [],
    name: 'HashiCorp HCL',
  },
  html: {
    aliases: [],
    name: 'HTML',
  },
  ini: {
    aliases: ['properties'],
    name: 'INI',
  },
  java: {
    aliases: [],
    name: 'Java',
  },
  javascript: {
    aliases: ['js', 'cjs', 'mjs'],
    name: 'JavaScript',
  },
  json: {
    aliases: [],
    name: 'JSON',
  },
  json5: {
    aliases: [],
    name: 'JSON5',
  },
  jsonc: {
    aliases: [],
    name: 'JSON with Comments',
  },
  jsx: {
    aliases: [],
    name: 'JSX',
  },
  julia: {
    aliases: ['jl'],
    name: 'Julia',
  },
  kotlin: {
    aliases: ['kt', 'kts'],
    name: 'Kotlin',
  },
  less: {
    aliases: [],
    name: 'Less',
  },
  lua: {
    aliases: [],
    name: 'Lua',
  },
  make: {
    aliases: ['makefile'],
    name: 'Makefile',
  },
  markdown: {
    aliases: ['md'],
    name: 'Markdown',
  },
  mdx: {
    aliases: [],
    name: 'MDX',
  },
  nim: {
    aliases: [],
    name: 'Nim',
  },
  nix: {
    aliases: [],
    name: 'Nix',
  },
  'objective-c': {
    aliases: ['objc'],
    name: 'Objective-C',
  },
  'objective-cpp': {
    aliases: [],
    name: 'Objective-C++',
  },
  ocaml: {
    aliases: [],
    name: 'OCaml',
  },
  perl: {
    aliases: [],
    name: 'Perl',
  },
  php: {
    aliases: [],
    name: 'PHP',
  },
  powershell: {
    aliases: ['ps', 'ps1', 'pwsh'],
    name: 'PowerShell',
  },
  proto: {
    aliases: ['protobuf'],
    name: 'Protocol Buffer 3',
  },
  python: {
    aliases: ['py'],
    name: 'Python',
  },
  r: {
    aliases: [],
    name: 'R',
  },
  ruby: {
    aliases: ['rb'],
    name: 'Ruby',
  },
  rust: {
    aliases: ['rs'],
    name: 'Rust',
  },
  sass: {
    aliases: [],
    name: 'Sass',
  },
  scala: {
    aliases: [],
    name: 'Scala',
  },
  scss: {
    aliases: [],
    name: 'SCSS',
  },
  shellscript: {
    aliases: ['bash', 'sh', 'shell', 'zsh'],
    name: 'Shell',
  },
  solidity: {
    aliases: [],
    name: 'Solidity',
  },
  sql: {
    aliases: [],
    name: 'SQL',
  },
  svelte: {
    aliases: [],
    name: 'Svelte',
  },
  swift: {
    aliases: [],
    name: 'Swift',
  },
  terraform: {
    aliases: ['tf', 'tfvars'],
    name: 'Terraform',
  },
  toml: {
    aliases: [],
    name: 'TOML',
  },
  tsx: {
    aliases: [],
    name: 'TSX',
  },
  typescript: {
    aliases: ['ts', 'cts', 'mts'],
    name: 'TypeScript',
  },
  vue: {
    aliases: [],
    name: 'Vue',
  },
  xml: {
    aliases: [],
    name: 'XML',
  },
  yaml: {
    aliases: ['yml'],
    name: 'YAML',
  },
  zig: {
    aliases: [],
    name: 'Zig',
  },
} as const satisfies Partial<
  Record<BundledLanguage, { aliases: readonly string[]; name: string }>
>;

type KnownLang = keyof typeof SHIKI_NAMES;

/** Ids and aliases → display name. */
const NAME_BY_ID = new Map<string, string>(
  Object.entries(SHIKI_NAMES).flatMap(([id, info]) => [
    [id, info.name] as [string, string],
    ...info.aliases.map((alias: string): [string, string] => [
      alias,
      info.name,
    ]),
  ]),
);

const ALIASES_BY_ID = new Map<string, readonly string[]>(
  Object.entries(SHIKI_NAMES).map(([id, info]) => [id, info.aliases]),
);

// What a code review realistically meets, not everything shiki can colour.
const BY_EXTENSION: Record<string, KnownLang> = {
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

// Lower-cased basenames of files that have no extension.
const BY_FILENAME: Record<string, KnownLang> = {
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

export function langLabel(lang: Lang): string {
  return lang === 'text' ? 'Text' : (NAME_BY_ID.get(lang) ?? 'Text');
}

/** `src/billing/refund.ts` → `["src/billing/", "refund.ts"]`. */
export function splitPath(path: string): [string, string] {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? ['', path] : [path.slice(0, cut + 1), path.slice(cut + 1)];
}

/** Ties break alphabetically. */
function shortestExtension(extensions: readonly string[]): string {
  return extensions.reduce((best, extension) =>
    extension.length < best.length ||
    (extension.length === best.length && extension < best)
      ? extension
      : best,
  );
}

/**
 * Fence name → extension, derived from `BY_EXTENSION` and shiki's aliases so a
 * language added to the table is a fence name too (```` ```c++ ```` works via
 * `cpp`'s alias).
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
  // Not a shiki alias.
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
  // e.g. `// src/thing.ts`. Prose names are ignored: `// README.md — usage`
  // above code is about the README, and would make the paste unjudged.
  const named = /^(?:\/\/|#|\/\*)\s*\S*?\.([A-Za-z0-9]+)\b/.exec(line);
  if (named) {
    const extension = named[1].toLowerCase();
    if (BY_EXTENSION[extension] && !isProsePath(`x.${extension}`)) {
      return extension;
    }
  }
  return null;
}

/** The opening of a file is enough to place it. */
const CONTENT_SAMPLE_CHARS = 4_000;

/**
 * Order matters, most specific first: `const` and `=>` are shared, so
 * TypeScript must be ruled in before JavaScript, and PHP and Swift before the
 * JavaScript rules would read `function name($a)` or `let x: Int` as JS.
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
  { extension: 'php', matches: (t) => /<\?php\b/.test(t) },
  {
    extension: 'php',
    matches: (t) =>
      /\$\w+/.test(t) &&
      (/->\s*\w/.test(t) || /\bfunction\s+\w+\s*\([^)]*\$/.test(t)),
  },
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
 * Crude on purpose: it only has to beat "txt", and a wrong grammar only
 * colours a few keywords oddly.
 */
export function extensionFromContent(code: string): string | null {
  const text = code.slice(0, CONTENT_SAMPLE_CHARS);
  return CONTENT_RULES.find((rule) => rule.matches(text))?.extension ?? null;
}
