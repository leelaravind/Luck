/**
 * OWNER: A7. Generic OpenAI-compatible Chat Completions adapter (fetch-based).
 *
 * Works with api.openai.com and compatible servers (LM Studio, vLLM, llama.cpp server, …).
 * There is NO default endpoint and NO default model: both must be configured explicitly.
 *
 *   GET  {baseUrl}/models            → { data: [{ id }] }
 *   POST {baseUrl}/chat/completions  → { model, choices:[{ message:{content, refusal?}, finish_reason }], usage }
 *
 * JSON mode (response_format {type:'json_object'}) is used because it is widely supported; it
 * guarantees syntactically valid JSON on servers that implement it, NOT schema adherence — the
 * app's own validator (parseDecision + validateBetSlip) enforces the schema and the rules.
 */
import { GameError, type ConnectionTestResult, type ProviderCapabilities, type ProviderError, type UsageNumbers } from '../../shared/contracts.js';
import type { DecisionRequest, ProviderAdapter, ProviderCallResult, ResolvedProviderConfig } from '../types.js';
import {
  asCount,
  asRecord,
  httpJson,
  isLoopbackHost,
  joinUrl,
  nowIso,
  parseRateLimitHeaders,
  providerError,
  validateBaseUrl,
} from './httpUtil.js';

const LABEL = 'OpenAI-compatible endpoint';
const META_TIMEOUT_MS = 15_000;

const CAPABILITIES: ProviderCapabilities = {
  kind: 'openai',
  label: 'OpenAI-compatible',
  local: false,
  paid: true,
  generatesText: true,
  reportsTokenUsage: 'full',
  reportsCost: false,
  listsModels: true,
  structuredOutput: false,
  quotaInfo: 'rate-limit-headers',
  requiresApiKey: false,
  notes: [
    'Endpoint and model must be set explicitly; there is no default',
    'API key required by api.openai.com and most hosted services; optional for local servers such as LM Studio',
    'Treated as paid (budget applies) because the endpoint may be a cloud service; no default pricing — enter your own',
    'JSON mode only guarantees valid JSON; the decision schema is enforced by the app',
    'Token usage and x-ratelimit-* headers are shown only when the server reports them',
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

function isOpenAIHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'api.openai.com' || h.endsWith('.openai.com');
}

function authHeaders(cfg: ResolvedProviderConfig): Record<string, string> {
  return cfg.apiKey && cfg.apiKey.trim() !== '' ? { authorization: `Bearer ${cfg.apiKey.trim()}` } : {};
}

/**
 * Static check. A missing key blocks api.openai.com; for other remote hosts it is reported as a
 * warning (many require one); loopback servers normally need none.
 */
function checkConfig(cfg: ResolvedProviderConfig): { configured: boolean; issues: string[]; url: URL | null } {
  const issues: string[] = [];
  const v = validateBaseUrl(cfg.baseUrl);
  if (!v.ok) {
    issues.push(
      v.issue === 'No base URL is set'
        ? 'No endpoint set — e.g. https://api.openai.com/v1 or http://localhost:1234/v1 (LM Studio)'
        : `Endpoint: ${v.issue}`,
    );
  }
  if (!cfg.model || cfg.model.trim() === '') issues.push('No model set — list the endpoint\'s models or type a model id');
  const hasKey = !!cfg.apiKey && cfg.apiKey.trim() !== '';
  let keyBlocks = false;
  if (v.ok && !hasKey) {
    if (isOpenAIHost(v.url.hostname)) {
      keyBlocks = true;
      issues.push('OPENAI_API_KEY is not set in the server .env (required by api.openai.com)');
    } else if (!isLoopbackHost(v.url.hostname)) {
      issues.push('No API key set — most hosted endpoints require one (OPENAI_API_KEY)');
    }
  }
  return { configured: v.ok && !keyBlocks, issues, url: v.ok ? v.url : null };
}

function modelIds(json: unknown): string[] | null {
  const data = asRecord(json)?.data;
  if (!Array.isArray(data)) return null;
  const ids = data
    .map((m) => asRecord(m)?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

/** message.content may be a string or (on some servers) an array of {type:'text', text} parts. */
function contentText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((p) => {
        const r = asRecord(p);
        return typeof r?.text === 'string' ? r.text : '';
      })
      .join('');
    return parts;
  }
  return null;
}

/**
 * OpenAI usage → UsageNumbers (non-overlapping input buckets, see pricing.ts):
 *   inputTokens     = prompt_tokens − prompt_tokens_details.cached_tokens
 *   cacheReadTokens = prompt_tokens_details.cached_tokens
 *   outputTokens    = completion_tokens (inclusive of reasoning)
 *   reasoningTokens = completion_tokens_details.reasoning_tokens (subset of outputTokens)
 */
export function mapOpenAIUsage(usage: unknown): UsageNumbers {
  const u = asRecord(usage);
  if (!u) return NO_USAGE;
  const prompt = asCount(u.prompt_tokens);
  const completion = asCount(u.completion_tokens);
  const cached = asCount(asRecord(u.prompt_tokens_details)?.cached_tokens);
  const reasoning = asCount(asRecord(u.completion_tokens_details)?.reasoning_tokens);
  if (prompt === null && completion === null) return NO_USAGE;
  return {
    inputTokens: prompt === null ? null : Math.max(0, prompt - (cached ?? 0)),
    outputTokens: completion,
    cacheReadTokens: cached,
    cacheWriteTokens: null,
    reasoningTokens: reasoning,
    known: true,
  };
}

export function createOpenAIAdapter(): ProviderAdapter {
  return {
    kind: 'openai',
    capabilities: CAPABILITIES,

    check(cfg: ResolvedProviderConfig) {
      const c = checkConfig(cfg);
      return { configured: c.configured, enabled: true, issues: c.issues };
    },

    async testConnection(cfg: ResolvedProviderConfig, signal: AbortSignal): Promise<ConnectionTestResult> {
      const testedAt = nowIso();
      const c = checkConfig(cfg);
      if (!c.url) return { ok: false, testedAt, latencyMs: null, message: c.issues[0] ?? 'Endpoint not configured' };
      if (!c.configured) return { ok: false, testedAt, latencyMs: null, message: c.issues.join('; ') };

      const res = await httpJson({
        url: joinUrl(cfg.baseUrl!, '/models'),
        headers: authHeaders(cfg),
        timeoutMs: META_TIMEOUT_MS,
        signal,
        providerLabel: LABEL,
        secrets: [cfg.apiKey],
      });
      if (!res.ok) return { ok: false, testedAt, latencyMs: null, message: res.error.message };
      const ids = modelIds(res.json);
      if (!ids) {
        return {
          ok: false,
          testedAt,
          latencyMs: res.latencyMs,
          message: 'The endpoint answered, but GET /models did not return an OpenAI-style model list',
        };
      }
      let message = `Connected — ${ids.length} model${ids.length === 1 ? '' : 's'} listed (no tokens spent)`;
      if (cfg.model && !ids.includes(cfg.model)) message += `. "${cfg.model}" is not in the list`;
      return { ok: true, testedAt, latencyMs: res.latencyMs, message, models: ids };
    },

    /** Model ids from GET {baseUrl}/models. Throws GameError('provider_unavailable') on failure. */
    async listModels(cfg: ResolvedProviderConfig, signal: AbortSignal): Promise<string[]> {
      const c = checkConfig(cfg);
      if (!c.url || !c.configured) {
        throw new GameError('provider_unavailable', c.issues.join('; ') || 'Endpoint not configured', { code: 'not_configured' });
      }
      const res = await httpJson({
        url: joinUrl(cfg.baseUrl!, '/models'),
        headers: authHeaders(cfg),
        timeoutMs: META_TIMEOUT_MS,
        signal,
        providerLabel: LABEL,
        secrets: [cfg.apiKey],
      });
      if (!res.ok) throw new GameError('provider_unavailable', res.error.message, { code: res.error.code });
      const ids = modelIds(res.json);
      if (!ids) throw new GameError('provider_unavailable', 'GET /models did not return a model list', { code: 'invalid_output' });
      return ids;
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

      const c = checkConfig(cfg);
      if (!c.url || !c.configured) return fail(providerError('not_configured', c.issues.join('; ') || 'Endpoint not configured'), 0);
      const model = (req.model ?? cfg.model)?.trim();
      if (!model) return fail(providerError('not_configured', 'No model set for the OpenAI-compatible endpoint'), 0);

      // JSON mode requires the word "JSON" in the conversation; the app's system prompt already
      // says so, this only guards against a future prompt change.
      const mentionsJson = /json/i.test(req.systemPrompt) || /json/i.test(req.userPrompt);
      const system = mentionsJson ? req.systemPrompt : `${req.systemPrompt}\n\nReply with a single JSON object.`;
      const temperature = req.temperature ?? cfg.temperature;
      const body: Record<string, unknown> = {
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: req.userPrompt },
        ],
        response_format: { type: 'json_object' },
        stream: false,
      };
      // api.openai.com deprecated max_tokens (and rejects it for reasoning models); compatible
      // servers generally only understand max_tokens.
      if (isOpenAIHost(c.url.hostname)) body.max_completion_tokens = req.maxOutputTokens;
      else body.max_tokens = req.maxOutputTokens;
      if (typeof temperature === 'number' && Number.isFinite(temperature)) body.temperature = temperature;

      const res = await httpJson({
        url: joinUrl(cfg.baseUrl!, '/chat/completions'),
        method: 'POST',
        headers: authHeaders(cfg),
        body,
        timeoutMs: req.timeoutMs,
        signal,
        providerLabel: LABEL,
        secrets: [cfg.apiKey],
      });
      if (!res.ok) {
        // The (redacted) error detail is in error.message; a raw error body is not model output.
        return fail(res.error, res.latencyMs, { rateLimit: res.headers ? parseRateLimitHeaders(res.headers) : null });
      }

      const json = asRecord(res.json);
      const choices = Array.isArray(json?.choices) ? json.choices : [];
      const choice = asRecord(choices[0]);
      const message = asRecord(choice?.message);
      const text = contentText(message?.content);
      const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null;
      const common = {
        text: text === '' ? null : text,
        usage: mapOpenAIUsage(json?.usage),
        latencyMs: res.latencyMs,
        generationMs: null,
        providerCostUsd: null,
        modelReported: typeof json?.model === 'string' ? json.model : null,
        finishReason,
        rateLimit: parseRateLimitHeaders(res.headers),
      };

      if (!message) {
        return { ...common, ok: false, text: res.text, error: providerError('invalid_output', 'Response contained no choices[0].message') };
      }
      if (typeof message.refusal === 'string' && message.refusal.trim() !== '') {
        return {
          ...common,
          ok: false,
          error: providerError('invalid_output', `Model refused: ${message.refusal.slice(0, 200)}`),
        };
      }
      if (finishReason === 'length') {
        return {
          ...common,
          ok: false,
          error: providerError(
            'invalid_output',
            `Output stopped at the token limit (${req.maxOutputTokens}) and may be incomplete — raise max output tokens`,
          ),
        };
      }
      if (finishReason === 'content_filter') {
        return { ...common, ok: false, error: providerError('invalid_output', 'Output was withheld by the provider content filter') };
      }
      if (common.text === null || common.text.trim() === '') {
        return { ...common, ok: false, error: providerError('invalid_output', 'Model returned an empty message') };
      }
      return { ...common, ok: true, error: null };
    },
  };
}
