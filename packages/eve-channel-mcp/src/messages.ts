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

/** RFC 9110 optional whitespace is spaces and tabs only. */
function stripOws(value: string): string {
  return value.replace(/^[ \t]+|[ \t]+$/g, '');
}

const SENTINEL_PREFIX = '=?base64?';
const SENTINEL_SUFFIX = '?=';
const CANONICAL_BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * `Mcp-Name` as the SDK reads it: a non-ASCII name arrives as
 * `=?base64?…?=`. The SDK does not export its decoder, so this is a copy of
 * its rule; undefined means a malformed sentinel.
 */
export function decodeMcpName(value: string): string | undefined {
  if (!(value.startsWith(SENTINEL_PREFIX) && value.endsWith(SENTINEL_SUFFIX))) {
    return value;
  }
  const encoded = value.slice(SENTINEL_PREFIX.length, -SENTINEL_SUFFIX.length);

  if (!CANONICAL_BASE64.test(encoded)) {
    return undefined;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.from(encoded, 'base64'),
    );
  } catch {
    return undefined;
  }
}

function mismatch(message: Message, detail: string): Response {
  return jsonRpcError(
    BAD_REQUEST,
    HEADER_MISMATCH,
    `Bad Request: the request headers and body disagree: ${detail}`,
    requestId(message),
  );
}

function isRequest(message: Message): message is Message & { method: string } {
  return (
    typeof message.method === 'string' &&
    (typeof message.id === 'string' || typeof message.id === 'number')
  );
}

/** The SDK's own comparison, applied to a request it would not check. */
function headerMismatch(
  message: Message & { method: string },
  method: string | null,
  name: string | null,
): Response | null {
  if (method !== null && stripOws(method) !== message.method) {
    return mismatch(
      message,
      `Mcp-Method is ${stripOws(method)} but the body names ${message.method}`,
    );
  }
  const field = Object.hasOwn(NAME_FIELD, message.method)
    ? NAME_FIELD[message.method]
    : undefined;

  if (name === null || field === undefined) {
    return null;
  }
  const decoded = decodeMcpName(stripOws(name));
  const source = (asMessage(message.params) as Record<string, unknown>)[field];

  if (decoded === undefined) {
    return mismatch(
      message,
      'the Mcp-Name header carries an invalid Base64 sentinel value',
    );
  }

  return typeof source === 'string' && decoded !== source
    ? mismatch(message, `Mcp-Name is ${decoded} but the body names ${source}`)
    : null;
}

/**
 * The SDK checks `Mcp-Method` and `Mcp-Name` only on 2026-07-28 requests.
 * The same check runs here on a 2025-era request that carries them, so a
 * policy that reads the headers cannot be steered past by the body.
 * Notifications are left alone, as the SDK leaves them.
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

  return isRequest(message) ? headerMismatch(message, method, name) : null;
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
