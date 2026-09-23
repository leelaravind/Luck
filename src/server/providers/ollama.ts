/**
 * OWNER: A7. Ollama adapter (local inference over Ollama's native HTTP API).
 *
 *   GET  /api/version → { version }
 *   GET  /api/tags    → { models: [{ name, model, size, … }] }
 *   POST /api/chat    { model, stream:false, format:<JSON Schema>, messages, options } →
 *        { model, message:{content, thinking?}, done_reason, prompt_eval_count, eval_count,
 *          eval_duration (ns), load_duration (ns), total_duration (ns) }
 *
 * Usage numbers are exactly what Ollama reports; nothing is estimated. Cost is not computed
 * here — the session runner records local inference as 'local-no-charge'.
 */
import { GameError, type ConnectionTestResult, type ProviderCapabilities, type UsageNumbers } from '../../shared/contracts.js';
import type { DecisionRequest, ProviderAdapter, ProviderCallResult, ResolvedProviderConfig } from '../types.js';
import { asCount, asRecord, httpJson, joinUrl, nowIso, providerError, validateBaseUrl } from './httpUtil.js';

const LABEL = 'Ollama';
/** Deadline for connection tests and model listing (decisions use req.timeoutMs). */
const META_TIMEOUT_MS = 10_000;

const CAPABILITIES: ProviderCapabilities = {
  kind: 'ollama',
  label: 'Ollama (local)',
  local: true,
  paid: false,
  generatesText: true,
  reportsTokenUsage: 'full',
  reportsCost: false,
  listsModels: true,
  structuredOutput: true,
  quotaInfo: 'none',
  requiresApiKey: false,
  notes: [
    'Local inference — no cloud inference charge',
    "Token counts are Ollama's prompt_eval_count / eval_count",
    "Generation speed uses Ollama's eval_duration (excludes model load time)",
    'No quota or rate-limit information exists for a local server',
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

function failure(
  error: ProviderCallResult['error'],
  latencyMs: number,
  extra: Partial<ProviderCallResult> = {},
): ProviderCallResult {
  return {
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
  };
}

/** Model names from a /api/tags body, sorted. */
function tagNames(json: unknown): string[] | null {
  const models = asRecord(json)?.models;
  if (!Array.isArray(models)) return null;
  const names = models
    .map((m) => {
      const r = asRecord(m);
      return typeof r?.name === 'string' ? r.name : typeof r?.model === 'string' ? r.model : null;
    })
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

export function createOllamaAdapter(): ProviderAdapter {
  return {
    kind: 'ollama',
    capabilities: CAPABILITIES,

    check(cfg: ResolvedProviderConfig) {
      const issues: string[] = [];
      const url = validateBaseUrl(cfg.baseUrl);
      if (!url.ok) issues.push(`Ollama endpoint: ${url.issue}`);
      if (!cfg.model || cfg.model.trim() === '') {
        issues.push('No model selected — choose one of the installed models (ollama pull <model> to install one)');
      }
      return { configured: url.ok, enabled: true, issues };
    },

    async testConnection(cfg: ResolvedProviderConfig, signal: AbortSignal): Promise<ConnectionTestResult> {
      const testedAt = nowIso();
      const url = validateBaseUrl(cfg.baseUrl);
      if (!url.ok) return { ok: false, testedAt, latencyMs: null, message: `Ollama endpoint: ${url.issue}` };

      const version = await httpJson({
        url: joinUrl(cfg.baseUrl!, '/api/version'),
        timeoutMs: META_TIMEOUT_MS,
        signal,
        providerLabel: LABEL,
      });
      if (!version.ok) return { ok: false, testedAt, latencyMs: null, message: version.error.message };
      const v = asRecord(version.json)?.version;
      const versionText = typeof v === 'string' ? v : undefined;

      const tags = await httpJson({
        url: joinUrl(cfg.baseUrl!, '/api/tags'),
        timeoutMs: META_TIMEOUT_MS,
        signal,
        providerLabel: LABEL,
      });
      if (!tags.ok) {
        return {
          ok: false,
          testedAt,
          latencyMs: version.latencyMs,
          message: `Reached Ollama${versionText ? ` ${versionText}` : ''} but listing models failed: ${tags.error.message}`,
          ...(versionText ? { version: versionText } : {}),
        };
      }
      const models = tagNames(tags.json);
      if (!models) {
        return {
          ok: false,
          testedAt,
          latencyMs: version.latencyMs,
          message: 'The endpoint answered, but /api/tags did not look like an Ollama model list',
          ...(versionText ? { version: versionText } : {}),
        };
      }

      let message = `Connected to Ollama${versionText ? ` ${versionText}` : ''} — ${models.length} model${models.length === 1 ? '' : 's'} installed`;
      if (models.length === 0) message += '. Install one with: ollama pull <model>';
      else if (cfg.model && !models.includes(cfg.model) && !models.includes(`${cfg.model}:latest`)) {
        message += `. The selected model "${cfg.model}" is not installed (ollama pull ${cfg.model})`;
      }
      return {
        ok: true,
        testedAt,
        latencyMs: version.latencyMs,
        message,
        ...(versionText ? { version: versionText } : {}),
        models,
      };
    },

    /** Installed model names. Throws GameError('provider_unavailable') when Ollama cannot be listed. */
    async listModels(cfg: ResolvedProviderConfig, signal: AbortSignal): Promise<string[]> {
      const url = validateBaseUrl(cfg.baseUrl);
      if (!url.ok) throw new GameError('provider_unavailable', `Ollama endpoint: ${url.issue}`, { code: 'not_configured' });
      const res = await httpJson({
        url: joinUrl(cfg.baseUrl!, '/api/tags'),
        timeoutMs: META_TIMEOUT_MS,
        signal,
        providerLabel: LABEL,
      });
      if (!res.ok) throw new GameError('provider_unavailable', res.error.message, { code: res.error.code });
      const names = tagNames(res.json);
      if (!names) {
        throw new GameError('provider_unavailable', '/api/tags did not return an Ollama model list', { code: 'invalid_output' });
      }
      return names;
    },

    async decide(req: DecisionRequest, cfg: ResolvedProviderConfig, signal: AbortSignal): Promise<ProviderCallResult> {
      const model = (req.model ?? cfg.model)?.trim();
      const url = validateBaseUrl(cfg.baseUrl);
      if (!url.ok) return failure(providerError('not_configured', `Ollama endpoint: ${url.issue}`), 0);
      if (!model) return failure(providerError('not_configured', 'No Ollama model selected'), 0);

      const temperature = req.temperature ?? cfg.temperature;
      const options: Record<string, number> = { num_predict: req.maxOutputTokens };
      if (typeof temperature === 'number' && Number.isFinite(temperature)) options.temperature = temperature;

      const res = await httpJson({
        url: joinUrl(cfg.baseUrl!, '/api/chat'),
        method: 'POST',
        body: {
          model,
          stream: false,
          format: req.jsonSchema,
          messages: [
            { role: 'system', content: req.systemPrompt },
            { role: 'user', content: req.userPrompt },
          ],
          options,
        },
        timeoutMs: req.timeoutMs,
        signal,
        providerLabel: LABEL,
      });
      if (!res.ok) {
        // Ollama answers 404 {"error":"model 'x' not found"} for a missing model; the (redacted)
        // detail is in error.message. The raw error body is not model output, so text stays null.
        return failure(res.error, res.latencyMs);
      }

      const body = asRecord(res.json);
      const message = asRecord(body?.message);
      const content = typeof message?.content === 'string' ? message.content : null;
      const promptTokens = asCount(body?.prompt_eval_count);
      const evalTokens = asCount(body?.eval_count);
      const usage: UsageNumbers = {
        inputTokens: promptTokens,
        outputTokens: evalTokens,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
        known: promptTokens !== null || evalTokens !== null,
      };
      const evalNs = asCount(body?.eval_duration);
      const loadNs = asCount(body?.load_duration);
      const generationMs = evalNs !== null && evalNs > 0 ? evalNs / 1e6 : null;
      const finishReason = typeof body?.done_reason === 'string' ? body.done_reason : null;
      const modelReported = typeof body?.model === 'string' ? body.model : null;
      const note =
        loadNs !== null && loadNs >= 500e6 ? `Latency includes ${Math.round(loadNs / 1e6)} ms of Ollama model load time` : undefined;

      const common = {
        text: content,
        usage,
        latencyMs: res.latencyMs,
        generationMs,
        providerCostUsd: null,
        modelReported,
        finishReason,
        rateLimit: null,
        ...(note ? { note } : {}),
      };
      if (!body || !message) {
        return { ...common, ok: false, text: res.text, error: providerError('invalid_output', 'Ollama response had no message') };
      }
      if (finishReason === 'length') {
        return {
          ...common,
          ok: false,
          error: providerError(
            'invalid_output',
            `Output stopped at the output token limit (${req.maxOutputTokens}) — raise max output tokens`,
          ),
        };
      }
      if (content === null || content.trim() === '') {
        return { ...common, ok: false, error: providerError('invalid_output', 'Ollama returned an empty message') };
      }
      return { ...common, ok: true, error: null };
    },
  };
}
