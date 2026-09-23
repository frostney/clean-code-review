import { isLegacyRequest } from '@modelcontextprotocol/server';

import { jsonRpcError } from './request.js';

/**
 * Checks on the parsed JSON-RPC body before the SDK sees it: batches,
 * methods this stateless channel cannot serve, and routing headers that
 * disagree with the body.
 */

const METHOD_NOT_FOUND = -32_601;
const INVALID_REQUEST = -32_600;
/** The SDK's own code for a header that disagrees with the body. */
const HEADER_MISMATCH = -32_020;

const OK = 200;
const BAD_REQUEST = 400;

export interface BatchLimits {
  readonly maxMessages: number;
  readonly concurrency: number;
}

interface Message {
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function asMessage(value: unknown): Message {
  return typeof value === 'object' && value !== null ? (value as Message) : {};
}

function requestId(message: Message): string | number | null {
  return typeof message.id === 'string' || typeof message.id === 'number'
    ? message.id
    : null;
}

/** The body field `Mcp-Name` mirrors, per method (SEP-2243). */
const NAME_FIELD: Readonly<Record<string, 'name' | 'uri'>> = {
  'prompts/get': 'name',
  'resources/read': 'uri',
  'tools/call': 'name',
};

function nameOf(message: Message): unknown {
  const field =
    typeof message.method === 'string' ? NAME_FIELD[message.method] : undefined;
  const params = asMessage(message.params) as Record<string, unknown>;

  return field === undefined ? undefined : params[field];
}

function mismatch(message: Message, detail: string): Response {
  return jsonRpcError(
    BAD_REQUEST,
    HEADER_MISMATCH,
    `Bad Request: the request headers and body disagree: ${detail}`,
    requestId(message),
  );
}

/**
 * The SDK checks `Mcp-Method` and `Mcp-Name` only on 2026-07-28 requests.
 * A 2025-era body with headers that name another operation is refused here,
 * so a policy that reads the headers cannot be steered past by the body.
 */
async function legacyHeaderRefusal(
  request: Request,
  body: unknown,
): Promise<Response | null> {
  const method = request.headers.get('mcp-method');
  const name = request.headers.get('mcp-name');

  if (
    (method === null && name === null) ||
    !(await isLegacyRequest(request, body))
  ) {
    return null;
  }
  if (Array.isArray(body)) {
    return mismatch({}, 'a batch cannot carry Mcp-Method or Mcp-Name');
  }
  const message = asMessage(body);

  if (method !== null && method.trim() !== message.method) {
    return mismatch(
      message,
      `Mcp-Method is ${method.trim()} but the body names ${String(message.method)}`,
    );
  }
  if (name !== null && name.trim() !== nameOf(message)) {
    return mismatch(
      message,
      `Mcp-Name is ${name.trim()} but the body names ${String(nameOf(message))}`,
    );
  }

  return null;
}

/**
 * `subscriptions/listen` holds a stream open for notifications, but each
 * request here gets its own event bus that nothing publishes to, and the
 * SDK's cap on open streams counts per handler, so per request.
 */
function subscriptionRefusal(messages: readonly Message[]): Response | null {
  const listen = messages.find((m) => m.method === 'subscriptions/listen');

  return listen === undefined
    ? null
    : jsonRpcError(
        OK,
        METHOD_NOT_FOUND,
        'Method not found: subscriptions/listen is not served by this stateless endpoint.',
        requestId(listen),
      );
}

function batchRefusal(
  body: readonly unknown[],
  batches: BatchLimits | null,
): Response | null {
  if (batches === null) {
    return jsonRpcError(
      BAD_REQUEST,
      INVALID_REQUEST,
      'Batches are not accepted: send one JSON-RPC message per request.',
    );
  }
  if (body.length === 0 || body.length > batches.maxMessages) {
    return jsonRpcError(
      BAD_REQUEST,
      INVALID_REQUEST,
      `A batch must hold between 1 and ${batches.maxMessages} messages.`,
    );
  }

  return null;
}

export async function messageRefusal(
  request: Request,
  body: unknown,
  batches: BatchLimits | null,
): Promise<Response | null> {
  if (Array.isArray(body)) {
    const refused = batchRefusal(body, batches);

    if (refused) {
      return refused;
    }
  }
  const messages = (Array.isArray(body) ? body : [body]).map(asMessage);

  return (
    subscriptionRefusal(messages) ?? (await legacyHeaderRefusal(request, body))
  );
}
