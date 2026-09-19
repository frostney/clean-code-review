'use client';

import { useEffect, useState } from 'react';

import { DARK_QUERY, type Theme } from './theme';

function currentTheme(): Theme {
  const chosen = document.documentElement.dataset.theme;
  if (chosen === 'dark' || chosen === 'light') {
    return chosen;
  }
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

/**
 * For shiki, whose tokens are inline styles CSS cannot re-colour. Starts at
 * "light" to match the server; nothing is highlighted before the effect runs.
 */
export function useTheme(): Theme {
  const [theme, setTheme] = useState<Theme>('light');

  useEffect(() => {
    function sync() {
      setTheme(currentTheme());
    }
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributeFilter: ['data-theme'],
      attributes: true,
    });
    const media = window.matchMedia(DARK_QUERY);
    media.addEventListener('change', sync);
    return () => {
      observer.disconnect();
      media.removeEventListener('change', sync);
    };
  }, []);

  return theme;
}
