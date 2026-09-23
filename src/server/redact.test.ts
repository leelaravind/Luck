import { afterEach, describe, expect, it } from 'vitest';
import { REDACTED, clearRegisteredSecrets, redact, registerSecret } from './redact.js';

afterEach(() => clearRegisteredSecrets());

describe('registered secrets', () => {
  it('removes every occurrence of a registered value', () => {
    registerSecret('my-local-laya-token');
    expect(redact('token my-local-laya-token and again my-local-laya-token.')).toBe(`token ${REDACTED} and again ${REDACTED}.`);
  });

  it('removes the longer secret whole when one secret contains another', () => {
    registerSecret('abcd');
    registerSecret('abcd-efgh-ijkl');
    expect(redact('x abcd-efgh-ijkl y abcd')).toBe(`x ${REDACTED} y ${REDACTED}`);
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

  it('is idempotent on already-masked text', () => {
    for (const s of ['Authorization: Bearer abc.def', 'Authorization: Token abc', '{"access_token":"abc"}', 'x?token=abc&y=1']) {
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
