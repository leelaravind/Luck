/**
 * Secret redaction for everything that leaves the process as text: server logs, error
 * messages sent to the browser, stored provider errors and exports.
 *
 * Two layers:
 *  1. Exact values registered at startup by loadConfig() (API keys from .env). Every
 *     occurrence of a registered value is replaced, wherever it appears — also its URL-encoded
 *     and JSON-escaped forms, in any letter case.
 *  2. Common credential shapes, so keys that were never registered (e.g. pasted into a
 *     base URL or echoed back by a provider) are still caught:
 *       sk-ant-…, sk-… / sk-proj-…, "Bearer <token>", "Basic <token>",
 *       "Authorization: <scheme> <value>" (Token, Bot, Digest, …), x-api-key values,
 *       api_key/apiKey/secret/password values, access_token / refresh_token / id_token /
 *       client_secret values (JSON or key=value), ?key= / &token= query params.
 *
 * redact() is pure string → string and never throws, so it is safe inside error handlers.
 */

export const REDACTED = '[redacted]';

/**
 * Values shorter than this are not registered: redacting a 1–3 character string would
 * mangle ordinary text (and such a value is not a real credential anyway).
 */
const MIN_SECRET_LENGTH = 4;

const registered = new Set<string>();
/**
 * Registered secrets and their encoded variants as case-insensitive matchers, longest first so a
 * secret that contains another is removed whole.
 */
let matchers: RegExp[] = [];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Forms in which a secret commonly appears in text: as is, URL-encoded, form-encoded, JSON-escaped. */
function variantsOf(secret: string): string[] {
  const out = new Set<string>([secret]);
  try {
    out.add(encodeURIComponent(secret));
    out.add(encodeURIComponent(secret).replace(/%20/g, '+'));
  } catch {
    /* lone surrogates cannot be URL-encoded; the plain form is still matched */
  }
  out.add(JSON.stringify(secret).slice(1, -1));
  return [...out].filter((v) => v.length >= MIN_SECRET_LENGTH);
}

function rebuildMatchers(): void {
  const all = new Set<string>();
  for (const s of registered) for (const v of variantsOf(s)) all.add(v);
  matchers = [...all]
    .sort((a, b) => b.length - a.length)
    .map((needle) => new RegExp(escapeRegExp(needle), 'gi'));
}

/** Remember a secret value so redact() removes it. Empty / undefined / very short values are ignored. */
export function registerSecret(value: string | undefined): void {
  if (typeof value !== 'string') return;
  const v = value.trim();
  if (v.length < MIN_SECRET_LENGTH || registered.has(v)) return;
  registered.add(v);
  rebuildMatchers();
}

/** Test helper: forget all registered secrets. */
export function clearRegisteredSecrets(): void {
  registered.clear();
  matchers = [];
}

type Rule = [pattern: RegExp, replacement: string | ((match: string, ...groups: string[]) => string)];

/** Authorization schemes whose credential follows after a space ("Authorization: Token abc"). */
const AUTH_SCHEMES = 'Bearer|Basic|Token|Bot|Digest|ApiKey|Api-Key|Key|OAuth|Negotiate|NTLM|SSWS|GenieKey|DeepL-Auth-Key';

/** Pattern rules applied after exact-value replacement. All patterns are linear (no nested quantifiers). */
const RULES: Rule[] = [
  // Anthropic keys: sk-ant-api03-…, sk-ant-admin01-…
  [/\bsk-ant-[A-Za-z0-9_-]{6,}/g, REDACTED],
  // OpenAI-style keys: sk-…, sk-proj-…, sk-svcacct-…
  [/\bsk-[A-Za-z0-9_-]{12,}/g, REDACTED],
  // Authorization header values: "Bearer <token>" / "Basic <credentials>"
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  // "Authorization: <scheme> <credential>" for any common scheme (Token, Bot, Digest, …), or a bare
  // "authorization=<credential>". The scheme name is kept, the credential is masked.
  [
    new RegExp(`(\\bauthorization["']?\\s*[:=]\\s*["']?)((?:${AUTH_SCHEMES})\\s+)?([^\\s"',;}&]+)`, 'gi'),
    (match: string, prefix: string, scheme: string | undefined, value: string) =>
      value === REDACTED ? match : `${prefix}${scheme ?? ''}${REDACTED}`,
  ],
  // x-api-key header values, in header, JSON or key=value form
  [/(x-api-key["']?\s*[:=]\s*["']?)[^\s"',;}&]+/gi, `$1${REDACTED}`],
  // Credentials in query strings: ?key=…, &api_key=…, &access_token=…, &token=…
  [/([?&](?:key|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|client[_-]?secret)=)(?!\[redacted\])[^&\s#"',;]+/gi, `$1${REDACTED}`],
  // Generic "apiKey": "…", api_key=…, secret: …, password=…, "access_token": "…", refresh_token=…
  [
    /((?:api[_-]?key|apikey|client[_-]?secret|secret|password|access[_-]?token|refresh[_-]?token|(?<![A-Za-z])id[_-]?token|session[_-]?token|auth[_-]?token)["']?\s*[:=]\s*["']?)(?!Bearer\b|Basic\b|\[redacted\])[^\s"',;}&]+/gi,
    `$1${REDACTED}`,
  ],
];

/** Replace registered secret values and common key patterns with "[redacted]". */
export function redact(text: string): string {
  let out = typeof text === 'string' ? text : String(text);
  for (const pattern of matchers) out = out.replace(pattern, () => REDACTED);
  for (const [pattern, replacement] of RULES) {
    out = typeof replacement === 'string' ? out.replace(pattern, replacement) : out.replace(pattern, replacement);
  }
  return out;
}
