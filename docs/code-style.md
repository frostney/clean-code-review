# Code style

Naming, layout, design and dependency rules for this repository. Biome
(`biome.jsonc`) enforces what it can; the rest is here.

## Layout

- `src/app/` holds routes only: pages, layouts, route handlers and metadata
  files. A route imports its UI and logic from its domain folder. `src/proxy.ts`
  sits beside it, where Next looks for it when the routes are under `src/`.
- `src/<domain>/` holds app-side code: `landing`, `mcp`, `pull-request`,
  `review`, `site`, `theme`, `ui`. A component's hooks and helpers sit beside
  it in the same domain folder, and tests sit beside the module they test
  (`language.test.ts`).
- `agent/` is eve's authored agent, at the root because eve resolves it by that
  name. Shared code lives in `agent/lib/<domain>/` (`github`, `infra`,
  `judging`, `review`, `spend`).
- `examples/` holds the preset example code shown on the page. The agent never
  imports it.
- `scripts/` holds one-off tools run with `bun run judge|review|jev`.
- Imports: `@/…` from the repo root outside `agent/` (`@/src/review/diff`,
  `@/agent/lib/judging/judge`); relative paths inside `agent/`, which never
  imports `src/` or `examples/`. Within a `src/` domain folder, siblings are
  imported relatively (`./address`).

## Naming

- Files are camelCase or kebab-case (`useTheme.ts`, `open-review.ts`); `.tsx`
  files under `src/` may also be PascalCase. Biome's
  `useFilenamingConvention` enforces both.
- A file whose main export is a component is PascalCase, named after that
  component or the family it holds (`PullRequestField.tsx`, `Tutorial.tsx`). A hook file is named after the hook
  (`useCardWindow.ts`). Every other module is kebab-case, `.tsx` included when
  it renders but exports no component of that name (`pull-request.tsx`).
- `src/app/` files follow Next's names (`page.tsx`, `route.ts`,
  `opengraph-image.tsx`).
- No two files in one folder may differ only by case. macOS checkouts are
  case-insensitive, so `errors.ts` and `Errors.tsx` would collide there.
- A name should say what a thing is. When a comment is needed to explain a
  name, rename it instead.

## Comments

Comments explain constraints or decisions the code cannot express; improve
unclear names rather than narrating implementation. Keep a platform or
framework constraint, a limit, a privacy, security or accessibility reason, a
contrast number, or why the obvious alternative was rejected. Cut narration,
restated names and history ("used to", "now"). One or two lines is typical;
`biome-ignore` reasons stay on one line.

Keep, because the code cannot say it:

```tsx
// Not `disabled`: a disabled button drops the focus that pressed it.
onClick={busy ? undefined : run}
```

Cut, because the signature already says it:

```ts
/** The stored choice, or "system" when there is none or storage is closed. */
export function readChoice(): ThemeChoice {
```

## Design

- Colour tokens live only in `src/app/globals.css`, in both themes: the light set
  on `:root`, the dark set under `--dark-*` names, switched on by both
  `:root[data-theme="dark"]` and
  `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }`.
  A new colour token takes five edits: its `@theme inline` mapping, the light
  `:root`, the `--dark-*` `:root`, and both dark switches. Components use the utilities
  (`text-muted`, `bg-surface`), never a colour literal or a `dark:` variant.
- Type uses the five-step scale only (`text-xs` to `text-xl`); Tailwind's
  defaults are cleared. Typed inputs stay at 16px or more below `lg`, or iOS
  zooms on focus. Code uses `.code-line`.
- Text is never faded with opacity. The quietest text is `text-subtle`, which
  clears 4.5:1 on page and surface.
- One focus ring, from the base layer (2px accent, 2px offset). A control
  overrides it with a utility only when it draws its own.
- Honour reduced motion: `motion-safe:` on transitions, and loops and view
  transitions stop under `prefers-reduced-motion: reduce`.
- Cumulative layout shift is 0: reserve space before content arrives (the
  held bubble height, both button labels in one grid cell, `.card-space`).

## Dependencies

- Prefer the platform, Next or eve before adding a package.
- Add with an exact version: `bun add --exact <pkg>` (`-d` for dev tooling).
  About half of `package.json` is still on `^` ranges (`ai`, `eve`, `shiki`,
  `knip` and others); they predate this rule and are not a pattern to copy.
- Bun 1.4 (`packageManager: bun@1.4.0`) writes the text `bun.lock`. Commit it
  with the `package.json` change; Vercel and CI install with
  `bun install --frozen-lockfile`.

## Checks

```sh
bun run check   # Biome, TypeScript and knip, in parallel
bun run test    # bun test
bun run build   # next build
```

All three must exit 0. The lefthook pre-commit hook runs `check:fix` on staged
files; CI runs `bun run check` on every push to `main` and every pull request.
