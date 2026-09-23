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
  HEAD,
  type HttpRouteDefinition,
  OPTIONS,
  POST,
  type RouteHandlerArgs,
} from 'eve/channels';
import { type AuthFn, routeAuth } from 'eve/channels/auth';

import {
  type AdmissionPolicy,
  type AllowedHosts,
  admissionRefusal,
  type HttpsPolicy,
  normalizeHostname,
} from './admission.js';
import { type BatchLimits, messageRefusal } from './messages.js';
import {
  type McpOAuthOptions,
  metadataResponse,
  type OAuthConfig,
  resolveOAuth,
  withResourceChallenge,
} from './oauth.js';
import { isolatePrincipal } from './principal.js';
import {
  DEFAULT_BODY_TIMEOUT_MS,
  DEFAULT_MAX_BODY_BYTES,
  jsonRpcError,
  readJsonRpcBody,
} from './request.js';
import type {
  McpHttpContext,
  McpRequestScope,
  McpTool,
  SessionAuthContext,
  ToolErrorReporter,
} from './tool.js';

export type McpEra = Parameters<McpServerFactory>[0]['era'];

export interface McpRegisterContext extends McpHttpContext {
  readonly auth: SessionAuthContext;
  /** `modern` for a 2026-07-28 request, `legacy` for a 2025-era one. */
  readonly era: McpEra;
  /** Registers a `defineMcpTool` tool with the same error handling as `tools`. */
  readonly addTool: (tool: McpTool) => void;
}

export interface McpBatchOptions {
  /** Default 10. */
  readonly maxMessages?: number;
  /** Tool calls from one batch that run at once. Default 1. */
  readonly concurrency?: number;
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
  /** Hostnames this endpoint answers to, or `'any'`. Required outside `eve dev` and Vercel. */
  readonly allowedHosts?: AllowedHosts;
  /** How to tell a request arrived over HTTPS; loopback is always allowed. Default `'auto'`. */
  readonly https?: HttpsPolicy;
  /** Protected-resource metadata for OAuth sign-in. */
  readonly oauth?: McpOAuthOptions;
  /** `stateless` (default) also serves 2025-era clients; `reject` serves 2026-07-28 only. */
  readonly legacy?: 'stateless' | 'reject';
  /** Off by default: a batch runs many calls behind one admitted request. */
  readonly allowBatches?: boolean | McpBatchOptions;
  /** Shaping of 2026-07-28 responses. Default `'auto'`. */
  readonly responseMode?: 'auto' | 'json' | 'sse';
  /** Default 1 MiB. */
  readonly maxBodyBytes?: number;
  /** Default 10 000. */
  readonly bodyTimeoutMs?: number;
  /** A tool's unexpected failure, which the client sees only as an error id. */
  readonly onToolError?: ToolErrorReporter;
  /** Requests the SDK refused, its out-of-band failures, and a misconfigured deployment. */
  readonly onError?: (error: Error) => void;
}

const SERVER_ERROR = -32_000;
const MISCONFIGURED = 500;
const DEFAULT_BATCH: Required<McpBatchOptions> = {
  concurrency: 1,
  maxMessages: 10,
};

function positiveInteger(
  label: string,
  value: number | undefined,
  fallback: number,
): number {
  const resolved = value ?? fallback;

  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`mcpServerChannel: ${label} must be a positive integer.`);
  }

  return resolved;
}

function oneOf<T extends string>(
  label: string,
  value: T | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  const resolved = value ?? fallback;

  if (!allowed.includes(resolved)) {
    throw new Error(
      `mcpServerChannel: ${label} must be one of ${allowed.join(', ')}.`,
    );
  }

  return resolved;
}

function batchLimits(
  option: McpServerChannelOptions['allowBatches'],
): BatchLimits | null {
  if (option === undefined || option === false) {
    return null;
  }
  const given = option === true ? {} : option;

  return {
    concurrency: positiveInteger(
      'allowBatches.concurrency',
      given.concurrency,
      DEFAULT_BATCH.concurrency,
    ),
    maxMessages: positiveInteger(
      'allowBatches.maxMessages',
      given.maxMessages,
      DEFAULT_BATCH.maxMessages,
    ),
  };
}

function hostsOption(
  option: AllowedHosts | undefined,
): AllowedHosts | undefined {
  if (option === undefined || option === 'any') {
    return option;
  }
  if (!Array.isArray(option) || option.length === 0) {
    throw new Error(
      "mcpServerChannel: allowedHosts must be a non-empty list of hostnames, or 'any'.",
    );
  }

  return option.map(normalizeHostname);
}

/** eve marks `oauthResource()` with this registered symbol; its settings are not public. */
const OAUTH_RESOURCE_MARK = Symbol.for('eve.channels.auth.oauthResource');

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
  for (const hook of ['onToolError', 'onError', 'register'] as const) {
    if (options[hook] !== undefined && typeof options[hook] !== 'function') {
      throw new Error(`mcpServerChannel: ${hook} must be a function.`);
    }
  }
  const strategies = Array.isArray(options.auth)
    ? options.auth
    : [options.auth];

  if (
    options.oauth === undefined &&
    strategies.some((fn) => OAUTH_RESOURCE_MARK in fn)
  ) {
    throw new Error(
      'mcpServerChannel cannot read oauthResource() settings: pass them as the oauth option.',
    );
  }
}

function semaphore(limit: number): <T>(run: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];

  return async (run) => {
    if (active < limit) {
      active++;
    } else {
      // The finishing call hands its slot over, so no newcomer can take it in between.
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    try {
      return await run();
    } finally {
      const next = waiting.shift();

      if (next) {
        next();
      } else {
        active--;
      }
    }
  };
}

/**
 * Publishes an eve app's own typed tools as an MCP server: 2026-07-28 and,
 * by default, stateless 2025-era serving, through the SDK's `createMcpHandler`.
 * Any file under `agent/channels/` may hold it.
 */
export function mcpServerChannel(options: McpServerChannelOptions): Channel {
  assertOptions(options);

  const { route } = options;
  const legacy = oneOf(
    'legacy',
    options.legacy,
    ['stateless', 'reject'],
    'stateless',
  );
  const responseMode =
    options.responseMode === undefined
      ? undefined
      : oneOf(
          'responseMode',
          options.responseMode,
          ['auto', 'json', 'sse'],
          'auto',
        );
  const limits = {
    maxBodyBytes: positiveInteger(
      'maxBodyBytes',
      options.maxBodyBytes,
      DEFAULT_MAX_BODY_BYTES,
    ),
    timeoutMs: positiveInteger(
      'bodyTimeoutMs',
      options.bodyTimeoutMs,
      DEFAULT_BODY_TIMEOUT_MS,
    ),
  };
  const batches = batchLimits(options.allowBatches);
  const oauth: OAuthConfig | undefined =
    options.oauth && resolveOAuth(options.oauth);
  const allowedHosts = hostsOption(options.allowedHosts);
  const policy: AdmissionPolicy = {
    ...(allowedHosts === undefined ? {} : { allowedHosts }),
    checkOrigin: true,
    https: oneOf(
      'https',
      options.https,
      ['auto', 'trusted-proxy', 'off'],
      'auto',
    ),
  };
  const report: ToolErrorReporter =
    options.onToolError ??
    ((error, errorId) => {
      console.error(`[eve-channel-mcp] tool call failed (${errorId})`, error);
    });
  let misconfigurationReported = false;

  function admit(request: Request, checkOrigin: boolean): Response | null {
    const refused = admissionRefusal(request, { ...policy, checkOrigin });

    if (refused?.status === MISCONFIGURED && !misconfigurationReported) {
      misconfigurationReported = true;
      (options.onError ?? console.error)(
        new Error(
          'eve-channel-mcp: set allowedHosts (or allowedHosts: "any" behind a proxy that checks Host) outside eve dev and Vercel.',
        ),
      );
    }

    return refused;
  }

  async function buildServer(
    scope: McpRequestScope,
    era: McpEra,
  ): Promise<McpServer> {
    const server = new McpServer(
      { name: options.name, version: options.version },
      {
        // Tools never change within a request, and nothing could deliver the notice.
        capabilities: { tools: { listChanged: false } },
        ...(options.instructions === undefined
          ? {}
          : { instructions: options.instructions }),
      },
    );
    const addTool = (tool: McpTool) => tool.register(server, scope);

    for (const tool of options.tools ?? []) {
      addTool(tool);
    }
    await options.register?.(server, {
      ...scope.http,
      addTool,
      auth: scope.auth,
      era,
    });

    return server;
  }

  async function authenticate(
    request: Request,
  ): Promise<Response | SessionAuthContext> {
    const accepted = await routeAuth(request, options.auth);

    if (accepted instanceof Response) {
      return oauth ? withResourceChallenge(accepted, oauth) : accepted;
    }
    const principal = isolatePrincipal(accepted);

    if (principal === null) {
      (options.onError ?? console.error)(
        new Error(
          'eve-channel-mcp: an auth strategy accepted the request without a well-formed principal.',
        ),
      );

      return jsonRpcError(
        MISCONFIGURED,
        SERVER_ERROR,
        'The server could not authenticate this request.',
      );
    }

    return principal;
  }

  async function parse(
    request: Request,
  ): Promise<Response | { parsedBody?: unknown }> {
    // A POST that is not JSON is left to the SDK, which answers 415 without reading it.
    if (
      request.method !== 'POST' ||
      !isJsonContentType(request.headers.get('content-type'))
    ) {
      return {};
    }
    const body = await readJsonRpcBody(request, limits);

    if (!body.ok) {
      return body.response;
    }

    return (
      (await messageRefusal(request, body.value, batches)) ?? {
        parsedBody: body.value,
      }
    );
  }

  async function serve(
    request: Request,
    channel: RouteHandlerArgs,
  ): Promise<Response> {
    const refused = admit(request, true);

    if (refused) {
      return refused;
    }
    const auth = await authenticate(request);

    if (auth instanceof Response) {
      return auth;
    }
    const parsed = await parse(request);

    if (parsed instanceof Response) {
      return parsed;
    }
    const scope: McpRequestScope = {
      auth,
      http: { channel, request, requestIp: channel.requestIp },
      report,
      schedule: semaphore(batches?.concurrency ?? 1),
    };
    // One handler per request: its factory closes over this caller's scope,
    // which the SDK would otherwise carry only as an OAuth-shaped `authInfo`.
    const handler = createMcpHandler(({ era }) => buildServer(scope, era), {
      legacy,
      ...(options.onError === undefined ? {} : { onerror: options.onError }),
      ...(responseMode === undefined ? {} : { responseMode }),
    });

    return handler.fetch(
      request,
      'parsedBody' in parsed ? { parsedBody: parsed.parsedBody } : undefined,
    );
  }

  const metadata = (request: Request): Promise<Response> =>
    Promise.resolve(
      admit(request, false) ?? metadataResponse(request, oauth as OAuthConfig),
    );
  const routes: HttpRouteDefinition[] = [
    ...(oauth
      ? [GET, HEAD, OPTIONS].map((method) =>
          method(oauth.metadataPath, metadata),
        )
      : []),
    POST(route, serve),
    // Stateless in both eras: the SDK answers GET and DELETE with a JSON-RPC 405.
    GET(route, serve),
    DELETE(route, serve),
  ];

  return defineChannel({ routes });
}
