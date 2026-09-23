/** eve's own MCP channel refuses bodies past 1 MiB; the same bound is the default here. */
export const DEFAULT_MAX_BODY_BYTES = 1_048_576;

/** A caller under the byte limit could otherwise hold the read, and the function, open. */
export const DEFAULT_BODY_TIMEOUT_MS = 10_000;

const PARSE_ERROR = -32_700;
const SERVER_ERROR = -32_000;

const BAD_REQUEST = 400;
const REQUEST_TIMEOUT = 408;
const PAYLOAD_TOO_LARGE = 413;

export function jsonRpcError(
  status: number,
  code: number,
  message: string,
  id: string | number | null = null,
): Response {
  return Response.json(
    { error: { code, message }, id, jsonrpc: '2.0' },
    { status },
  );
}

export type ParsedBody =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly response: Response };

function refused(status: number, code: number, message: string): ParsedBody {
  return { ok: false, response: jsonRpcError(status, code, message) };
}

/**
 * Not awaited: cancelling can wait on the peer that is still sending, which
 * is the caller this bound exists to stop.
 */
function abandon(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  reader.cancel().catch(() => undefined);
}

const TIMED_OUT = Symbol('timed out');

type Read =
  | { kind: 'text'; text: string }
  | { kind: 'too-large' }
  | { kind: 'timeout' }
  | { kind: 'failed' };

async function readCapped(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
  timeoutMs: number,
): Promise<Read> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const next = await Promise.race([reader.read(), expired]);

      if (next === TIMED_OUT) {
        abandon(reader);

        return { kind: 'timeout' };
      }
      if (next.done) {
        return { kind: 'text', text: Buffer.concat(chunks).toString('utf8') };
      }
      total += next.value.byteLength;
      if (total > maxBytes) {
        abandon(reader);

        return { kind: 'too-large' };
      }
      chunks.push(next.value);
    }
  } catch {
    abandon(reader);

    return { kind: 'failed' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads the request's own stream once, so the SDK is handed `parsedBody`
 * and never reads it again, and refuses a body that is too large, too slow,
 * unreadable or not JSON.
 */
export async function readJsonRpcBody(
  request: Request,
  limits: { maxBodyBytes: number; timeoutMs: number },
): Promise<ParsedBody> {
  const reader = request.body?.getReader();
  const declared = Number(request.headers.get('content-length'));

  if (Number.isFinite(declared) && declared > limits.maxBodyBytes) {
    if (reader) {
      abandon(reader);
    }

    return refused(PAYLOAD_TOO_LARGE, SERVER_ERROR, 'Request body too large.');
  }
  const read = reader
    ? await readCapped(reader, limits.maxBodyBytes, limits.timeoutMs)
    : { kind: 'text' as const, text: '' };

  switch (read.kind) {
    case 'too-large':
      return refused(
        PAYLOAD_TOO_LARGE,
        SERVER_ERROR,
        'Request body too large.',
      );
    case 'timeout':
      return refused(
        REQUEST_TIMEOUT,
        SERVER_ERROR,
        'The request body did not arrive in time.',
      );
    case 'failed':
      return refused(
        BAD_REQUEST,
        PARSE_ERROR,
        'The request body could not be read.',
      );
    default:
      try {
        return { ok: true, value: JSON.parse(read.text) };
      } catch {
        return refused(BAD_REQUEST, PARSE_ERROR, 'Parse error.');
      }
  }
}
