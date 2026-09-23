/**
 * Secret redaction for everything that leaves the process as text: server logs, error
 * messages sent to the browser, stored provider errors and exports.
 *
 * Two layers:
 *  1. Exact values registered at startup by loadConfig() (API keys from .env). Every
 *     occurrence of a registered value is replaced, wherever it appears.
 *  2. Common credential shapes, so keys that were never registered (e.g. pasted into a
 *     base URL or echoed back by a provider) are still caught:
 *       sk-ant-…, sk-… / sk-proj-…, "Bearer <token>", "Basic <token>",
 *       x-api-key values, api_key/apiKey/secret/password values, ?key= / &token= query params.
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
/** Registered secrets, longest first so a secret that contains another is removed whole. */
let ordered: string[] = [];

/** Remember a secret value so redact() removes it. Empty / undefined / very short values are ignored. */
export function registerSecret(value: string | undefined): void {
  if (typeof value !== 'string') return;
  const v = value.trim();
  if (v.length < MIN_SECRET_LENGTH || registered.has(v)) return;
  registered.add(v);
  ordered = [...registered].sort((a, b) => b.length - a.length);
}

/** Test helper: forget all registered secrets. */
export function clearRegisteredSecrets(): void {
  registered.clear();
  ordered = [];
}

type Rule = [pattern: RegExp, replacement: string];

/** Pattern rules applied after exact-value replacement. All patterns are linear (no nested quantifiers). */
const RULES: Rule[] = [
  // Anthropic keys: sk-ant-api03-…, sk-ant-admin01-…
  [/\bsk-ant-[A-Za-z0-9_-]{6,}/g, REDACTED],
  // OpenAI-style keys: sk-…, sk-proj-…, sk-svcacct-…
  [/\bsk-[A-Za-z0-9_-]{12,}/g, REDACTED],
  // Authorization header values: "Bearer <token>" / "Basic <credentials>"
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  // x-api-key header values, in header, JSON or key=value form
  [/(x-api-key["']?\s*[:=]\s*["']?)[^\s"',;}&]+/gi, `$1${REDACTED}`],
  // Credentials in query strings: ?key=…, &api_key=…, &access_token=…, &token=…
  [/([?&](?:key|api[_-]?key|apikey|access[_-]?token|token|secret)=)[^&\s#"']+/gi, `$1${REDACTED}`],
  // Generic "apiKey": "…", api_key=…, secret: …, password=…, authorization: …
  [
    /((?:api[_-]?key|apikey|client[_-]?secret|secret|password|authorization)["']?\s*[:=]\s*["']?)(?!Bearer\b|Basic\b|\[redacted\])[^\s"',;}&]+/gi,
    `$1${REDACTED}`,
  ],
];

/** Replace registered secret values and common key patterns with "[redacted]". */
export function redact(text: string): string {
  let out = typeof text === 'string' ? text : String(text);
  for (const secret of ordered) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  for (const [pattern, replacement] of RULES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
