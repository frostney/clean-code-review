'use client';

import { Component, type ReactNode } from 'react';

interface Place {
  card: Element;
  top: number;
}

/** The first card whose top is on screen, else the one filling the screen. */
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
 * A placeholder's height is an estimate, so a card drawn above the reader can
 * shift everything below. Browser scroll anchoring can pick the sticky file
 * list, which never moves, so this scrolls by however far the reader's card
 * moved (zero when the browser already anchored correctly).
 *
 * A class for `getSnapshotBeforeUpdate`, which reads the page after React
 * decides what to draw and before the DOM changes. Only changes to `drawn` are
 * measured.
 */
// biome-ignore lint/style/useReactFunctionComponents: getSnapshotBeforeUpdate — reading the page between React's decision and its DOM changes — has no hook equivalent.
export class KeepPlace extends Component<
  {
    /** Compared by identity. */
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
