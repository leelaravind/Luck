/**
 * Secret redaction for everything that leaves the process as text: server logs, error
 * messages sent to the browser, stored provider errors and exports.
 *
 * Two layers:
 *  1. Exact values registered at startup by loadConfig() (API keys from .env). Every
 *     occurrence of a registered value is replaced, wherever it appears:
 *       - values shorter than 8 characters are ignored entirely: they are placeholders such as
 *         OPENAI_API_KEY=ollama / EMPTY / none, not credentials, and masking them would mangle
 *         ordinary words ("ollama" in a provider kind or a URL);
 *       - values of 8–15 characters are matched exactly (same letter case, plain or JSON-escaped);
 *       - values of 16+ characters are also matched in any letter case and in URL-encoded /
 *         form-encoded form (long random keys cannot collide with ordinary text).
 *  2. Common credential shapes, so keys that were never registered (e.g. pasted into a
 *     base URL or echoed back by a provider) are still caught:
 *       sk-ant-…, sk-… / sk-proj-…, "Bearer <token>", "Basic <token>",
 *       "Authorization: <scheme> <value>" (Token, Bot, …; a Digest parameter list is masked
 *       whole), x-api-key values, api_key/apiKey/secret/password values, access_token /
 *       refresh_token / id_token / client_secret values (JSON or key=value), ?key= / &token=
 *       query params.
 *     The key/value rules also match text that sits inside a JSON string, where the quotes are
 *     escaped ({\"access_token\":\"…\"}, also escaped more than once), and they stop before an
 *     escaped closing quote so the surrounding JSON stays intact.
 *
 * redact() is pure string → string and never throws, so it is safe inside error handlers.
 */

export const REDACTED = '[redacted]';

/**
 * Registered values shorter than this are ignored entirely: a short value is a placeholder
 * (Ollama's OpenAI-compatible docs suggest OPENAI_API_KEY=ollama; vLLM uses "EMPTY"), and masking
 * it would corrupt ordinary words and structured fields everywhere redact() runs.
 */
const MIN_SECRET_LENGTH = 8;

/**
 * Registered values at least this long are also matched case-insensitively and URL-/form-encoded.
 * Shorter ones (MIN_SECRET_LENGTH–15 characters) are matched with exact letter case only.
 */
const LOOSE_MATCH_MIN_LENGTH = 16;

const registered = new Set<string>();
/**
 * Registered secrets and their variants as matchers, longest first so a secret that contains
 * another is removed whole.
 */
let matchers: RegExp[] = [];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Forms in which a secret is matched, with the RegExp flags for each. Every secret: as is and
 * JSON-escaped, exact case. Long secrets (16+): also URL-encoded and form-encoded, and all forms in
 * any letter case.
 */
function variantsOf(secret: string): { needle: string; flags: string }[] {
  const forms = new Set<string>([secret, JSON.stringify(secret).slice(1, -1)]);
  const loose = secret.length >= LOOSE_MATCH_MIN_LENGTH;
  if (loose) {
    try {
      forms.add(encodeURIComponent(secret));
      forms.add(encodeURIComponent(secret).replace(/%20/g, '+'));
    } catch {
      /* lone surrogates cannot be URL-encoded; the plain form is still matched */
    }
  }
  return [...forms].filter((v) => v.length >= MIN_SECRET_LENGTH).map((needle) => ({ needle, flags: loose ? 'gi' : 'g' }));
}

function rebuildMatchers(): void {
  const all = new Map<string, { needle: string; flags: string }>();
  for (const s of registered) for (const v of variantsOf(s)) all.set(`${v.flags}:${v.needle}`, v);
  matchers = [...all.values()]
    .sort((a, b) => b.needle.length - a.needle.length)
    .map(({ needle, flags }) => new RegExp(escapeRegExp(needle), flags));
}

/**
 * Remember a secret value so redact() removes it. Empty / undefined values and values shorter than
 * 8 characters (placeholders, see MIN_SECRET_LENGTH) are ignored.
 */
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

/**
 * Start of a word: not preceded by a word character, or preceded by an escaped \n, \r or \t (text
 * inside a JSON string, where "line1\nAuthorization: …" has a literal "n" before the word).
 */
const WORD_START = String.raw`(?:(?<![A-Za-z0-9_])|(?<=\\[nrt]))`;
/** Optional quote next to a key or before a value, plain or escaped (\" in JSON, \\\" in JSON-in-JSON). */
const Q = String.raw`(?:\\*["'])?`;
/** Separator between a key and its value: optional quote, ":" or "=", optional quote. */
const KV = String.raw`${Q}\s*[:=]\s*${Q}`;
/**
 * One character of a credential value. It stops at whitespace, quotes and separators, and at a
 * backslash that starts an escape (\" \\ \' \n \r \t \b \f \u), so an escaped closing quote is never
 * swallowed and the JSON around the value stays valid. A lone backslash elsewhere is part of the value.
 */
const VALUE_CHAR = String.raw`(?:[^\s"',;}&\\]|\\(?![\\"'nrtbfu]))`;
/** Same for query-string values, which also stop at "#". */
const QUERY_VALUE_CHAR = String.raw`(?:[^&\s#"',;\\]|\\(?![\\"'nrtbfu]))`;

/** A single backslash, for building backreferences (\3) inside String.raw patterns. */
const BACKSLASH = '\\';
/**
 * One Digest parameter, name=value; the value is a quoted string (its quotes may be escaped any
 * number of times; group `g` captures the backslashes so the closing quote must match) or a bare token.
 */
const digestParam = (g: number): string => String.raw`[A-Za-z0-9_-]+=(?:(\\*)"[^"]*?${BACKSLASH}${g}"|[^\s,"\\]+)`;

/** Pattern rules applied after exact-value replacement. All patterns are linear (no nested ambiguous quantifiers). */
const RULES: Rule[] = [
  // Anthropic keys: sk-ant-api03-…, sk-ant-admin01-…
  [new RegExp(`${WORD_START}sk-ant-[A-Za-z0-9_-]{6,}`, 'g'), REDACTED],
  // OpenAI-style keys: sk-…, sk-proj-…, sk-svcacct-…
  [new RegExp(`${WORD_START}sk-[A-Za-z0-9_-]{12,}`, 'g'), REDACTED],
  // Authorization header values: "Bearer <token>" / "Basic <credentials>"
  [new RegExp(`${WORD_START}(Bearer|Basic)\\s+[A-Za-z0-9._~+/=-]+`, 'gi'), `$1 ${REDACTED}`],
  // "Authorization: Digest username="…", realm="…", nonce="…", response="…"": the whole parameter
  // list is masked (the response hash is as sensitive as the user name). The scheme name is kept.
  [
    new RegExp(
      `(${WORD_START}authorization${KV})(Digest)\\s+${digestParam(3)}(?:(?:\\s*,\\s*|\\s+)${digestParam(4)})*`,
      'gi',
    ),
    (_match: string, prefix: string, scheme: string) => `${prefix}${scheme} ${REDACTED}`,
  ],
  // "Authorization: <scheme> <credential>" for any common scheme (Token, Bot, …), or a bare
  // "authorization=<credential>". The scheme name is kept, the credential is masked.
  [
    new RegExp(`(${WORD_START}authorization${KV})((?:${AUTH_SCHEMES})\\s+)?(${VALUE_CHAR}+)`, 'gi'),
    (match: string, prefix: string, scheme: string | undefined, value: string) =>
      value === REDACTED ? match : `${prefix}${scheme ?? ''}${REDACTED}`,
  ],
  // x-api-key header values, in header, JSON or key=value form
  [new RegExp(`(x-api-key${KV})${VALUE_CHAR}+`, 'gi'), `$1${REDACTED}`],
  // Credentials in query strings: ?key=…, &api_key=…, &access_token=…, &token=…
  [
    new RegExp(
      `([?&](?:key|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|client[_-]?secret)=)(?!\\[redacted\\])${QUERY_VALUE_CHAR}+`,
      'gi',
    ),
    `$1${REDACTED}`,
  ],
  // Generic "apiKey": "…", api_key=…, secret: …, password=…, "access_token": "…", refresh_token=…
  // (also with escaped quotes: \"access_token\": \"…\")
  [
    new RegExp(
      `((?:api[_-]?key|apikey|client[_-]?secret|secret|password|access[_-]?token|refresh[_-]?token|(?:(?<![A-Za-z])|(?<=\\\\[nrt]))id[_-]?token|session[_-]?token|auth[_-]?token)${KV})(?!Bearer\\b|Basic\\b|\\[redacted\\])${VALUE_CHAR}+`,
      'gi',
    ),
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
