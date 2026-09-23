import { randomUUID } from 'node:crypto';

import type {
  CallToolResult,
  McpServer,
  StandardSchemaWithJSON,
  ToolAnnotations,
} from '@modelcontextprotocol/server';
import type { RouteHandlerArgs } from 'eve/channels';
import type { routeAuth } from 'eve/channels/auth';

/** The principal eve's auth walk accepted; eve does not export the type by name. */
export type SessionAuthContext = Exclude<
  Awaited<ReturnType<typeof routeAuth>>,
  Response
>;

/** What one HTTP request contributes to every tool it reaches. */
export interface McpRequestScope {
  readonly auth: SessionAuthContext;
  /** The route handler's own arguments: `from`, `to`, `attachSession`, `waitUntil`. */
  readonly channel: RouteHandlerArgs;
  readonly request: Request;
  /** Best-effort client address reported by the host, or null. */
  readonly requestIp: string | null;
}

export interface McpToolContext extends McpRequestScope {
  /** Aborted when the client cancels the call or the connection drops. */
  readonly signal: AbortSignal;
}

export interface McpToolDefinition<
  TInput extends StandardSchemaWithJSON,
  TOutput extends StandardSchemaWithJSON | undefined,
> {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly annotations?: ToolAnnotations;
  readonly inputSchema: TInput;
  readonly outputSchema?: TOutput;
}

export interface McpToolInput<
  TInput extends StandardSchemaWithJSON,
  TOutput extends StandardSchemaWithJSON | undefined,
> {
  readonly definition: McpToolDefinition<TInput, TOutput>;
  call(
    value: StandardSchemaWithJSON.InferOutput<TInput>,
    context: McpToolContext,
  ): CallToolResult | Promise<CallToolResult>;
}

export interface McpTool {
  readonly name: string;
  register(
    server: McpServer,
    scope: McpRequestScope,
    report?: ToolErrorReporter,
  ): void;
}

/**
 * A failure the caller should read, in its own words. Anything else a tool
 * throws reaches the client as one generic sentence.
 */
export class McpToolOperationError extends Error {
  override readonly name = 'McpToolOperationError';
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean } = {},
  ) {
    super(message);
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

export type ToolErrorReporter = (error: unknown, errorId: string) => void;

const reportToConsole: ToolErrorReporter = (error, errorId) => {
  console.error(`[eve-channel-mcp] tool call failed (${errorId})`, error);
};

function toolError(error: {
  code: string;
  message: string;
  retryable: boolean;
  errorId?: string;
}): CallToolResult {
  const text =
    error.errorId === undefined
      ? error.message
      : `${error.message} (errorId: ${error.errorId})`;

  return {
    content: [{ text, type: 'text' }],
    isError: true,
    structuredContent: { error },
  };
}

/**
 * The SDK would hand a thrown error's own message to the client, which can
 * carry a stack detail or a dependency's words; this keeps them in the log.
 */
export async function runToolCall(
  run: () => CallToolResult | Promise<CallToolResult>,
  report: ToolErrorReporter = reportToConsole,
): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof McpToolOperationError) {
      return toolError({
        code: error.code,
        message: error.message,
        retryable: error.retryable,
      });
    }
    const errorId = randomUUID();

    report(error, errorId);

    return toolError({
      code: 'internal',
      errorId,
      message: 'The server could not complete this tool call.',
      retryable: false,
    });
  }
}

/**
 * Mirrors eve's internal `defineMcpTool` shape, so moving to eve's transport,
 * should it ever be exported, is a change of import.
 */
export function defineMcpTool<
  TInput extends StandardSchemaWithJSON,
  TOutput extends StandardSchemaWithJSON | undefined = undefined,
>(input: McpToolInput<TInput, TOutput>): McpTool {
  const { definition } = input;

  // Erased to the SDK's non-generic overload: its callback type is conditional
  // on the schema, which TypeScript cannot resolve for a generic one.
  const inputSchema: StandardSchemaWithJSON = definition.inputSchema;
  const outputSchema: StandardSchemaWithJSON | undefined =
    definition.outputSchema;

  return {
    name: definition.name,
    register(server, scope, report) {
      server.registerTool(
        definition.name,
        {
          ...(definition.title === undefined
            ? {}
            : { title: definition.title }),
          ...(definition.description === undefined
            ? {}
            : { description: definition.description }),
          ...(definition.annotations === undefined
            ? {}
            : { annotations: definition.annotations }),
          inputSchema,
          ...(outputSchema === undefined ? {} : { outputSchema }),
        },
        (value, ctx) =>
          runToolCall(
            () =>
              input.call(
                // The SDK has validated `value` against this very schema.
                value as StandardSchemaWithJSON.InferOutput<TInput>,
                { ...scope, signal: ctx.mcpReq.signal },
              ),
            report,
          ),
      );
    },
  };
}
