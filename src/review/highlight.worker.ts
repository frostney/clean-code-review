/// <reference lib="webworker" />

import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

import type { HighlightReply, HighlightRequest, Token } from './highlight';

/**
 * Where the page's code is coloured: off the main thread, one file per
 * message, so a fifty-file pull request is fifty short tasks here rather than
 * one long one in front of the reader's scroll.
 *
 * The JavaScript regex engine rather than the Oniguruma one. Measured on real
 * pull requests in a worker at a phone's CPU, it is as fast or faster on the
 * first pass — which is the only pass most files get — and it has no WASM to
 * fetch: Oniguruma's is 230 KB gzipped, a second and more on a slow phone
 * connection before the first card could be coloured.
 *
 * It starts with no grammars at all: a review is written in one or two
 * languages, and shiki ships more than two hundred.
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
  return ready;
}

/** Grammars already fetched or in flight, so ten cards of one language fetch once. */
const grammars = new Map<string, Promise<void>>();

/**
 * Make `lang` safe to tokenise with. "text" is shiki's own no-op grammar and
 * is always there; everything else is fetched on first use and kept.
 *
 * Shiki's registry is imported here, on first use, rather than at the top:
 * it is a loader for every grammar shiki bundles, which is what lets the
 * bundler give each grammar a chunk of its own and this fetch only the ones a
 * review is written in.
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
    // A grammar that failed to arrive should be retried by the next card
    // that needs it, not remembered as a permanently broken language.
    pending.catch(() => grammars.delete(lang));
    grammars.set(lang, pending);
  }
  return pending;
}

/**
 * Only what a line is drawn with crosses back: the text and its colour. Shiki's
 * offsets and font styles are never rendered, and every field left behind is
 * one fewer to copy for a file of several thousand tokens.
 */
async function tokenise({
  code,
  lang,
  theme,
}: HighlightRequest): Promise<Token[][]> {
  const shiki = await highlighter();
  await loadLanguage(shiki, lang);
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
  tokenise(request).then(
    (lines) => {
      const reply: HighlightReply = { id: request.id, lines };
      self.postMessage(reply);
    },
    () => {
      // A grammar that will not load is not worth a broken card.
      const reply: HighlightReply = { id: request.id, lines: null };
      self.postMessage(reply);
    },
  );
});
