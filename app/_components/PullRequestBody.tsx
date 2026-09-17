import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
export function PullRequestBody({ body }: { body: string }) {
  return (
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
  );
}
