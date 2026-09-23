/**
 * OWNER: A7. Anthropic Messages API adapter, built on the official SDK (@anthropic-ai/sdk).
 *
 *  - Structured output via output_config.format = { type: 'json_schema', schema } (the canonical
 *    parameter; the deprecated output_format is not used).
 *  - The SDK's own retries are disabled (maxRetries: 0): the session runner owns bounded retries.
 *  - One deadline (req.timeoutMs) covers the whole call including the response body, combined
 *    with the caller's AbortSignal; the SDK timeout alone only covers the response headers.
 *  - .withResponse() exposes the anthropic-ratelimit-* headers, recorded as RateLimitInfo.
 *  - No default model: the user picks one from listModels() or types an id.
 *  - Authentication uses ONLY the API key from the server config (authToken is forced to null so
 *    an ANTHROPIC_AUTH_TOKEN in the environment is never sent alongside it).
 */
import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AnthropicError,
} from '@anthropic-ai/sdk';
import {
  GameError,
  type ConnectionTestResult,
  type ProviderCapabilities,
  type ProviderError,
  type UsageNumbers,
} from '../../shared/contracts.js';
import type { DecisionRequest, ProviderAdapter, ProviderCallResult, ResolvedProviderConfig } from '../types.js';
import {
  abortError,
  asCount,
  classifyHttpStatus,
  createDeadline,
  nowIso,
  parseRateLimitHeaders,
  parseRetryAfterMs,
  providerError,
  validateBaseUrl,
} from './httpUtil.js';

const LABEL = 'Anthropic API';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';
/** Deadline for connection tests and model listing. */
const META_TIMEOUT_MS = 15_000;
/** Safety cap on paginated model listing. */
const MAX_MODELS = 1000;

const CAPABILITIES: ProviderCapabilities = {
  kind: 'anthropic',
  label: 'Anthropic (Claude API)',
  local: false,
  paid: true,
  generatesText: true,
  reportsTokenUsage: 'full',
  reportsCost: false,
  listsModels: true,
  structuredOutput: true,
  quotaInfo: 'rate-limit-headers',
  requiresApiKey: true,
  notes: [
    'Paid API: cost is ESTIMATED from reported tokens × a pricing assumption (not billed amounts)',
    'Rate-limit headers describe API rate limits, not your spend, balance or plan quota',
    'Structured output requires a model that supports output_config.format',
    'Connection tests list models only and spend no tokens',
  ],
};

const NO_USAGE: UsageNumbers = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  reasoningTokens: null,
  known: false,
};

function baseUrlOf(cfg: ResolvedProviderConfig): string {
  return cfg.baseUrl && cfg.baseUrl.trim() !== '' ? cfg.baseUrl.trim() : DEFAULT_BASE_URL;
}

function makeClient(cfg: ResolvedProviderConfig, timeoutMs: number): Anthropic {
  return new Anthropic({
    apiKey: cfg.apiKey,
    authToken: null,
    baseURL: baseUrlOf(cfg),
    maxRetries: 0,
    // Slightly above our own deadline so the deadline decides (it also covers the body).
    timeout: timeoutMs + 1000,
  });
}

/** Map anything the SDK throws to a typed ProviderError (most specific class first). */
export function mapAnthropicError(
  err: unknown,
  ctx: { deadline: 'timeout' | 'cancelled' | null; timeoutMs: number; apiKey?: string },
): ProviderError {
  const secrets = [ctx.apiKey];
  if (ctx.deadline) return abortError(ctx.deadline, LABEL, ctx.timeoutMs);
  if (err instanceof APIUserAbortError) return abortError('cancelled', LABEL, ctx.timeoutMs);
  if (err instanceof APIConnectionTimeoutError) return abortError('timeout', LABEL, ctx.timeoutMs);
  if (err instanceof APIConnectionError) {
    const cause = err.cause instanceof Error ? `: ${err.cause.message}` : '';
    return providerError('unavailable', `${LABEL} is unreachable (${err.message}${cause})`, { retryable: true, secrets });
  }
  if (err instanceof APIError && typeof err.status === 'number') {
    // Prefer the API's own message ({type:'error', error:{type, message}}) over the SDK's summary.
    const body = err.error as { error?: { message?: unknown; type?: unknown } } | undefined;
    const apiMessage = typeof body?.error?.message === 'string' ? body.error.message : err.message;
    const mapped = classifyHttpStatus(err.status, err.headers ?? null, JSON.stringify({ error: { message: apiMessage } }), {
      providerLabel: LABEL,
      secrets,
    });
    if (err.type === 'overloaded_error' && mapped.code !== 'server_error') {
      return { ...mapped, code: 'server_error', retryable: true };
    }
    if (mapped.code === 'rate_limited' && mapped.retryAfterMs === undefined) {
      const ra = parseRetryAfterMs(err.headers ?? null);
      if (ra !== undefined) mapped.retryAfterMs = ra;
    }
    return mapped;
  }
  if (err instanceof AnthropicError) {
    return providerError('unknown', `${LABEL} client error: ${err.message}`, { secrets });
  }
  const msg = err instanceof Error ? err.message : String(err);
  return providerError('unknown', `${LABEL} request failed: ${msg}`, { secrets });
}

function missingKeyIssue(cfg: ResolvedProviderConfig): string | null {
  return cfg.apiKey && cfg.apiKey.trim() !== '' ? null : 'ANTHROPIC_API_KEY is not set in the server .env';
}

async function fetchModelIds(cfg: ResolvedProviderConfig, signal: AbortSignal): Promise<
  { ok: true; ids: string[]; latencyMs: number } | { ok: false; error: ProviderError }
> {
  const deadline = createDeadline(META_TIMEOUT_MS, signal);
  const started = performance.now();
  try {
    const client = makeClient(cfg, META_TIMEOUT_MS);
    const opts = { signal: deadline.signal, maxRetries: 0 };
    let page = await Promise.race([client.models.list({ limit: 100 }, opts), deadline.aborted]);
    const latencyMs = Math.round(performance.now() - started);
    const ids: string[] = page.data.map((m) => m.id);
    while (page.hasNextPage() && ids.length < MAX_MODELS) {
      page = await Promise.race([page.getNextPage(), deadline.aborted]);
      ids.push(...page.data.map((m) => m.id));
    }
    return { ok: true, ids: [...new Set(ids)], latencyMs };
  } catch (err) {
    return {
      ok: false,
      error: mapAnthropicError(err, { deadline: deadline.outcome(), timeoutMs: META_TIMEOUT_MS, apiKey: cfg.apiKey }),
    };
  } finally {
    deadline.dispose();
  }
}

export function createAnthropicAdapter(): ProviderAdapter {
  return {
    kind: 'anthropic',
    capabilities: CAPABILITIES,

    check(cfg: ResolvedProviderConfig) {
      const issues: string[] = [];
      const keyIssue = missingKeyIssue(cfg);
      if (keyIssue) issues.push(keyIssue);
      const url = validateBaseUrl(baseUrlOf(cfg));
      if (!url.ok) issues.push(`Anthropic base URL: ${url.issue}`);
      if (!cfg.model || cfg.model.trim() === '') {
        issues.push('No model selected — list the models available to your key or type a model id');
      }
      return { configured: !keyIssue && url.ok, enabled: true, issues };
    },

    async testConnection(cfg: ResolvedProviderConfig, signal: AbortSignal): Promise<ConnectionTestResult> {
      const testedAt = nowIso();
      const keyIssue = missingKeyIssue(cfg);
      if (keyIssue) return { ok: false, testedAt, latencyMs: null, message: keyIssue };
      const url = validateBaseUrl(baseUrlOf(cfg));
      if (!url.ok) return { ok: false, testedAt, latencyMs: null, message: `Anthropic base URL: ${url.issue}` };

      const res = await fetchModelIds(cfg, signal);
      if (!res.ok) return { ok: false, testedAt, latencyMs: null, message: res.error.message };
      let message = `Authenticated — ${res.ids.length} model${res.ids.length === 1 ? '' : 's'} available to this key (no tokens spent)`;
      if (cfg.model && !res.ids.includes(cfg.model)) {
        message += `. "${cfg.model}" is not in the list (it may be an alias; a decision request will confirm)`;
      }
      return { ok: true, testedAt, latencyMs: res.latencyMs, message, models: res.ids };
    },

    /** Model ids available to the key. Throws GameError('provider_unavailable') on failure. */
    async listModels(cfg: ResolvedProviderConfig, signal: AbortSignal): Promise<string[]> {
      const keyIssue = missingKeyIssue(cfg);
      if (keyIssue) throw new GameError('provider_unavailable', keyIssue, { code: 'not_configured' });
      const res = await fetchModelIds(cfg, signal);
      if (!res.ok) throw new GameError('provider_unavailable', res.error.message, { code: res.error.code });
      return res.ids;
    },

    async decide(req: DecisionRequest, cfg: ResolvedProviderConfig, signal: AbortSignal): Promise<ProviderCallResult> {
      const fail = (error: ProviderError, latencyMs: number, extra: Partial<ProviderCallResult> = {}): ProviderCallResult => ({
        ok: false,
        text: null,
        usage: NO_USAGE,
        latencyMs,
        generationMs: null,
        providerCostUsd: null,
        modelReported: null,
        finishReason: null,
        rateLimit: null,
        error,
        ...extra,
      });

      const keyIssue = missingKeyIssue(cfg);
      if (keyIssue) return fail(providerError('not_configured', keyIssue), 0);
      const url = validateBaseUrl(baseUrlOf(cfg));
      if (!url.ok) return fail(providerError('not_configured', `Anthropic base URL: ${url.issue}`), 0);
      const model = (req.model ?? cfg.model)?.trim();
      if (!model) return fail(providerError('not_configured', 'No Anthropic model selected'), 0);

      const temperature = req.temperature ?? cfg.temperature;
      const deadline = createDeadline(req.timeoutMs, signal);
      const started = performance.now();
      const elapsed = (): number => Math.round(performance.now() - started);
      try {
        if (deadline.outcome()) return fail(abortError(deadline.outcome()!, LABEL, deadline.timeoutMs), 0);
        const client = makeClient(cfg, deadline.timeoutMs);
        const { data, response } = await Promise.race([
          client.messages
            .create(
              {
                model,
                max_tokens: req.maxOutputTokens,
                system: req.systemPrompt,
                messages: [{ role: 'user', content: req.userPrompt }],
                output_config: { format: { type: 'json_schema', schema: req.jsonSchema } },
                // Only sent when the user set one; several current models reject sampling params.
                ...(typeof temperature === 'number' && Number.isFinite(temperature) ? { temperature } : {}),
              },
              { signal: deadline.signal, maxRetries: 0 },
            )
            .withResponse(),
          deadline.aborted,
        ]);
        const latencyMs = elapsed();
        const rateLimit = parseRateLimitHeaders(response.headers);

        const u = data.usage;
        const usage: UsageNumbers = {
          inputTokens: asCount(u?.input_tokens),
          outputTokens: asCount(u?.output_tokens),
          cacheReadTokens: asCount(u?.cache_read_input_tokens),
          cacheWriteTokens: asCount(u?.cache_creation_input_tokens),
          reasoningTokens: asCount(u?.output_tokens_details?.thinking_tokens),
          known: !!u && (asCount(u.input_tokens) !== null || asCount(u.output_tokens) !== null),
        };
        const text = data.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('');
        const common = {
          text: text === '' ? null : text,
          usage,
          latencyMs,
          generationMs: null,
          providerCostUsd: null,
          modelReported: typeof data.model === 'string' ? data.model : null,
          finishReason: data.stop_reason ?? null,
          rateLimit,
        };

        if (data.stop_reason === 'max_tokens') {
          return {
            ...common,
            ok: false,
            error: providerError(
              'invalid_output',
              `Output stopped at max_tokens (${req.maxOutputTokens}) and may be incomplete — raise max output tokens`,
            ),
          };
        }
        if (data.stop_reason === 'refusal') {
          const d = data.stop_details;
          const detail = d ? [d.category, d.explanation].filter((x) => typeof x === 'string' && x).join(': ') : '';
          return {
            ...common,
            ok: false,
            error: providerError('invalid_output', `Model declined to answer (stop_reason: refusal)${detail ? ` — ${detail}` : ''}`),
          };
        }
        if (common.text === null || common.text.trim() === '') {
          return {
            ...common,
            ok: false,
            error: providerError('invalid_output', `Model returned no text (stop_reason: ${data.stop_reason ?? 'none'})`),
          };
        }
        return { ...common, ok: true, error: null };
      } catch (err) {
        const error = mapAnthropicError(err, { deadline: deadline.outcome(), timeoutMs: deadline.timeoutMs, apiKey: cfg.apiKey });
        const headers = err instanceof APIError ? (err.headers ?? null) : null;
        return fail(error, elapsed(), { rateLimit: headers ? parseRateLimitHeaders(headers) : null });
      } finally {
        deadline.dispose();
      }
    },
  };
}
