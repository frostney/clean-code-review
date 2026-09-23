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

/** The second argument of `call`: the shape eve's own MCP tools receive. */
export interface McpToolContext {
  readonly auth: SessionAuthContext;
  /** Aborted when the client disconnects. */
  readonly signal: AbortSignal;
}

/** The third argument of `call`: HTTP details eve's own MCP tools do not get. */
export interface McpHttpContext {
  /** eve's route arguments: `from`, `to`, `attachSession`, `waitUntil`. */
  readonly channel: RouteHandlerArgs;
  readonly request: Request;
  /** Best-effort client address reported by the host; see the README for how far to trust it. */
  readonly requestIp: string | null;
}

/** What one admitted request hands every tool it reaches. */
export interface McpRequestScope {
  readonly auth: SessionAuthContext;
  readonly http: McpHttpContext;
  /** Runs one tool call under the request's concurrency bound. */
  readonly schedule: <T>(run: () => Promise<T>) => Promise<T>;
  readonly report: ToolErrorReporter;
}

export type McpToolErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'conflict'
  | 'internal';

/**
 * A failure the caller should read, in its own words. Anything else a tool
 * throws reaches the client as one generic sentence. Same codes and
 * signature as eve's internal class.
 */
export class McpToolOperationError extends Error {
  override readonly name = 'McpToolOperationError';
  readonly code: McpToolErrorCode;

  constructor(code: McpToolErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export type ToolErrorReporter = (
  error: unknown,
  errorId: string,
) => void | Promise<void>;

type SchemaOutput<TSchema> = TSchema extends StandardSchemaWithJSON
  ? StandardSchemaWithJSON.InferOutput<TSchema>
  : never;

type ErrorResult = CallToolResult & { readonly isError: true };

/** With an output schema, a successful result must carry matching structured content. */
export type McpToolResult<TOutput extends StandardSchemaWithJSON | undefined> =
  TOutput extends StandardSchemaWithJSON
    ?
        | (Omit<CallToolResult, 'isError' | 'structuredContent'> & {
            readonly isError?: false;
            readonly structuredContent: SchemaOutput<TOutput>;
          })
        | ErrorResult
    : CallToolResult;

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

export interface DefineMcpToolOptions<
  TInput extends StandardSchemaWithJSON,
  TOutput extends StandardSchemaWithJSON | undefined,
> {
  readonly definition: McpToolDefinition<TInput, TOutput>;
  call(
    value: SchemaOutput<TInput>,
    context: McpToolContext,
    http: McpHttpContext,
  ): Promise<McpToolResult<TOutput>>;
}

export interface McpTool {
  readonly name: string;
  register(server: McpServer, scope: McpRequestScope): void;
}

const GENERIC_MESSAGE = 'The server could not complete this tool call.';

const reportToConsole: ToolErrorReporter = (error, errorId) => {
  console.error(`[eve-channel-mcp] tool call failed (${errorId})`, error);
};

/** A reporter that throws or rejects must not decide what the client reads. */
function reportSafely(report: ToolErrorReporter, error: unknown): string {
  const errorId = randomUUID();

  try {
    Promise.resolve(report(error, errorId)).catch(() => undefined);
  } catch {
    // Swallowed on purpose: the reporter's own failure has nowhere safe to go.
  }

  return errorId;
}

function toolError(error: {
  code: McpToolErrorCode;
  message: string;
  errorId?: string;
}): ErrorResult {
  const text =
    error.errorId === undefined
      ? error.message
      : `${error.message} (errorId: ${error.errorId})`;

  return {
    content: [{ text, type: 'text' }],
    isError: true,
    structuredContent: {
      error: { ...error, retryable: error.code === 'conflict' },
    },
  };
}

/**
 * The SDK would hand a thrown error's own message to the client, which can
 * carry a stack detail or a dependency's words; this keeps them in the log.
 */
export async function runToolCall(
  run: () => Promise<CallToolResult>,
  report: ToolErrorReporter = reportToConsole,
): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof McpToolOperationError) {
      return toolError({ code: error.code, message: error.message });
    }

    return toolError({
      code: 'internal',
      errorId: reportSafely(report, error),
      message: GENERIC_MESSAGE,
    });
  }
}

type Validate = StandardSchemaWithJSON['~standard']['validate'];
type ValidateResult = Awaited<ReturnType<Validate>>;

/**
 * The SDK runs schemas outside the tool callback and sends whatever they
 * throw to the client. A throw becomes one generic issue; an output schema's
 * issues describe the server's own result, so they are logged, not sent.
 */
export function guardSchema(
  schema: StandardSchemaWithJSON,
  stage: 'input' | 'output',
  report: ToolErrorReporter,
): StandardSchemaWithJSON {
  const standard = schema['~standard'];
  const generic = (error: unknown): ValidateResult => ({
    issues: [
      {
        message: `The server could not check this ${stage} (errorId: ${reportSafely(report, error)}).`,
      },
    ],
  });
  const settle = (result: ValidateResult): ValidateResult =>
    stage === 'output' && result.issues?.length
      ? generic(new Error(result.issues.map((i) => i.message).join('; ')))
      : result;
  const validate: Validate = (value, options) => {
    try {
      const result = standard.validate(value, options);

      return result instanceof Promise
        ? result.then(settle, generic)
        : settle(result);
    } catch (error) {
      return generic(error);
    }
  };

  return { '~standard': { ...standard, validate } };
}

/**
 * The shared shape with eve's internal `defineMcpTool` is `definition` plus
 * an async `call(value, { auth, signal })`. The third argument, the typed
 * structured content and the non-null `auth` are this package's additions.
 */
export function defineMcpTool<
  TInput extends StandardSchemaWithJSON,
  TOutput extends StandardSchemaWithJSON | undefined = undefined,
>(options: DefineMcpToolOptions<TInput, TOutput>): McpTool {
  const { definition } = options;

  return {
    name: definition.name,
    register(server, scope) {
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
          inputSchema: guardSchema(
            definition.inputSchema,
            'input',
            scope.report,
          ),
          ...(definition.outputSchema === undefined
            ? {}
            : {
                outputSchema: guardSchema(
                  definition.outputSchema,
                  'output',
                  scope.report,
                ),
              }),
        },
        (value, ctx) =>
          scope.schedule(() =>
            runToolCall(async () => {
              const result = await options.call(
                // The SDK has validated `value` against this very schema.
                value as SchemaOutput<TInput>,
                { auth: scope.auth, signal: ctx.mcpReq.signal },
                scope.http,
              );

              // Widened for the SDK, which checks it against the output schema.
              return result as unknown as CallToolResult;
            }, scope.report),
          ),
      );
    },
  };
}
