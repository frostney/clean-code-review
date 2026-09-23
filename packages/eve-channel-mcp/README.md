# eve-channel-mcp

An [eve](https://eve.dev) channel that publishes your eve app's own typed tools
as an MCP server.

eve's built-in `mcpChannel` (`eve/channels/mcp`) serves four fixed tools
(`agent_start`, `agent_get`, `agent_update`, `agent_cancel`). Those tools hand
a message to your agent and poll for the result. This channel serves the tools
you define instead, with your input and output schemas, and runs them directly
in the route handler. It uses the same route auth as every other eve channel.

It serves MCP `2026-07-28` and, by default, 2025-era clients (`2025-11-25`,
`2025-06-18` and older) through `createMcpHandler` from
`@modelcontextprotocol/server`. It is built only on eve's public channel API:
`defineChannel`, `GET`/`POST`/`DELETE` and `routeAuth`.

## Install

```sh
npm install eve-channel-mcp @modelcontextprotocol/server
```

`eve` (0.64) and `@modelcontextprotocol/server` (2.x) are peer dependencies.

## Example

```ts title="agent/channels/tools.ts"
import { localDev } from 'eve/channels/auth';
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
  call({ celsius }) {
    const result = { fahrenheit: celsius * 1.8 + 32 };

    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
    };
  },
});

export default mcpServerChannel({
  auth: localDev(),
  route: '/mcp',
  name: 'my-app',
  version: '1.0.0',
  instructions: 'Converts temperatures.',
  tools: [convertTemperature],
});
```

[`example/`](./example) is a runnable agent with three tools and HTTP Basic
auth. Run `bun run example` in this package to start it.

## API

### `mcpServerChannel(options)`

| Option | Default | |
|---|---|---|
| `auth` | required | eve route auth: one `AuthFn` or an ordered array. Use `none()` for public access. |
| `route` | required | The path the endpoint answers on. See [Routing](#routing). |
| `name`, `version` | required | The server's identity in `server/discover` and `initialize`. |
| `instructions` | none | Sent to the client in `server/discover` and `initialize`. |
| `tools` | none | Tools made with `defineMcpTool`. |
| `register(server, context)` | none | Receives the SDK's `McpServer` for each request. Use it for resources, prompts or raw `registerTool` calls. `context.era` is `modern` or `legacy`. |
| `legacy` | `'stateless'` | `'reject'` serves `2026-07-28` only. |
| `allowBatches` | `false` | See [Batches](#batches). |
| `responseMode` | SDK default `'auto'` | Response shape for `2026-07-28`. `auto` returns plain JSON unless a tool sends progress or log messages first. `'json'` never streams and drops those messages. `'sse'` always streams. |
| `maxBodyBytes` | 1 MiB | The same limit eve's `mcpChannel` uses. A larger body gets a `413`. |
| `onToolError(error, errorId)` | `console.error` | Called when a tool throws something other than `McpToolOperationError`. |
| `onError(error)` | none | Called for requests the SDK refused and for its out-of-band failures. |

Pass `tools`, `register`, or both.

### `defineMcpTool({ definition, call })`

`definition` holds `name`, `title`, `description`, `annotations`,
`inputSchema` and `outputSchema`. Any Standard Schema with JSON Schema output
works for the schemas; Zod 4 is one. The SDK validates the arguments before
`call` runs, so `call` receives a typed value.

The second argument to `call` holds:

- `auth`: the eve `SessionAuthContext` that accepted this request
- `signal`: aborted when the client cancels the call
- `request`: the HTTP request
- `requestIp`: the client address the host reported, or null
- `channel`: eve's route arguments (`from`, `to`, `attachSession`, `waitUntil`). A tool can use them to start durable agent work.

This mirrors eve's internal `defineMcpTool`. If eve ever exports that
transport, moving to it should be a change of import.

### Errors

Throw `new McpToolOperationError(code, message, { retryable })` for a failure
the caller should read. The client gets `isError: true` and
`structuredContent.error: { code, message, retryable }`. Anything else a tool
throws reaches the client as one generic sentence with an `errorId`, and the
error itself goes to `onToolError`. Without this, the SDK would send the
thrown error's own message to the client.

Invalid arguments come back as the SDK's `isError` result, which names the
field that failed.

## Auth

`auth` is required, as it is for eve's `mcpChannel`. Public access must be
written out as `none()`. Every request runs through `routeAuth` before
anything else, including GET and DELETE. When no strategy accepts the
request, the client gets eve's own 401 or 403, with its `WWW-Authenticate`
challenge. Tools receive the accepted principal as `context.auth`.

If `auth` is wrapped in eve's `oauthResource()`, the channel publishes RFC 9728
protected-resource metadata at
`/.well-known/oauth-protected-resource<route>`. It also adds
`resource_metadata` to the Bearer challenge of every 401, so an MCP client can
start sign-in. eve's `mcpChannel` does the same. This depends on
`readOAuthResourceOptions` from `eve/channels/auth`, which is exported but
tagged internal.

A browser request whose `Origin` differs from the endpoint's origin is refused
with a 403, which the MCP specification requires against DNS rebinding.
Requests without an `Origin` header, which is how non-browser clients send
them, are served.

## Batches

JSON-RPC batches are refused with a 400 (`-32600`) by default. MCP dropped
batches in `2025-06-18`, but the SDK's stateless 2025 path still accepts them.
On a public endpoint, each `tools/call` in a batch would run behind a single
request, which a per-request rate limit counts once. Set `allowBatches: true`
to accept them.

## Protocol eras, GET and DELETE

Each request gets a new `McpServer`, built from the tools and `register`, and
nothing is held open between requests.

- **`2026-07-28`**: a request carrying the per-request `_meta` envelope. It
  needs the `Mcp-Method` header, and `Mcp-Name` for `tools/call`. Answers are
  plain JSON unless a tool streams.
- **2025 era**: a request without the envelope, starting with `initialize`.
  It is served statelessly over SSE.
- **GET and DELETE**: both answer 405 with a JSON-RPC body, because there is
  no session to stream or end.

## Routing

`route` has no default. eve's `mcpChannel` defaults to `/eve/v1/mcp`, and the
two channels can coexist only on different paths.

- **Standalone eve app** (`eve dev`, `eve start`, eve deployed on its own):
  any path works, for example `/mcp`.
- **Next.js app using `withEve`**: only `/eve/v1/*` reaches eve, so put the
  route under it, for example `/eve/v1/tools`. In development, `withEve`
  rewrites `/eve/v1/:path+` to a local `eve dev` process on a port it chooses
  at startup. On Vercel it writes a service route that sends `^/eve/v1/(.*)$`
  to the eve service, and eve itself sees only that path. A route such as
  `/mcp` therefore never reaches eve. A Next rewrite to `EVE_NEXT_SERVICE_PREFIX`
  does not fix this: that prefix is only used for manually configured Vercel
  services and for proxying to a self-hosted eve. For a named workspace agent,
  a route declared as `/eve/v1/tools` is served at `/eve/<name>/v1/tools`.

## Channel file

The channel can live in any file under `agent/channels/`. eve's `mcpChannel`
must be `agent/channels/mcp.ts`, so choose another name if you use both. The
file stem becomes the channel id. This channel starts no sessions, so the id
matters only for eve's own listings.

## Develop

```sh
bun test src        # unit tests, beside the source
bun run typecheck   # src and example
bun run build       # dist/, with declarations
bun run example     # the example agent on port 3104
```

## License

MIT
