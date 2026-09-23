/** eve's own MCP channel refuses bodies past 1 MiB; the same bound is the default here. */
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

const PARSE_ERROR = -32_700;
const INVALID_REQUEST = -32_600;
const SERVER_ERROR = -32_000;

const BAD_REQUEST = 400;
const FORBIDDEN = 403;
const PAYLOAD_TOO_LARGE = 413;

export function jsonRpcError(
  status: number,
  code: number,
  message: string,
): Response {
  return Response.json(
    { error: { code, message }, id: null, jsonrpc: '2.0' },
    { status },
  );
}

/**
 * MCP requires servers to check `Origin` against DNS rebinding. A request
 * without one is not from a browser; one from another origin is refused.
 */
export function crossOriginRefusal(request: Request): Response | null {
  const origin = request.headers.get('origin');

  if (!origin) {
    return null;
  }
  let claimed: string;

  try {
    claimed = new URL(origin).origin;
  } catch {
    return jsonRpcError(FORBIDDEN, SERVER_ERROR, 'Invalid Origin header.');
  }

  return claimed === new URL(request.url).origin
    ? null
    : jsonRpcError(FORBIDDEN, SERVER_ERROR, `Invalid Origin: ${claimed}`);
}

async function readCapped(
  request: Request,
  maxBytes: number,
): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'));

  if (Number.isFinite(declared) && declared > maxBytes) {
    return null;
  }
  const reader = request.body?.getReader();

  if (!reader) {
    return '';
  }
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();

      return null;
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks).toString('utf8');
}

export type ParsedBody =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly response: Response };

/**
 * Reads a clone, so the request stays readable for the SDK, and refuses what
 * the SDK should never see: an oversized body, one that is not JSON, and a
 * JSON-RPC batch unless batches are allowed.
 */
export async function readJsonRpcBody(
  request: Request,
  options: { allowBatches: boolean; maxBodyBytes: number },
): Promise<ParsedBody> {
  const text = await readCapped(request.clone(), options.maxBodyBytes);

  if (text === null) {
    return {
      ok: false,
      response: jsonRpcError(
        PAYLOAD_TOO_LARGE,
        SERVER_ERROR,
        'Request body too large.',
      ),
    };
  }
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    return {
      ok: false,
      response: jsonRpcError(BAD_REQUEST, PARSE_ERROR, 'Parse error.'),
    };
  }
  if (Array.isArray(value) && !options.allowBatches) {
    return {
      ok: false,
      response: jsonRpcError(
        BAD_REQUEST,
        INVALID_REQUEST,
        'Batches are not accepted: send one JSON-RPC message per request.',
      ),
    };
  }

  return { ok: true, value };
}
