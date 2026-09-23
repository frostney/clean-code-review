import { randomUUID } from 'node:crypto';

import type {
  CallToolResult,
  McpServer,
  StandardSchemaWithJSON,
  ToolAnnotations,
} from '@modelcontextprotocol/server';
import type { RouteHandlerArgs } from 'eve/channels';
import type { routeAuth } from 'eve/channels/auth';

import type { Schedule } from './schedule.js';

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
  /** Runs one tool call, validation included, under the request's concurrency bound. */
  readonly schedule: Schedule;
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

type Standard = StandardSchemaWithJSON['~standard'];
type ValidateResult = Awaited<ReturnType<Standard['validate']>>;
type Issue = NonNullable<ValidateResult['issues']>[number];

/** The SDK's own wording, so a client sees the same text either way. */
function formatIssues(issues: readonly Issue[]): string {
  return issues
    .map((issue) =>
      issue.path?.length
        ? `${issue.path.map((p) => String(typeof p === 'object' ? p.key : p)).join('.')}: ${issue.message}`
        : issue.message,
    )
    .join(', ');
}

function textError(text: string): CallToolResult {
  return { content: [{ text, type: 'text' }], isError: true };
}

const CANCELLED = textError('The call was cancelled.');

/**
 * What the SDK is given: the schema's JSON Schema for listing, and a
 * validator that accepts anything. The real validation runs in
 * `executeTool`, under the concurrency bound and with one catch for every
 * way a schema can fail. A conversion that throws is reported and replaced
 * by one generic message, since the SDK would send its text on `tools/list`.
 */
export function describeOnly(
  schema: StandardSchemaWithJSON,
  report: ToolErrorReporter,
): StandardSchemaWithJSON {
  const standard = schema['~standard'];
  const convert =
    (io: 'input' | 'output'): Standard['jsonSchema']['input'] =>
    (options) => {
      try {
        return standard.jsonSchema[io](options);
      } catch (error) {
        throw new Error(
          `The server could not describe this tool (errorId: ${reportSafely(report, error)}).`,
        );
      }
    };

  return {
    '~standard': {
      ...standard,
      jsonSchema: { input: convert('input'), output: convert('output') },
      validate: (value) => ({ value }),
    },
  };
}

/**
 * Validates, calls and validates again. A schema that throws, synchronously
 * or through a promise from any realm, becomes one generic issue; an output
 * schema's issues describe the server's own result, so they are logged and
 * not sent.
 */
export async function executeTool(
  definition: McpToolDefinition<
    StandardSchemaWithJSON,
    StandardSchemaWithJSON | undefined
  >,
  call: (value: unknown) => Promise<CallToolResult>,
  value: unknown,
  signal: AbortSignal,
  report: ToolErrorReporter,
): Promise<CallToolResult> {
  const inputError = (detail: string) =>
    textError(
      `Input validation error: Invalid arguments for tool ${definition.name}: ${detail}`,
    );
  let input: unknown;

  try {
    const checked = await definition.inputSchema['~standard'].validate(
      value ?? {},
    );

    if (checked.issues?.length) {
      return inputError(formatIssues(checked.issues));
    }
    input = 'value' in checked ? checked.value : undefined;
  } catch (error) {
    return inputError(
      `The server could not check this input (errorId: ${reportSafely(report, error)}).`,
    );
  }
  if (signal.aborted) {
    return CANCELLED;
  }
  const result = await runToolCall(() => call(input), report);
  const output = definition.outputSchema;

  if (
    output === undefined ||
    result.isError ||
    result.structuredContent === undefined
  ) {
    return result;
  }
  try {
    const checked = await output['~standard'].validate(
      result.structuredContent,
    );

    if (!checked.issues?.length) {
      return result;
    }
    throw new Error(formatIssues(checked.issues));
  } catch (error) {
    return textError(
      `Output validation error: Invalid structured content for tool ${definition.name}: The server could not check this output (errorId: ${reportSafely(report, error)}).`,
    );
  }
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
          inputSchema: describeOnly(definition.inputSchema, scope.report),
          ...(definition.outputSchema === undefined
            ? {}
            : {
                outputSchema: describeOnly(
                  definition.outputSchema,
                  scope.report,
                ),
              }),
        },
        (value, ctx) => {
          const signal = ctx.mcpReq.signal;

          return scope.schedule(
            signal,
            () =>
              executeTool(
                definition,
                async (input) =>
                  // Widened for the SDK; `input` passed this very schema, and
                  // the result is checked against the output schema.
                  (await options.call(
                    input as SchemaOutput<TInput>,
                    { auth: scope.auth, signal },
                    scope.http,
                  )) as unknown as CallToolResult,
                value,
                signal,
                scope.report,
              ),
            () => CANCELLED,
          );
        },
      );
    },
  };
}
