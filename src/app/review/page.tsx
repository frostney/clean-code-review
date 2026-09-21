import { redirect } from 'next/navigation';

/**
 * The address a pasted or example review is given while the tab that holds it
 * is open. Nothing about a review is stored, so there is nothing here to serve:
 * a load or a shared link is sent to the application itself, which is what the
 * address would have shown anyway.
 *
 * The route exists so that address resolves, and so the landing view is never
 * left sitting under it — which would cost the next review its page view, since
 * a page view is a change of address and there would be none.
 *
 * `Accept: text/markdown` never reaches this: `src/proxy.ts` answers the twin
 * in `src/site/agent-markdown.ts` first.
 */
export default function ReviewPage() {
  redirect('/');
}
