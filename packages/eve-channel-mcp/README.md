# eve-channel-mcp

An [eve](https://eve.dev) channel that publishes your eve app's own typed tools
as an MCP server.

eve's built-in `mcpChannel` (`eve/channels/mcp`) serves four fixed tools
(`agent_start`, `agent_get`, `agent_update`, `agent_cancel`). Those tools hand
a message to your agent and poll for the result. This channel serves the tools
you define instead, with your own input and output schemas, and runs them
directly in the route handler, with no model call unless a tool makes one.

It serves MCP `2026-07-28` and, by default, 2025-era clients (`2025-11-25`,
`2025-06-18` and older) through `createMcpHandler` from
`@modelcontextprotocol/server`. It is built on eve's public API: `defineChannel`,
the route helpers from `eve/channels` and `routeAuth` from `eve/channels/auth`.
One further dependency on eve is not a public API: to refuse an
`oauthResource()` policy that comes without the `oauth` option, it looks for
the registered symbol `Symbol.for('eve.channels.auth.oauthResource')` that
eve marks such policies with. If eve renames it, only that refusal is lost.

## Install

```sh
npm install eve-channel-mcp @modelcontextprotocol/server
```

`eve` (0.64) and `@modelcontextprotocol/server` (2.x) are peer dependencies.

## Example

```ts title="agent/channels/tools.ts"
import { vercelOidc } from 'eve/channels/auth';
import { defineMcpTool, mcpServerChannel } from 'eve-channel-mcp';
import { z } from 'zod';

const convertTemperature = defineMcpTool({
  definition: {
    name: 'convert_temperature',
    description: 'Convert a temperature in degrees Celsius.',
    annotations: { readOnlyHint: true },
    inputSchema: z.object({ celsius: z.number() }),
    outputSchema: z.object({ fahrenheit: z.number() }),
  },
  async call({ celsius }) {
    const result = { fahrenheit: celsius * 1.8 + 32 };

    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
    };
  },
});

export default mcpServerChannel({
  auth: vercelOidc(),
  route: '/mcp',
  name: 'my-app',
  version: '1.0.0',
  instructions: 'Converts temperatures.',
  tools: [convertTemperature],
});
```

This repository's
[`packages/eve-channel-mcp/example`](https://github.com/frostney/clean-code-review/tree/main/packages/eve-channel-mcp/example)
is a runnable agent with three tools and HTTP Basic auth. The npm package does
not include it: clone the repository and run `bun run example` in
`packages/eve-channel-mcp`. Outside `eve dev` it refuses every request until
`EXAMPLE_MCP_PASSWORD` is set.

## Options

| Option | Default | |
|---|---|---|
| `auth` | required | eve route auth: one `AuthFn` or an ordered array. `none()` must be written out for public access. |
| `route` | required | The path the endpoint answers on. See [Routing](#routing). |
| `name`, `version` | required | The server's identity in `server/discover` and `initialize`. |
| `instructions` | none | Sent in `server/discover` and `initialize`. |
| `tools` | none | Tools made with `defineMcpTool`. You need `tools`, `register`, or both. |
| `register(server, context)` | none | Called once per request with the SDK's `McpServer`. `context` holds `era` (`modern` or `legacy`), `auth`, the HTTP details and `addTool`. What you register on `server` directly bypasses this package's error handling and the batch concurrency bound; see [Errors](#errors). |
| `allowedHosts` | see [Host checks](#host-and-origin-checks) | A list of hostnames, or `'any'`. Required outside `eve dev` and Vercel. |
| `https` | `'auto'` | `'auto'`, `'trusted-proxy'` or `'off'`. Outside `eve dev` and Vercel, `'auto'` is a setup error. See [HTTPS](#https). |
| `oauth` | none | Protected-resource metadata. See [OAuth](#oauth). |
| `legacy` | `'stateless'` | `'reject'` serves `2026-07-28` only. |
| `allowBatches` | `false` | `true`, or `{ maxMessages, concurrency }`. See [Batches](#batches). |
| `responseMode` | the SDK's `'auto'` | Response shape for `2026-07-28`. `'auto'` returns plain JSON unless a tool sends progress or log messages first. `'json'` never streams and drops those messages. `'sse'` always streams. |
| `maxBodyBytes` | 1 MiB | The same limit eve's `mcpChannel` uses. A larger body gets a `413`. |
| `bodyTimeoutMs` | 10 000 | A body that has not fully arrived by then gets a `408`. |
| `onToolError(error, errorId)` | `console.error` | Called when a tool, or a schema, fails unexpectedly. A throw or rejection here is ignored. |
| `onError(error)` | `console.error` for the last two | Requests the SDK refused, its out-of-band failures, every request refused because `allowedHosts` or `https` is not set for the deployment, and an auth strategy that returned a malformed principal. A throw or rejection here is ignored. |

Every option is checked when the channel is built. Unknown values, empty host
lists, and limits that are not positive integers (`NaN`, `Infinity`, `0`)
throw instead of switching a bound off.

## `defineMcpTool`

```ts
defineMcpTool({
  definition: { name, title?, description?, annotations?, inputSchema, outputSchema? },
  async call(value, { auth, signal }, { request, requestIp, channel }) { … },
});
```

Any Standard Schema that also produces JSON Schema can be used, such as Zod 4.
The SDK validates the arguments before `call` runs, so `value` is typed. With
an `outputSchema`, TypeScript requires a successful result's
`structuredContent` to match the schema's type.

- `auth` is the principal eve's auth walk accepted. It is a frozen copy made
  for this request.
- `signal` is aborted when the client disconnects.
- The third argument holds details eve's own MCP tools do not get: `request`,
  `requestIp`, and `channel` (eve's route arguments `from`, `to`,
  `attachSession` and `waitUntil`).

### Compared with eve's internal `defineMcpTool`

eve's MCP channel has a `defineMcpTool` of its own, which eve does not export.
Both take `definition` plus `async call(value, { auth, signal })`, and a tool
that uses only that much can be moved to eve's version. The differences:

- eve types `auth` as `SessionAuthContext | null`. Here it is never null.
- The third `call` argument exists only here.
- eve does not tie `structuredContent` to the output schema.
- eve's definition has no `title`.
- `McpToolOperationError(code, message)` has the same codes and signature in
  both.

## Errors

- **`McpToolOperationError`**: throw
  `new McpToolOperationError(code, message)`, where `code` is `invalid_input`,
  `not_found`, `conflict` or `internal`, for a failure the caller should read.
  The client gets `isError: true` and
  `structuredContent.error: { code, message, retryable }`. `retryable` is true
  only for `conflict`.
- **Any other throw** from a tool reaches the client as one generic sentence
  with an `errorId`. The error itself goes to `onToolError`.
- **A schema that throws** (for example a Zod refinement that throws rather
  than returning false) is handled the same way.
- **Invalid arguments** come back naming the field that failed, as the SDK
  words it.
- **An output schema failure** is a fault in your tool, so the client gets
  only a generic message and the details go to `onToolError`.

Tools, resources and prompts registered directly on `server` inside
`register` get none of this: the SDK sends their own error text to the
client, and they run outside the batch concurrency bound. Register tools with
`context.addTool(defineMcpTool(…))` instead, and catch errors yourself in
anything else registered there.

## Admission

Each request passes these checks in this order before anything reaches the SDK:

1. The `Host` header must be a bare authority that matches the request URL,
   on the `allowedHosts` list.
2. The request must have arrived over HTTPS, except under `eve dev` and
   `vercel dev`.
3. A browser request's `Origin` must be exactly this endpoint's origin.
4. eve's `routeAuth` runs, and the principal it accepts must be well formed.
5. The body is read once, bounded by `maxBodyBytes` and `bodyTimeoutMs`.
6. Batch rules and `subscriptions/listen` are checked, and so are the routing
   headers of 2025-era requests.

The OAuth metadata routes run only the first two checks. They are public and
readable from any origin by design, as RFC 9728 expects.

Auth runs before the body is read, so the body bounds do not apply to an auth
strategy that reads the body itself: it can wait on a slow upload or buffer a
large one. Keep auth to headers, and make decisions that depend on the
operation (which tool, which arguments) inside the tool, where the body has
already been read within its bounds.

None of these checks shows where a connection came from. That depends on
where the server listens: `eve dev` listens on loopback.

### Host and origin checks

DNS rebinding makes a hostile page's requests reach a server on the user's
machine or network while the browser still believes it is talking to the
attacker's domain. Comparing `Origin` with the request's own URL does not
catch this: the URL's host comes from the `Host` header, which says the same
attacker domain. So the `Host` header is checked against an allowlist:

- **`eve dev` and `vercel dev`**: `localhost`, `127.0.0.1` and `[::1]`, unless
  you set `allowedHosts`.
- **Vercel**: any host, because Vercel's edge only routes the project's own
  domains to the deployment.
- **Anywhere else**: `allowedHosts` is required, and so is an `https` other
  than `'auto'`. Until both are set, every request gets a 500 naming both, and
  each one is reported to `onError`. Use `'any'` only behind a proxy that
  checks `Host` itself.

The `Host` header must also be a bare authority (no userinfo, path, query or
fragment) naming the same authority as the URL the server built for the
request, and it must be present.

A browser request's `Origin` must equal this endpoint's origin exactly:
scheme, host and port. There is no cross-origin allowlist, because nothing
here needs one: MCP clients do not run as web pages on another origin.

### HTTPS

HTTP Basic credentials and bearer tokens must not cross the network in the
clear. `eve dev` and `vercel dev` take plain HTTP whatever `https` says; a
loopback `Host` header does not, since any client can send one. Otherwise:

- **`'auto'`**: HTTPS as reported by Vercel's edge, and nothing else. Under
  `eve start`, the request URL describes the connection to eve itself, which
  is plain HTTP behind a TLS-terminating proxy, and eve's server ignores
  `X-Forwarded-Proto` unless it is configured to trust a proxy. So the
  channel cannot tell how the client connected, and `'auto'` outside Vercel
  and development is refused as a setup error (500) until you choose.
- **`'trusted-proxy'`**: a present `X-Forwarded-Proto` decides, by its last
  entry, the one the nearest proxy wrote: `http` is refused even when the
  proxy reached eve over TLS. Without the header, the request URL decides.
  Use it only when a proxy you run terminates TLS and overwrites that header.
- **`'off'`**: no check, for example on a private network.

## Auth

`auth` is required, as it is for eve's `mcpChannel`. When no strategy accepts
the request, the client gets eve's own 401 or 403 with its
`WWW-Authenticate` challenge.

eve's walk accepts any truthy value a strategy returns. This channel accepts
only a well-formed principal: non-empty `authenticator`, `principalId` and
`principalType`, and string or string-list `attributes`. For anything else
(`true`, `{}`, a verifier's own `{ ok: false }`) it answers 500 and reports
through `onError`.

`none()` gives every caller the same `anonymous` principal. Nothing in `auth`
then tells callers apart, so a per-caller limit has to use `requestIp` (see
below) or be enforced elsewhere.

### OAuth

Pass `oauth` to publish RFC 9728 metadata and add `resource_metadata` to the
Bearer challenge of each 401, and of each 403 whose Bearer challenge says
`insufficient_scope`. The `auth` strategy still verifies the tokens. eve's
`oauthResource()` holds the same settings but exposes them only through an
internal reader, so this channel refuses an `oauthResource()` policy that
comes without `oauth`.

```ts
mcpServerChannel({
  auth: oidc({ issuer, audiences: [resource] }),
  oauth: {
    issuer: 'https://auth.example.com',
    resource: 'https://app.example.com/eve/v1/tools',
    // Behind withEve only /eve/v1/* reaches eve, and the RFC 9728 default
    // (/.well-known/oauth-protected-resource/…) would not.
    metadataPath: '/eve/v1/oauth-protected-resource/tools',
    scopes: ['tools:call'],
  },
  route: '/eve/v1/tools',
  // …
});
```

`resource` is required and is never derived from the request's `Host`.

## Batches

JSON-RPC batches are refused with a 400 (`-32600`) by default. MCP dropped
batches in `2025-06-18`, but the SDK's stateless 2025 path still accepts them,
and every call in a batch runs behind one auth decision and one request that a
rate limit counts once.

`allowBatches: true` accepts up to 10 messages per batch and runs their tool
calls one at a time, argument and result validation included. A queued call
whose client has disconnected never starts. `{ maxMessages, concurrency }`
changes either bound; anything else throws when the channel is built. The
concurrency bound covers tools from `tools` and `context.addTool` only, not
tools, resources or prompts registered directly on the server. A rate limit
that should count calls rather than requests has to count inside the tool.

## Protocol eras, streams, GET and DELETE

Each request gets a new `McpServer` built from `tools` and `register`.

- **`2026-07-28`**: a request that carries the per-request `_meta` envelope.
  It needs the `Mcp-Method` header, and `Mcp-Name` for `tools/call`, both
  checked against the body by the SDK. Answers are plain JSON unless a tool
  streams.
- **2025 era**: a request without the envelope. It is served statelessly over
  SSE. `Mcp-Method` and `Mcp-Name` are optional here, but when present they
  must agree with the body, or the request gets a 400 (`-32020`). As in the
  SDK, this applies to requests, not notifications; `Mcp-Name` is compared
  only for `tools/call`, `prompts/get` and `resources/read`, after decoding
  its `=?base64?…?=` form. A request can simply leave the headers out, so
  decide by operation inside the tool, not in auth.
- **`subscriptions/listen`** is refused with `-32601`. Each request has its
  own event bus that nothing publishes to, so a listen stream would stay open
  and never receive anything. For the same reason `tools.listChanged` is
  advertised as `false`.
- **GET and DELETE** answer 405 with a JSON-RPC body, since there is no
  session to stream or end.

A response streams for as long as its tool runs, and the channel sets no
deadline of its own. A 2025-era client's `notifications/cancelled` arrives as
a separate request and does not reach a call running on another one; only a
disconnect aborts `signal` there. Bound slow work inside the tool, for
example with `AbortSignal.any([signal, AbortSignal.timeout(ms)])`.

## What you still add yourself

- **Rate limits.** Base them on the principal where you can. Count per tool
  call, not per request, if batches are allowed.
- **Spend limits.** A tool can start agent work through
  `channel.attachSession` or `channel.from`, and that work spends model
  tokens.
- **Timeouts on tool work.** Nothing here stops a slow tool before the host's
  function timeout does; combine `signal` with a timeout of your own.

### How far to trust `requestIp`

`requestIp` is what eve's host reports:

- **Vercel**: the first `X-Forwarded-For` entry. Its provenance rests on
  Vercel's edge setting that header; this package cannot check it.
- **Standalone Node** (`eve start`): the socket's peer. Behind a reverse
  proxy that is the proxy, so every caller shares one address.
- **`eve dev`**: an address the dev proxy signs.

Prefer principal-based limits, and treat an address as a coarse second bound.

## Routing

`route` has no default. eve's `mcpChannel` defaults to `/eve/v1/mcp`, and the
two can only coexist on different paths.

- **Standalone eve app** (`eve dev`, `eve start`, or eve deployed on its own):
  any path works, for example `/mcp`.
- **Next.js app using `withEve`**: only `/eve/v1/*` reaches eve, so put the
  route (and any OAuth `metadataPath`) under it, for example `/eve/v1/tools`.
  - In development, `withEve` rewrites `/eve/v1/:path+` to a local `eve dev`
    process on a port it chooses.
  - On Vercel, it writes a service route that sends `^/eve/v1/(.*)$` to the
    eve service, and eve drops every other channel route from that service's
    output.
  - A Next rewrite to `EVE_NEXT_SERVICE_PREFIX` does not help: that prefix is
    only used for manually configured Vercel services and for proxying to a
    self-hosted eve.
  - For a named workspace agent, a route declared as `/eve/v1/tools` is served
    at `/eve/<name>/v1/tools`.
  - Self-hosted (`next start`), Next reaches eve through a rewrite to
    `127.0.0.1`, and eve sees that hop: `Host` names `127.0.0.1` and the
    scheme is plain HTTP, whatever the client used. The channel cannot check
    the client's host or scheme there, so enforce them at Next or at the
    proxy in front of it, and configure the channel for the hop
    (`allowedHosts: ['127.0.0.1'], https: 'off'`).

## Channel file

Any file under `agent/channels/` works. eve's `mcpChannel` must live in
`agent/channels/mcp.ts`, so choose another name if you use both. The file
stem becomes the channel id. This channel starts no sessions itself.

## Develop

In a clone of the repository:

```sh
bun test src        # unit and route tests, beside the source
bun run typecheck   # src and example
bun run build       # dist/, with declarations
bun run example     # the example agent under eve dev, on port 3104
```

## License

MIT
