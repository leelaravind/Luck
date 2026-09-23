/**
 * Provider registry: the default adapter set and the ONE place where a non-secret PlayerConfig
 * (from the browser / database) is merged with SERVER-ONLY configuration (API keys, CLI path,
 * subscription flag).
 *
 * Security rules enforced here:
 *  - secrets come ONLY from AppConfig, never from the request; unknown/secret-looking fields on
 *    the incoming player object are dropped (whitelist copy)
 *  - the Anthropic endpoint is taken from server config only, so a request can never redirect
 *    the server's API key to another host
 *  - an OpenAI-compatible / Laya API key is attached only when the effective endpoint is the one
 *    configured on the server; a user-typed different endpoint gets no key
 */
import type { AiProviderKind, PlayerConfig } from '../../shared/contracts.js';
import type { AppConfig, ProviderAdapter, ResolvedProviderConfig } from '../types.js';
import { createAnthropicAdapter } from './anthropic.js';
import { createClaudeCliAdapter } from './claudeCli.js';
import { createLayaAdapter } from './laya.js';
import { createOllamaAdapter } from './ollama.js';
import { createOpenAIAdapter } from './openai.js';

export function createDefaultAdapters(): Map<AiProviderKind, ProviderAdapter> {
  const adapters: ProviderAdapter[] = [
    createOllamaAdapter(),
    createAnthropicAdapter(),
    createOpenAIAdapter(),
    createClaudeCliAdapter(),
    createLayaAdapter(),
  ];
  return new Map(adapters.map((a) => [a.kind, a]));
}

/** Non-secret fields a PlayerConfig may carry (anything else on the input is ignored). */
function copyPublic(kind: AiProviderKind, player: Partial<PlayerConfig> | undefined): PlayerConfig {
  const out: PlayerConfig = { kind };
  if (!player) return out;
  if (typeof player.model === 'string' && player.model.trim() !== '') out.model = player.model.trim();
  if (typeof player.baseUrl === 'string' && player.baseUrl.trim() !== '') out.baseUrl = player.baseUrl.trim();
  if (typeof player.temperature === 'number' && Number.isFinite(player.temperature)) out.temperature = player.temperature;
  if (player.pricing && typeof player.pricing === 'object') out.pricing = { ...player.pricing };
  if (typeof player.layaCheckpoint === 'string' && player.layaCheckpoint.trim() !== '') out.layaCheckpoint = player.layaCheckpoint.trim();
  return out;
}

/** Compare endpoints ignoring case of scheme/host and trailing slashes. */
export function sameEndpoint(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const norm = (u: string) => {
    try {
      const url = new URL(u.trim());
      return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`.toLowerCase();
    } catch {
      return u.trim().replace(/\/+$/, '').toLowerCase();
    }
  };
  return norm(a) === norm(b);
}

/**
 * Merge the player's non-secret choices with server-only config for one provider.
 * The result is passed to adapters and NEVER serialised to the browser or database.
 */
export function resolveProviderConfig(
  kind: AiProviderKind,
  player: Partial<PlayerConfig> | undefined,
  config: AppConfig,
): ResolvedProviderConfig {
  const pub = copyPublic(kind, player);
  const p = config.providers;

  switch (kind) {
    case 'ollama':
      return { ...pub, baseUrl: pub.baseUrl ?? p.ollama.baseUrl, model: pub.model ?? p.ollama.model };

    case 'anthropic': {
      // Endpoint is server-configured only: the API key must never follow a user-typed URL.
      const out: ResolvedProviderConfig = { ...pub, baseUrl: p.anthropic.baseUrl, model: pub.model ?? p.anthropic.model };
      if (p.anthropic.apiKey) out.apiKey = p.anthropic.apiKey;
      return out;
    }

    case 'openai': {
      const baseUrl = pub.baseUrl ?? p.openai.baseUrl;
      const out: ResolvedProviderConfig = { ...pub, baseUrl, model: pub.model ?? p.openai.model };
      if (baseUrl === undefined) delete out.baseUrl;
      const keyEndpoint = p.openai.baseUrl;
      // Key only for the configured endpoint. When no endpoint is configured the key belongs to the
      // adapter's documented default, so it is attached only if the user did not type another one.
      if (p.openai.apiKey && (pub.baseUrl === undefined || sameEndpoint(baseUrl, keyEndpoint))) out.apiKey = p.openai.apiKey;
      return out;
    }

    case 'claude-cli': {
      const { baseUrl: _ignored, ...rest } = pub;
      const out: ResolvedProviderConfig = {
        ...rest,
        model: pub.model ?? p.claudeCli.model,
        useSubscriptionAuth: p.claudeCli.useSubscriptionAuth,
      };
      if (p.claudeCli.path) out.cliPath = p.claudeCli.path;
      // API-key auth for the CLI (subscription auth off) uses the server's Anthropic key.
      if (!p.claudeCli.useSubscriptionAuth && p.anthropic.apiKey) out.apiKey = p.anthropic.apiKey;
      if (out.model === undefined) delete out.model;
      return out;
    }

    case 'laya': {
      const baseUrl = pub.baseUrl ?? p.laya.baseUrl;
      const out: ResolvedProviderConfig = {
        ...pub,
        baseUrl,
        layaCheckpoint: pub.layaCheckpoint ?? p.laya.checkpoint,
      };
      if (p.laya.apiKey && sameEndpoint(baseUrl, p.laya.baseUrl)) out.apiKey = p.laya.apiKey;
      return out;
    }
  }
}

/** Non-secret server defaults shown in the UI (ProviderStatus.defaults). */
export function providerDefaults(kind: AiProviderKind, config: AppConfig): Pick<PlayerConfig, 'baseUrl' | 'model' | 'layaCheckpoint'> {
  const p = config.providers;
  const out: Pick<PlayerConfig, 'baseUrl' | 'model' | 'layaCheckpoint'> = {};
  const set = <K extends keyof typeof out>(k: K, v: (typeof out)[K] | undefined) => {
    if (v !== undefined && v !== '') out[k] = v;
  };
  switch (kind) {
    case 'ollama':
      set('baseUrl', p.ollama.baseUrl);
      set('model', p.ollama.model);
      break;
    case 'anthropic':
      set('baseUrl', p.anthropic.baseUrl);
      set('model', p.anthropic.model);
      break;
    case 'openai':
      set('baseUrl', p.openai.baseUrl);
      set('model', p.openai.model);
      break;
    case 'claude-cli':
      set('model', p.claudeCli.model);
      break;
    case 'laya':
      set('baseUrl', p.laya.baseUrl);
      set('layaCheckpoint', p.laya.checkpoint);
      break;
  }
  return out;
}

/**
 * Server-level switches that sit on top of an adapter's own check()
 * (e.g. CLAUDE_CLI_ENABLED=0 turns the CLI adapter off regardless of the binary being present).
 */
export function serverGate(kind: AiProviderKind, config: AppConfig): { enabled: boolean; issue: string | null } {
  if (kind === 'claude-cli' && !config.providers.claudeCli.enabled) {
    return { enabled: false, issue: 'Claude Code CLI adapter is disabled on the server (CLAUDE_CLI_ENABLED=0)' };
  }
  return { enabled: true, issue: null };
}
