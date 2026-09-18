'use client';

import { Component, type ReactNode } from 'react';

/** Where the card the reader's place is kept by stood, just before a draw. */
interface Place {
  card: Element;
  top: number;
}

/**
 * The card that says where the reader is: the first one whose top is on
 * screen, or, when one card fills the whole screen, that card. Whatever is
 * drawn above it may change height; it must not appear to move.
 */
function placeOf(column: Element): Place | null {
  let straddling: Place | null = null;
  for (const card of column.children) {
    const { top, bottom } = card.getBoundingClientRect();
    if (top >= 0) {
      return { card, top };
    }
    if (bottom > 0) {
      straddling = { card, top };
    }
  }
  return straddling;
}

/**
 * Keeps the reader where they are when cards above them are drawn.
 *
 * An undrawn card holds a space for its body, and the space is an estimate:
 * a card drawn above the reader — the ones around a card jumped to from the
 * file list, or the next one up when scrolling back — can come out a little
 * taller or shorter, and everything below it would move by the difference.
 * The browser's own scroll anchoring does not always catch it: it can anchor
 * on the sticky file list, which never moves. So the page is scrolled by
 * whatever the card the reader is on moved, and where the browser did keep
 * the place itself that is nothing.
 *
 * A class, because the one moment this needs is a lifecycle method with no
 * hook: `getSnapshotBeforeUpdate` reads the page after React has decided what
 * to draw and before it has changed a thing. Only a change to which cards are
 * drawn is measured; every other update passes straight through.
 */
// biome-ignore lint/style/useReactFunctionComponents: getSnapshotBeforeUpdate — reading the page between React's decision and its DOM changes — has no hook equivalent.
export class KeepPlace extends Component<
  {
    /** Which cards are drawn; a new value is a draw to keep the place across. */
    drawn: unknown;
    children: ReactNode;
    className: string;
  },
  object,
  Place | null
> {
  private column: HTMLDivElement | null = null;

  private readonly setColumn = (element: HTMLDivElement | null) => {
    this.column = element;
  };

  getSnapshotBeforeUpdate(previous: Readonly<{ drawn: unknown }>) {
    if (previous.drawn === this.props.drawn || !this.column) {
      return null;
    }
    return placeOf(this.column);
  }

  componentDidUpdate(_previous: unknown, _state: unknown, place: Place | null) {
    if (!place?.card.isConnected) {
      return;
    }
    const moved = place.card.getBoundingClientRect().top - place.top;
    if (Math.abs(moved) >= 1) {
      window.scrollBy(0, moved);
    }
  }

  render() {
    return (
      <div className={this.props.className} ref={this.setColumn}>
        {this.props.children}
      </div>
    );
  }
}
