'use client';

import { useEffect } from 'react';

type Direction = 'back' | 'forward';

function mark(direction: Direction | null): void {
  const root = document.documentElement;
  if (direction) {
    root.dataset.nav = direction;
    return;
  }
  delete root.dataset.nav;
}

/**
 * A plain left click, not one of the modifiers that opens another tab. Read
 * in the capture phase, so nothing has had the chance to cancel it yet and
 * there is no `defaultPrevented` worth asking about; a link the page cancels
 * leaves a direction that the next click clears.
 */
function opensHere(event: MouseEvent): boolean {
  if (event.button !== 0) {
    return false;
  }
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return false;
  }
  const target = event.target;
  const link = target instanceof Element ? target.closest('a[href]') : null;
  return (
    link instanceof HTMLAnchorElement &&
    link.origin === window.location.origin &&
    (link.target === '' || link.target === '_self')
  );
}

/**
 * Names the direction of travel on `<html>`, which is how the view transition
 * in `app/globals.css` knows which way to slide the page. Renders nothing.
 *
 * What reads it is the review opening and closing, the one transition the
 * page starts itself. A route change animates only its named parts, because
 * React holds the page's own snapshot at opacity 0 for the duration, and a
 * route Back or Forward animates nothing at all: Next dispatches the restore
 * outside a React transition on purpose, so no view transition begins.
 *
 * Two sources, because neither covers both cases. A link is always forward,
 * and the click is the last moment certain to come before React starts the
 * transition (measured: the router pushes its entry after the transition has
 * started), so it is read in the capture phase. Back and Forward carry no
 * direction of their own: only the Navigation API's entry index says which way
 * the reader travelled, and without it the name is cleared and the page
 * crossfades rather than sliding the wrong way.
 *
 * Any other click clears the name, so a review opened or closed with a button
 * is an in-place change with no direction. After a route change the name
 * stays until the next click or traversal, which is harmless: the only reader
 * is `landing/view-transition`, and it copies the distance once at the start
 * of a transition rather than following this attribute.
 */
export function NavigationDirection() {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      mark(opensHere(event) ? 'forward' : null);
    };
    const onNavigate = (event: NavigateEvent) => {
      // Only a traversal is read here. A push or a replace is the page
      // writing the address bar, which it does *after* starting its
      // transition (the review's permalink, the router's own correction), and
      // the direction is a custom property the running keyframes re-read: set
      // mid-flight it would snap the slide. A link is already forward from
      // its click.
      if (event.navigationType !== 'traverse') {
        return;
      }
      const from = window.navigation.currentEntry?.index ?? -1;
      const to = event.destination.index;
      if (from < 0 || to < 0) {
        mark(null);
        return;
      }
      mark(to < from ? 'back' : 'forward');
    };
    const onPopState = () => mark(null);

    const navigationApi: Navigation | undefined = window.navigation;
    document.addEventListener('click', onClick, true);
    if (navigationApi) {
      navigationApi.addEventListener('navigate', onNavigate);
    } else {
      window.addEventListener('popstate', onPopState);
    }
    return () => {
      document.removeEventListener('click', onClick, true);
      navigationApi?.removeEventListener('navigate', onNavigate);
      window.removeEventListener('popstate', onPopState);
    };
  }, []);

  return null;
}
