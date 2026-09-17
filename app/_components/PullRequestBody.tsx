"use client";

import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * A pull request's description, as GitHub renders it: headings, lists, task
 * lists, tables, code and links. It is the author's own writing and the only
 * prose on the page neither model wrote, so it reads as a description under the
 * title rather than as a block of the review — 13px, muted, and folded to about
 * a dozen lines with a toggle, because a long description would otherwise push
 * the whole review off the screen.
 *
 * Raw HTML stays off: `rehype-raw` is not installed and react-markdown escapes
 * what it finds, so a `<script>` or an `<img onerror>` in a description from a
 * repository nobody here controls is text on the page and nothing else.
 */
export function PullRequestBody({ body }: { body: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-1 max-w-[80ch] min-w-0">
      <div
        data-pr-body={open ? "open" : "clamped"}
        className={`markdown text-[13px] leading-relaxed text-muted ${open ? "" : "max-h-[16rem] overflow-hidden"}`}
      >
        <Markdown
          remarkPlugins={[remarkGfm]}
          components={{
            // Someone else's repository wrote these: a new tab, and no window
            // handle back to this one.
            a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
          }}
        >
          {body}
        </Markdown>
      </div>
      <button
        type="button"
        data-pr-body-toggle
        onClick={() => setOpen((shown) => !shown)}
        className="mt-1 cursor-pointer text-[12px] text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
      >
        {open ? "Show less" : "Show more"}
      </button>
    </div>
  );
}
