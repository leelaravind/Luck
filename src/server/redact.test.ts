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
  ])('%s', (_name, input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it('does not mangle ordinary text', () => {
    const text = 'Round 12 settled: red 23, net +V$ 1.00 (sk-learn is a library; skip)';
    expect(redact(text)).toBe(text);
  });

  it('never throws on odd input', () => {
    expect(redact('')).toBe('');
    expect(redact(undefined as unknown as string)).toBe('undefined');
  });
});
