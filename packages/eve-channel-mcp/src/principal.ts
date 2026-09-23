import type { SessionAuthContext } from './tool.js';

type Attributes = SessionAuthContext['attributes'];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function copyAttributes(value: unknown): Attributes | null {
  if (!isRecord(value)) {
    return null;
  }
  const copy: Record<string, string | readonly string[]> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      copy[key] = entry;
    } else if (
      Array.isArray(entry) &&
      entry.every((item) => typeof item === 'string')
    ) {
      copy[key] = Object.freeze([...entry]);
    } else {
      return null;
    }
  }

  return Object.freeze(copy);
}

/**
 * eve's `routeAuth` admits any truthy strategy result, so a verifier that
 * returns `true` or its own `{ ok: false }` would let the caller in. Only a
 * well-formed principal passes, and each request gets its own frozen copy:
 * `none()` and `localDev()` hand every caller the same object.
 */
export function isolatePrincipal(value: unknown): SessionAuthContext | null {
  if (
    !(
      isRecord(value) &&
      isNonEmptyString(value.authenticator) &&
      isNonEmptyString(value.principalId) &&
      isNonEmptyString(value.principalType)
    )
  ) {
    return null;
  }
  const attributes = copyAttributes(value.attributes);

  if (
    attributes === null ||
    (value.issuer !== undefined && typeof value.issuer !== 'string') ||
    (value.subject !== undefined && typeof value.subject !== 'string')
  ) {
    return null;
  }

  return Object.freeze({
    attributes,
    authenticator: value.authenticator,
    principalId: value.principalId,
    principalType: value.principalType,
    ...(value.issuer === undefined ? {} : { issuer: value.issuer }),
    ...(value.subject === undefined ? {} : { subject: value.subject }),
  });
}
