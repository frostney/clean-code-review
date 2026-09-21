/// <reference lib="webworker" />

import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

import type { HighlightReply, HighlightRequest, Token } from './highlight';

/**
 * JavaScript regex engine, not Oniguruma: measured on real pull requests at
 * phone CPU it is as fast or faster on the first pass (the only one most files
 * get), and it avoids Oniguruma's 230 KB gzipped WASM, over a second on a slow
 * phone connection. No grammars preloaded: a review uses one or two of shiki's
 * 200+.
 */
let ready: Promise<HighlighterCore> | null = null;

function highlighter(): Promise<HighlighterCore> {
  ready ??= createHighlighterCore({
    engine: createJavaScriptRegexEngine(),
    langs: [],
    themes: [
      import('shiki/themes/github-light.mjs'),
      import('shiki/themes/github-dark.mjs'),
    ],
  });
  // Do not cache a failed start (e.g. a theme chunk that did not arrive).
  ready.catch(() => {
    ready = null;
  });

  return ready;
}

/** Fetched or in flight, so cards sharing a language fetch it once. */
const grammars = new Map<string, Promise<void>>();

/**
 * "text" is shiki's built-in no-op grammar. The registry is imported lazily so
 * the bundler splits each grammar into its own chunk and only the ones a
 * review uses are fetched.
 */
function loadLanguage(shiki: HighlighterCore, lang: string): Promise<void> {
  if (lang === 'text') {
    return Promise.resolve();
  }
  let pending = grammars.get(lang);

  if (!pending) {
    pending = (async () => {
      const { bundledLanguages } = await import('shiki/langs');
      const grammar = bundledLanguages[lang as keyof typeof bundledLanguages];

      if (grammar) {
        await shiki.loadLanguage(grammar());
      }
    })();
    // Not cached on failure: the next file in this language fetches it again.
    // The file that failed stays plain.
    pending.catch(() => grammars.delete(lang));
    grammars.set(lang, pending);
  }

  return pending;
}

// Only text and colour are rendered, so only they are copied back; a file can
// have thousands of tokens.
async function tokenise({
  code,
  id,
  lang,
  theme,
}: HighlightRequest): Promise<Token[][]> {
  const shiki = await highlighter();

  await loadLanguage(shiki, lang);
  // Loading is done; the page times what follows (see FILE_TIMEOUT_MS).
  const started: HighlightReply = { id, tokenising: true };

  self.postMessage(started);
  const { tokens } = shiki.codeToTokens(code, { lang, theme });

  return tokens.map((line) =>
    line.map((token) =>
      token.color
        ? { color: token.color, content: token.content }
        : { content: token.content },
    ),
  );
}

self.addEventListener('message', (event: MessageEvent<HighlightRequest>) => {
  const request = event.data;

  // Shiki would not start: the page replaces the worker and requeues the file.
  highlighter().then(
    () => answer(request),
    () => {
      const reply: HighlightReply = { id: request.id, unavailable: true };

      self.postMessage(reply);
    },
  );
});

function answer(request: HighlightRequest) {
  tokenise(request).then(
    (lines) => {
      const reply: HighlightReply = { id: request.id, lines };

      self.postMessage(reply);
    },
    () => {
      // The grammar would not load, or shiki threw: the page leaves it plain.
      const reply: HighlightReply = { id: request.id, lines: null };

      self.postMessage(reply);
    },
  );
}
