import { afterEach, describe, expect, it } from 'vitest';
import { REDACTED, clearRegisteredSecrets, redact, registerSecret } from './redact.js';

afterEach(() => clearRegisteredSecrets());

describe('registered secrets', () => {
  it('removes every occurrence of a registered value', () => {
    registerSecret('my-local-laya-token');
    expect(redact('token my-local-laya-token and again my-local-laya-token.')).toBe(`token ${REDACTED} and again ${REDACTED}.`);
  });

  it('removes the longer secret whole when one secret contains another', () => {
    registerSecret('fixture1');
    registerSecret('fixture1-efgh-ijkl');
    expect(redact('x fixture1-efgh-ijkl y fixture1')).toBe(`x ${REDACTED} y ${REDACTED}`);
  });

  it('handles values with regex/replacement special characters literally', () => {
    registerSecret('p$a.s*s(1)');
    expect(redact('pw=p$a.s*s(1)!')).toBe(`pw=${REDACTED}!`);
  });

  it('ignores undefined, empty, whitespace and very short values', () => {
    registerSecret(undefined);
    registerSecret('');
    registerSecret('   ');
    registerSecret('ab');
    expect(redact('ab cd')).toBe('ab cd');
  });

  it('ignores placeholder values shorter than 8 characters entirely (OPENAI_API_KEY=ollama, EMPTY, none)', () => {
    for (const placeholder of ['ollama', 'EMPTY', 'none', 'fake', 'test123']) registerSecret(placeholder);
    const text = 'kind ollama at http://127.0.0.1:11434/ollama/v1 — EMPTY none fake test123 OLLAMA Ollama';
    expect(redact(text)).toBe(text);
    // Encoded / JSON-escaped forms are not matched either.
    expect(redact(JSON.stringify({ kind: 'ollama', note: 'EMPTY' }))).toBe('{"kind":"ollama","note":"EMPTY"}');
  });

  it('matches 8–15 character values with exact letter case only (plain and JSON-escaped, not URL-encoded)', () => {
    registerSecret('lm-studio'); // 9 characters: LM Studio's documented placeholder key
    expect(redact('key lm-studio here')).toBe(`key ${REDACTED} here`);
    expect(redact('LM-Studio and LM-STUDIO are product names')).toBe('LM-Studio and LM-STUDIO are product names');

    registerSecret('fx/te"st:15ch'); // 13 characters with characters that URL- and JSON-encode differently
    expect(redact('raw fx/te"st:15ch')).toBe(`raw ${REDACTED}`);
    expect(redact(JSON.stringify({ v: 'fx/te"st:15ch' }))).toBe(`{"v":"${REDACTED}"}`);
    const encoded = encodeURIComponent('fx/te"st:15ch');
    expect(redact(`q=${encoded}`)).toBe(`q=${encoded}`);
    expect(redact('FX/TE"ST:15CH')).toBe('FX/TE"ST:15CH');
  });

  it('switches to case-insensitive and URL-encoded matching at exactly 16 characters', () => {
    registerSecret('fixture-15-chars'); // 16
    registerSecret('fixture/15chars'); // 15
    expect('fixture-15-chars').toHaveLength(16);
    expect('fixture/15chars').toHaveLength(15);
    expect(redact('a FIXTURE-15-CHARS b')).toBe(`a ${REDACTED} b`);
    expect(redact('a FIXTURE/15CHARS b')).toBe('a FIXTURE/15CHARS b');
    expect(redact(`a ${encodeURIComponent('fixture/15chars')} b`)).toBe(`a ${encodeURIComponent('fixture/15chars')} b`);
    expect(redact('a fixture/15chars b')).toBe(`a ${REDACTED} b`);
  });

  it('trims registered values', () => {
    registerSecret('  spaced-secret-value  ');
    expect(redact('see spaced-secret-value')).toBe(`see ${REDACTED}`);
  });

  it('removes upper-case, lower-case and mixed-case copies of a registered value', () => {
    registerSecret('LayaToken-AbC123xyz');
    expect(redact('a LAYATOKEN-ABC123XYZ b layatoken-abc123xyz c LayaToken-AbC123xyz')).toBe(`a ${REDACTED} b ${REDACTED} c ${REDACTED}`);
  });

  it('removes URL-encoded (and form-encoded) copies of a registered value', () => {
    registerSecret('p@ss/word+key=1 2');
    const encoded = encodeURIComponent('p@ss/word+key=1 2'); // p%40ss%2Fword%2Bkey%3D1%202
    expect(redact(`GET /x?q=${encoded}&y=1`)).toBe(`GET /x?q=${REDACTED}&y=1`);
    expect(redact(`body q=${encoded.replace(/%20/g, '+')}`)).toBe(`body q=${REDACTED}`);
    // Percent-encoding hex digits in lower case are matched too.
    expect(redact(`q=${encoded.toLowerCase()}`)).toBe(`q=${REDACTED}`);
  });

  it('removes JSON-escaped copies of a registered value', () => {
    registerSecret('quote"back\\slash-secret');
    const json = JSON.stringify({ echoed: 'quote"back\\slash-secret' });
    expect(json).not.toContain('quote"back'); // it is escaped in JSON
    expect(redact(json)).toBe(`{"echoed":"${REDACTED}"}`);
  });
});

describe('key patterns (never registered)', () => {
  it.each([
    ['Anthropic key', 'error for sk-ant-api03-AbC_dEf-1234567890xyz here', `error for ${REDACTED} here`],
    ['OpenAI project key', 'key=sk-proj-AbCdEfGhIjKlMnOpQrSt', 'key=[redacted]'],
    ['OpenAI key', 'using sk-1234567890abcdefghij now', `using ${REDACTED} now`],
    ['Bearer token', 'Authorization: Bearer eyJhbGciOi.J9.abc-_+/=', `Authorization: Bearer ${REDACTED}`],
    ['Basic auth', 'authorization: Basic dXNlcjpwYXNz', `authorization: Basic ${REDACTED}`],
    ['x-api-key header', 'x-api-key: abc123def456', `x-api-key: ${REDACTED}`],
    ['x-api-key JSON', '{"x-api-key":"abc123def456","other":1}', `{"x-api-key":"${REDACTED}","other":1}`],
    ['?key= query', 'GET https://example.com/v1/models?key=AIzaSyA-123&alt=json', `GET https://example.com/v1/models?key=${REDACTED}&alt=json`],
    ['&api_key= query', 'https://h/x?a=1&api_key=zzz999', `https://h/x?a=1&api_key=${REDACTED}`],
    ['apiKey JSON field', '{"apiKey":"plain-value-123"}', `{"apiKey":"${REDACTED}"}`],
    ['Authorization: Token', 'Authorization: Token abcdefghijkl123', `Authorization: Token ${REDACTED}`],
    ['Authorization: Bot (JSON header)', '{"Authorization":"Bot MTk4NjIyNDgzNDcx.Cl2FMQ"}', `{"Authorization":"Bot ${REDACTED}"}`],
    ['bare authorization value', 'authorization=abc123def456', `authorization=${REDACTED}`],
    ['access_token JSON', '{"access_token":"fixture-access-token-0001","expires_in":3599}', `{"access_token":"${REDACTED}","expires_in":3599}`],
    ['refresh_token JSON', '{"refresh_token": "1//0gLx-refresh"}', `{"refresh_token": "${REDACTED}"}`],
    ['id_token JSON', '{"id_token":"eyJ-fixture-id-token.e30.sig"}', `{"id_token":"${REDACTED}"}`],
    ['client_secret JSON', '{"client_secret":"fixture-client-secret-0001"}', `{"client_secret":"${REDACTED}"}`],
    ['camelCase accessToken', '{"accessToken":"fixture-access-token-0002"}', `{"accessToken":"${REDACTED}"}`],
    ['refresh_token= form', 'grant_type=refresh_token&refresh_token=rt-abc123&x=1', `grant_type=refresh_token&refresh_token=${REDACTED}&x=1`],
  ])('%s', (_name, input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  describe('JSON with escaped quotes (a JSON answer quoted inside rawOutput, audit #35)', () => {
    const KEYS = ['access_token', 'refresh_token', 'id_token', 'api_key', 'apiKey', 'secret', 'client_secret', 'x-api-key'];

    it.each(KEYS)('%s inside an escaped JSON string', (key) => {
      const once = String.raw`{\"${key}\": \"fixture-value-0001\", \"n\": 1}`;
      expect(redact(once)).toBe(String.raw`{\"${key}\": \"${REDACTED}\", \"n\": 1}`);
      // Escaped twice (JSON inside JSON inside JSON).
      const twice = String.raw`{\\\"${key}\\\":\\\"fixture-value-0002\\\"}`;
      expect(redact(twice)).toBe(String.raw`{\\\"${key}\\\":\\\"${REDACTED}\\\"}`);
    });

    it.each([
      ['bare credential', String.raw`{\"authorization\":\"fixture-auth-0003\"}`, String.raw`{\"authorization\":\"${REDACTED}\"}`],
      ['Token scheme', String.raw`{\"Authorization\": \"Token fixture-tok-0004\"}`, String.raw`{\"Authorization\": \"Token ${REDACTED}\"}`],
      ['Bearer scheme', String.raw`{\"Authorization\":\"Bearer fixture.bearer-0005\"}`, String.raw`{\"Authorization\":\"Bearer ${REDACTED}\"}`],
    ])('authorization inside an escaped JSON string: %s', (_name, input, expected) => {
      expect(redact(input)).toBe(expected);
    });

    it('masks the token in a stored rawOutput and keeps it valid JSON (end-to-end shape from the audit)', () => {
      const answer = { action: 'skip', explanation: 'I found {"access_token": "acc3ssT0kenVal-fixture", "refresh_token": "rt-fixture-9"} in my context' };
      const rawOutput = JSON.stringify(answer);
      expect(rawOutput).toContain(String.raw`{\"access_token\": \"acc3ssT0kenVal-fixture\"`);
      const masked = redact(rawOutput);
      expect(masked).not.toContain('acc3ssT0kenVal');
      expect(masked).not.toContain('rt-fixture-9');
      const parsed = JSON.parse(masked) as typeof answer;
      expect(parsed.explanation).toBe(`I found {"access_token": "${REDACTED}", "refresh_token": "${REDACTED}"} in my context`);
      // And once more as a string field of an outer JSON document (the export).
      const outer = JSON.stringify({ rawOutput });
      expect(JSON.parse(redact(outer))).toEqual({ rawOutput: masked });
    });

    it('never swallows an escaped closing quote (query values, x-api-key, generic values)', () => {
      expect(redact(String.raw`\"see https://x.test/a?key=fixture123\" ok`)).toBe(String.raw`\"see https://x.test/a?key=${REDACTED}\" ok`);
      expect(redact(String.raw`{\"note\":\"x-api-key: fixture-abc\n\\\"q\\\"\"}`)).toBe(String.raw`{\"note\":\"x-api-key: ${REDACTED}\n\\\"q\\\"\"}`);
      expect(redact(String.raw`password=fixture-pw\"y`)).toBe(String.raw`password=${REDACTED}\"y`);
      // A backslash that does not start an escape is part of the value (masked, not leaked).
      expect(redact(String.raw`secret=fixture\part2 next`)).toBe(`secret=${REDACTED} next`);
    });

    it('finds keys right after an escaped newline or tab inside a JSON string', () => {
      expect(redact(String.raw`"line1\nAuthorization: Token fixture-tok-6"`)).toBe(String.raw`"line1\nAuthorization: Token ${REDACTED}"`);
      expect(redact(String.raw`"line1\nid_token=fixture-idt-7"`)).toBe(String.raw`"line1\nid_token=${REDACTED}"`);
      expect(redact(String.raw`"line1\tBearer fixture-bearer-8"`)).toBe(String.raw`"line1\tBearer ${REDACTED}"`);
      expect(redact(String.raw`"line1\nsk-fixture-0000000000test"`)).toBe(String.raw`"line1\n${REDACTED}"`);
    });
  });

  describe('Authorization: Digest (whole parameter list masked)', () => {
    it('masks every parameter, including the response hash, and keeps the scheme name', () => {
      const header =
        'Authorization: Digest username="fixture-user", realm="fixture realm", nonce="fixture-nonce", uri="/x", qop=auth, nc=00000001, cnonce="fixture-cnonce", response="fixture-response-hash-0001", opaque="fixture-opaque"';
      const out = redact(header);
      expect(out).toBe(`Authorization: Digest ${REDACTED}`);
      expect(out).not.toContain('fixture-response-hash');
      expect(out).not.toContain('fixture-user');
    });

    it('keeps the text after the header and JSON around it intact', () => {
      expect(redact('Authorization: Digest username="u", response="fixture-hash"\r\nHost: x.test')).toBe(`Authorization: Digest ${REDACTED}\r\nHost: x.test`);
      const json = JSON.stringify({ Authorization: 'Digest username="u", response="fixture-hash"', other: 1 });
      const masked = redact(json);
      expect(JSON.parse(masked)).toEqual({ Authorization: `Digest ${REDACTED}`, other: 1 });
      const nested = JSON.stringify({ rawOutput: json });
      expect(JSON.parse(redact(nested))).toEqual({ rawOutput: masked });
    });
  });

  it('stays fast on pathological input (no catastrophic backtracking)', () => {
    const n = 100_000;
    const inputs = [
      `authorization: Digest ${'a=b '.repeat(n)}`,
      `authorization: Digest ${'a="'.repeat(n)}`,
      `authorization: Digest a=${'\\'.repeat(n)}`,
      `Authorization: Digest ${'a=\\\\\\"x, '.repeat(n)}`,
      `api_key${'\\'.repeat(n)}`,
      `api_key:${'\\'.repeat(n)}x`,
      '\\n'.repeat(n),
      `secret=${'\\"'.repeat(n)}`,
      `?key=${'\\x'.repeat(n)}`,
      '{\\"access_token\\": '.repeat(n / 10),
    ];
    for (const input of inputs) {
      const start = performance.now();
      redact(input);
      expect(performance.now() - start).toBeLessThan(2_000);
    }
  });

  it('is idempotent on already-masked text', () => {
    for (const s of [
      'Authorization: Bearer abc.def',
      'Authorization: Token abc',
      '{"access_token":"abc"}',
      'x?token=abc&y=1',
      String.raw`{\"access_token\": \"fixture-idem\"}`,
      'Authorization: Digest username="u", response="fixture-hash"',
      String.raw`{\"Authorization\":\"Digest username=\\\"u\\\", response=\\\"h\\\"\"}`,
    ]) {
      const once = redact(s);
      expect(redact(once)).toBe(once);
    }
  });

  it('does not treat words that merely end in "id_token"-like text or mention authorization as credentials', () => {
    expect(redact('valid_token: yes')).toBe('valid_token: yes');
    expect(redact('Authorization header missing')).toBe('Authorization header missing');
    expect(redact('Token usage: 120 input, 30 output')).toBe('Token usage: 120 input, 30 output');
  });

  it('does not mangle ordinary text', () => {
    const text = 'Round 12 settled: red 23, net +V$ 1.00 (sk-learn is a library; skip)';
    expect(redact(text)).toBe(text);
  });

  it('never throws on odd input', () => {
    expect(redact('')).toBe('');
    expect(redact(undefined as unknown as string)).toBe('undefined');
  });

  it('query-string masking stops at "," and ";" so neighbouring text (e.g. CSV cells) survives', () => {
    expect(redact('url https://x.test/a?key=abc123XYZ,next_cell;other')).toBe('url https://x.test/a?key=[redacted],next_cell;other');
    expect(redact('a?token=tok_9f8e7d;b=1')).toBe('a?token=[redacted];b=1');
    // Already-masked values are not masked again.
    expect(redact('a?key=[redacted],x')).toBe('a?key=[redacted],x');
  });
});
