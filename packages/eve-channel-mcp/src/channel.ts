import {
  createMcpHandler,
  isJsonContentType,
  McpServer,
  type McpServerFactory,
} from '@modelcontextprotocol/server';
import {
  type Channel,
  DELETE,
  defineChannel,
  GET,
  type HttpRouteDefinition,
  POST,
  type RouteHandlerArgs,
} from 'eve/channels';
import { type AuthFn, routeAuth } from 'eve/channels/auth';

import {
  metadataRoutes,
  oauthOptions,
  withResourceChallenge,
} from './oauth.js';
import {
  crossOriginRefusal,
  DEFAULT_MAX_BODY_BYTES,
  readJsonRpcBody,
} from './request.js';
import type {
  McpRequestScope,
  McpTool,
  SessionAuthContext,
  ToolErrorReporter,
} from './tool.js';

export type McpEra = Parameters<McpServerFactory>[0]['era'];

export interface McpRegisterContext extends McpRequestScope {
  /** `modern` for a 2026-07-28 request, `legacy` for a 2025-era one. */
  readonly era: McpEra;
}

export interface McpServerChannelOptions {
  /** eve route auth, as for any channel. Required: pass `none()` to serve anyone. */
  readonly auth: AuthFn<Request> | readonly AuthFn<Request>[];
  /** Where the endpoint answers. In a Next.js app behind `withEve`, keep it under `/eve/v1/`. */
  readonly route: string;
  readonly name: string;
  readonly version: string;
  readonly instructions?: string;
  readonly tools?: readonly McpTool[];
  /** The SDK's own server, per request, for anything `tools` does not cover. */
  readonly register?: (
    server: McpServer,
    context: McpRegisterContext,
  ) => void | Promise<void>;
  /** `stateless` (default) also serves 2025-era clients; `reject` serves 2026-07-28 only. */
  readonly legacy?: 'stateless' | 'reject';
  /**
   * Off by default: each `tools/call` in a batch would run behind one
   * request, so one rate-limited request could start many calls.
   */
  readonly allowBatches?: boolean;
  /** Shaping of 2026-07-28 responses; the SDK's `auto` sends JSON unless a tool streams progress. */
  readonly responseMode?: 'auto' | 'json' | 'sse';
  readonly maxBodyBytes?: number;
  /** A tool's unexpected failure, which the client sees only as an error id. */
  readonly onToolError?: ToolErrorReporter;
  /** Requests the SDK refused, and its out-of-band failures. */
  readonly onError?: (error: Error) => void;
}

function assertOptions(options: McpServerChannelOptions): void {
  if (options?.auth === undefined) {
    throw new Error(
      'mcpServerChannel requires auth. Use none() for explicit public access.',
    );
  }
  if (!options.route?.startsWith('/')) {
    throw new Error('mcpServerChannel requires a route starting with "/".');
  }
  if (!(options.tools?.length || options.register)) {
    throw new Error('mcpServerChannel needs tools, register, or both.');
  }
  const names = (options.tools ?? []).map((tool) => tool.name);

  if (new Set(names).size !== names.length) {
    throw new Error('mcpServerChannel tool names must be unique.');
  }
}

/**
 * Publishes an eve app's own typed tools as an MCP server: 2026-07-28 and,
 * by default, stateless 2025-era serving, through the SDK's `createMcpHandler`.
 * Any file under `agent/channels/` may hold it.
 */
export function mcpServerChannel(options: McpServerChannelOptions): Channel {
  assertOptions(options);

  const { route } = options;
  const oauth = oauthOptions(options.auth);
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  async function buildServer(
    scope: McpRequestScope,
    era: McpEra,
  ): Promise<McpServer> {
    const server = new McpServer(
      { name: options.name, version: options.version },
      options.instructions === undefined
        ? {}
        : { instructions: options.instructions },
    );

    for (const tool of options.tools ?? []) {
      tool.register(server, scope, options.onToolError);
    }
    await options.register?.(server, { ...scope, era });

    return server;
  }

  /** Origin, then auth, then the body: a refusal, or what serving needs. */
  async function admit(
    request: Request,
  ): Promise<Response | { auth: SessionAuthContext; parsedBody?: unknown }> {
    const refused = crossOriginRefusal(request);

    if (refused) {
      return refused;
    }
    const auth = await routeAuth(request, options.auth);

    if (auth instanceof Response) {
      return oauth ? withResourceChallenge(auth, oauth, route, request) : auth;
    }
    // A POST that is not JSON is left to the SDK, which answers 415.
    if (
      request.method !== 'POST' ||
      !isJsonContentType(request.headers.get('content-type'))
    ) {
      return { auth };
    }
    const body = await readJsonRpcBody(request, {
      allowBatches: options.allowBatches === true,
      maxBodyBytes,
    });

    return body.ok ? { auth, parsedBody: body.value } : body.response;
  }

  async function serve(
    request: Request,
    channel: RouteHandlerArgs,
  ): Promise<Response> {
    const admitted = await admit(request);

    if (admitted instanceof Response) {
      return admitted;
    }
    const scope: McpRequestScope = {
      auth: admitted.auth,
      channel,
      request,
      requestIp: channel.requestIp,
    };
    // One handler per request: its factory closes over this caller's scope,
    // which the SDK would otherwise carry only as an OAuth-shaped `authInfo`.
    const handler = createMcpHandler(({ era }) => buildServer(scope, era), {
      legacy: options.legacy ?? 'stateless',
      ...(options.onError === undefined ? {} : { onerror: options.onError }),
      ...(options.responseMode === undefined
        ? {}
        : { responseMode: options.responseMode }),
    });

    return handler.fetch(
      request,
      'parsedBody' in admitted
        ? { parsedBody: admitted.parsedBody }
        : undefined,
    );
  }

  const routes: HttpRouteDefinition[] = [
    ...(oauth ? metadataRoutes(oauth, route) : []),
    POST(route, serve),
    // Stateless in both eras: the SDK answers GET and DELETE with a JSON-RPC 405.
    GET(route, serve),
    DELETE(route, serve),
  ];

  return defineChannel({ routes });
}
