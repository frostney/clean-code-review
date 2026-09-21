import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Rendered on the server so the markdown pipeline never ships to the browser.
 * Raw HTML stays escaped (no `rehype-raw`): descriptions come from repositories
 * nobody here controls.
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
 * Speed Insights reports elements as id/class selectors, so footnote ids
 * (`user-content-fn-<label>`) and `language-<info>` classes would send the
 * author's words to Vercel. Ids are renumbered with their references; the
 * unstyled `language-` classes are dropped.
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
        // Untrusted links get a new tab with no opener; footnote `#` links stay.
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
