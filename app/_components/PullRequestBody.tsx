import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * A pull request's description, as GitHub renders it: headings, lists, task
 * lists, tables, code and links.
 *
 * It renders on the server — the `openPullRequest` action returns the finished
 * node — so the markdown pipeline never reaches the browser. The browser's
 * share is `PullRequestBodyToggle`, which folds this node and nothing more.
 *
 * Raw HTML stays off: `rehype-raw` is not installed and react-markdown escapes
 * what it finds, so a `<script>` or an `<img onerror>` in a description from a
 * repository nobody here controls is text on the page and nothing else.
 */
/** The part of a hast node this file reads and rewrites. */
interface HastNode {
  children?: HastNode[];
  properties?: Record<string, unknown>;
}

function walk(node: HastNode, visit: (node: HastNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) {
    walk(child, visit);
  }
}

/**
 * Ids and code-block classes, stripped of the author's words.
 *
 * GitHub-style footnotes get ids made from their labels (`[^rollout-plan]`
 * becomes `user-content-fn-rollout-plan`), and a fenced block's info string
 * becomes a `language-` class. Speed Insights describes the element a timing
 * concerns as a selector of ids and classes, so either would carry a phrase
 * from the description to Vercel. Ids are renumbered, with the links and
 * `aria-describedby` that point at them, and `language-` classes are dropped:
 * nothing here styles them.
 */
function rehypeNeutralIds() {
  return (tree: HastNode) => {
    const renamed = new Map<string, string>();
    walk(tree, (node) => {
      const id = node.properties?.id;
      if (typeof id === 'string' && !renamed.has(id)) {
        renamed.set(id, `pr-note-${renamed.size + 1}`);
      }
    });
    walk(tree, (node) => {
      if (node.properties) {
        neutralise(node.properties, renamed);
      }
    });
  };
}

function neutralise(
  props: Record<string, unknown>,
  renamed: ReadonlyMap<string, string>,
): void {
  const rename = (ref: unknown) =>
    typeof ref === 'string' ? (renamed.get(ref) ?? ref) : ref;
  if (typeof props.id === 'string') {
    props.id = rename(props.id);
  }
  if (typeof props.href === 'string' && props.href.startsWith('#')) {
    props.href = `#${rename(props.href.slice(1))}`;
  }
  if (Array.isArray(props.ariaDescribedBy)) {
    props.ariaDescribedBy = props.ariaDescribedBy.map(rename);
  }
  if (Array.isArray(props.className)) {
    props.className = props.className.filter(
      (name) => !(typeof name === 'string' && name.startsWith('language-')),
    );
  }
}

export function PullRequestBody({ body }: { body: string }) {
  return (
    <Markdown
      components={{
        // Someone else's repository wrote these: a new tab, and no window
        // handle back to this one. A footnote's `#` link stays on the page.
        a: ({ node: _node, ...props }) =>
          props.href?.startsWith('#') ? (
            <a {...props} />
          ) : (
            <a {...props} rel="noreferrer" target="_blank" />
          ),
      }}
      rehypePlugins={[rehypeNeutralIds]}
      remarkPlugins={[remarkGfm]}
    >
      {body}
    </Markdown>
  );
}
