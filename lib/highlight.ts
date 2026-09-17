'use client';

import { useEffect, useState } from 'react';
import type { HighlighterCore, LanguageInput, ThemedToken } from 'shiki/types';

import type { Lang } from './language';
import type { Theme } from './theme';
import { useTheme } from './useTheme';

/**
 * One theme per paper, and no third: the page is a review, not a colour
 * scheme. Shiki writes its colours into inline `style` attributes, which is
 * the one part of the page a CSS variable cannot reach — so the theme has to
 * be chosen here and the code re-tokenised when it changes.
 */
const THEMES: Record<Theme, string> = {
  dark: 'github-dark',
  light: 'github-light',
};

/**
 * One highlighter for the whole page, built once, lazily, in the browser.
 *
 * The JavaScript regex engine rather than the Oniguruma one: no WASM to fetch
 * or instantiate, which is what lets a card highlight itself the moment its
 * code appears. It starts with no grammars at all: a review is written in one
 * or two languages, and loading all thirteen would be most of a megabyte
 * fetched to colour a TypeScript diff.
 */
let ready: Promise<HighlighterCore> | null = null;

function highlighter(): Promise<HighlighterCore> {
  ready ??= (async () => {
    const [core, engine] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
    ]);
    return core.createHighlighterCore({
      engine: engine.createJavaScriptRegexEngine(),
      langs: [],
      themes: [
        import('shiki/themes/github-light.mjs'),
        import('shiki/themes/github-dark.mjs'),
      ],
    });
  })();
  return ready;
}

/**
 * One dynamic import per grammar, so only the ones on screen are fetched.
 * Partial: a language the page names but cannot colour (PHP, Swift) has no
 * entry and is tokenised as plain text instead.
 */
const GRAMMARS: Partial<Record<Lang, () => LanguageInput>> = {
  bash: () => import('shiki/langs/bash.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
};

/** Grammars already fetched or in flight, so ten cards of one language fetch once. */
const grammars = new Map<Lang, Promise<void>>();

/** The grammar a language is tokenised with: "text" when it has none. */
function grammarOf(lang: Lang): Lang {
  return GRAMMARS[lang] ? lang : 'text';
}

/**
 * Make `lang` safe to tokenise with. "text" is shiki's own no-op grammar and
 * is always there; everything else is fetched on first use and kept.
 */
function loadLanguage(lang: Lang): Promise<void> {
  const grammar = GRAMMARS[lang];
  if (!grammar) {
    return Promise.resolve();
  }
  let pending = grammars.get(lang);
  if (!pending) {
    pending = (async () => {
      const shiki = await highlighter();
      await shiki.loadLanguage(grammar());
    })();
    // A grammar that failed to arrive should be retried by the next card
    // that needs it, not remembered as a permanently broken language.
    pending.catch(() => grammars.delete(lang));
    grammars.set(lang, pending);
  }
  return pending;
}

/** One line of highlighted code: the tokens shiki produced for it. */
export type TokenLine = readonly ThemedToken[];

/** Every line as one plain token — what a card shows before the grammars land. */
function plainLines(code: string): TokenLine[] {
  return code
    .split('\n')
    .map((line) => (line ? [{ content: line, offset: 0 }] : []));
}

/**
 * Tokenise `code` as `lang`. Returns plain lines until the highlighter and
 * this language's grammar are both there, so a card never renders empty and
 * never blocks on a grammar that is still being fetched.
 *
 * `debounceMs` is for the editor: re-tokenising on every keystroke is what
 * makes an overlay editor feel heavy, and 50 ms is below the threshold where
 * the colours look like they lag the caret.
 *
 * The active theme is a dependency like the code is: switching the page to
 * dark re-tokenises every card, because shiki's colours are inline styles and
 * nothing else can repaint them.
 */
export function useTokens(
  code: string,
  lang: Lang,
  debounceMs = 0,
): TokenLine[] {
  const [lines, setLines] = useState<TokenLine[] | null>(null);
  const [forCode, setForCode] = useState<string | null>(null);
  const theme = useTheme();

  useEffect(() => {
    let live = true;
    async function run() {
      try {
        const shiki = await highlighter();
        await loadLanguage(lang);
        if (!live) {
          return;
        }
        const result = shiki.codeToTokens(code, {
          lang: grammarOf(lang),
          theme: THEMES[theme],
        });
        if (!live) {
          return;
        }
        setLines(result.tokens);
        setForCode(code);
      } catch {
        // A grammar that will not load is not worth a broken card.
        if (live) {
          setLines(null);
          setForCode(code);
        }
      }
    }
    /** `run` puts its own failures on the card, so nothing here can reject. */
    const start = () => {
      run().catch(() => {
        /* Already handled inside `run`. */
      });
    };
    if (debounceMs <= 0) {
      start();
      return () => {
        live = false;
      };
    }
    const timer = setTimeout(start, debounceMs);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [code, lang, debounceMs, theme]);

  // Between a keystroke and the next tokenisation the highlighted layer would
  // otherwise show the previous text under the caret. Plain lines for the new
  // text are wrong in colour for a few frames; stale text is wrong in content.
  return lines && forCode === code ? lines : plainLines(code);
}
