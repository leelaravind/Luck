/**
 * OWNER: agent 8. Optional Laya adapter (PlayerKind 'laya').
 *
 * Authoritative reference: https://huggingface.co/convaiinnovations/laya (model card, laya 0.3.7).
 * Laya (Convai Innovations, Apache-2.0) is a local, non-generative CLASSIFIER: given a text "state"
 * and typed questions it returns probabilities over fixed labels in one forward pass. It does not
 * write text, does not produce output tokens and knows nothing about roulette.
 *
 * Honest limits taken from the model card and surfaced to the user:
 *  - probabilities/confidence ship over-confident until temperature-fitted on your own data, and the
 *    base checkpoints are near chance on zero-shot decisions — we show them as raw, uncalibrated;
 *  - `action.act_probability` "carries no usable signal yet", so it is ignored;
 *  - keep choice questions at ≤ ~20 options and the state short (English checkpoint: 512-token
 *    context, ~320 tokens for the state).
 *
 * This adapter talks to Laya's own local HTTP server (`laya-serve`, installed separately — see
 * optional/laya/README.md). Nothing Python-related is part of the base npm install.
 *
 *   GET  /health                → { status, loaded, device }
 *   POST /v1/systemone          { model?: checkpoint, state, questions }
 *                               → { model, answers: { action: { choice, probabilities, confidence } },
 *                                   usage: { input_tokens, output_tokens: 0 }, routing }
 *   Authorization: Bearer <LAYA_API_KEY>   only when the server was started with LAYA_API_KEY.
 *
 * Mapping (done HERE, not by Laya): Laya picks ONE label from a fixed list (skip or one
 * outside-bet category; "stop" is not offered). The ADAPTER turns a bet label into a single bet whose stake is fixed at
 * the session minimum (observation.limits.minStake). The explanation says so. Unknown labels are
 * invalid output — never converted into some other bet.
 *
 * Adapters never throw for provider problems and never retry.
 */
import {
  MAX_EXPLANATION_CHARS,
  type BetInput,
  type BetType,
  type ConnectionTestResult,
  type GameObservation,
  type PlayerDecision,
  type ProviderCapabilities,
  type ProviderError,
  type UsageNumbers,
} from '../../shared/contracts.js';
import type { DecisionRequest, ProviderAdapter, ProviderCallResult, ResolvedProviderConfig } from '../types.js';
import { asCount, asRecord, httpJson, isLoopbackHost, joinUrl, providerError, safeText, validateBaseUrl } from './httpUtil.js';

/** laya-serve's documented default port; the app binds it to loopback via LAYA_HOST=127.0.0.1. */
export const LAYA_DEFAULT_BASE_URL = 'http://127.0.0.1:8000';
const CHECKPOINT_RE = /^[A-Za-z0-9._-]{1,64}$/;
const HEALTH_TIMEOUT_MS = 10_000;
const LABEL = 'Laya';

export const LAYA_INSTRUCTIONS = 'Choose the next action in a virtual European roulette game. Outcomes are random.';

/**
 * The fixed label set Laya chooses from (13 ≤ 20 labels). Each value is the criterion text Laya
 * scores against the state; each key maps deterministically to a decision below.
 * "stop" is deliberately NOT offered: a classifier must not end the session — the user and the
 * session limits do. A returned "stop" label is therefore unknown → invalid output.
 */
export const LAYA_CRITERIA: Readonly<Record<string, string>> = Object.freeze({
  skip: 'Do not bet this round',
  red: 'Bet on red',
  black: 'Bet on black',
  odd: 'Bet on odd numbers',
  even: 'Bet on even numbers',
  low: 'Bet on low numbers 1-18',
  high: 'Bet on high numbers 19-36',
  dozen_1: 'Bet on the first dozen 1-12',
  dozen_2: 'Bet on the second dozen 13-24',
  dozen_3: 'Bet on the third dozen 25-36',
  column_1: 'Bet on column 1 (1, 4, ..., 34)',
  column_2: 'Bet on column 2 (2, 5, ..., 35)',
  column_3: 'Bet on column 3 (3, 6, ..., 36)',
});

export const LAYA_CAPABILITIES: ProviderCapabilities = {
  kind: 'laya',
  label: 'Laya (local classifier)',
  local: true,
  paid: false,
  generatesText: false,
  reportsTokenUsage: 'input-only',
  reportsCost: false,
  listsModels: false,
  structuredOutput: true,
  quotaInfo: 'none',
  requiresApiKey: false,
  notes: [
    'Classifier: picks among fixed labels; no generated text',
    'Not a roulette model; cannot predict outcomes',
    'Local — no cloud inference charge',
    'The adapter fixes every stake at the session minimum; Laya only picks the category',
    'Probabilities/confidence are raw and uncalibrated (the model card says checkpoints ship over-confident and are near chance zero-shot)',
    'Start laya-serve with LAYA_HOST=127.0.0.1 (its default binds 0.0.0.0)',
  ],
};

// ───────────────────────────── request building ─────────────────────────────

function fmtSigned(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/**
 * Compact plain-text summary of the observation (Laya's "state"). Built ONLY from the
 * GameObservation the runner provides — never from engine or database state.
 */
export function buildLayaState(obs: GameObservation): string {
  const l = obs.limits;
  const recent = obs.history.slice(-10);
  const results = recent.length
    ? recent.map((h) => `${h.winningNumber} ${h.color}`).join(', ')
    : 'none yet';
  const last = obs.history[obs.history.length - 1];
  const lastLine = last
    ? `Your last round (${last.round}): staked ${last.yourTotalStake}, net ${fmtSigned(last.yourNet)}.`
    : 'No rounds played yet.';
  return [
    `Virtual European single-zero roulette, round ${obs.roundNumber}. Amounts are ${obs.units}.`,
    `Balance: ${obs.balance}. Session net result: ${fmtSigned(obs.stats.netResult)} after ${obs.stats.roundsPlayed} rounds.`,
    `Minimum stake ${l.minStake}; maximum per bet ${l.maxStakePerBet ?? 'no limit'}; maximum per round ${l.maxStakePerRound ?? 'no limit (balance only)'}.`,
    `Rounds remaining: ${l.roundsRemaining === null ? 'no limit' : l.roundsRemaining}.`,
    `Last results (oldest first): ${results}.`,
    lastLine,
    'Outcomes are independent and random; past results do not predict future spins.',
  ].join('\n');
}

export function buildLayaRequestBody(obs: GameObservation, checkpoint: string | undefined): Record<string, unknown> {
  return {
    ...(checkpoint ? { model: checkpoint } : {}),
    state: buildLayaState(obs),
    questions: {
      action: { type: 'choice', instructions: LAYA_INSTRUCTIONS, criteria: { ...LAYA_CRITERIA } },
    },
  };
}

// ───────────────────────────── response mapping ─────────────────────────────

const EVEN_MONEY: ReadonlySet<string> = new Set(['red', 'black', 'odd', 'even', 'low', 'high']);

/** Label → decision. Bet labels get ONE bet at `minStake` (the adapter fixes the stake). null for an unknown label. */
export function layaLabelToDecision(label: string, minStake: number, explanation: string): PlayerDecision | null {
  if (!Object.prototype.hasOwnProperty.call(LAYA_CRITERIA, label)) return null;
  if (label === 'skip') return { action: 'skip', explanation };
  let bet: BetInput;
  if (EVEN_MONEY.has(label)) {
    bet = { type: label as BetType, stake: minStake };
  } else {
    const m = /^(dozen|column)_([123])$/.exec(label);
    if (!m) return null;
    bet = { type: m[1] as BetType, index: Number(m[2]), stake: minStake };
  }
  return { action: 'bet', bets: [bet], explanation };
}

function fmtP(p: number): string {
  return p.toFixed(2);
}

const NO_USAGE: UsageNumbers = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  reasoningTokens: null,
  known: false,
};

function failure(error: ProviderError, extra: Partial<ProviderCallResult> = {}): ProviderCallResult {
  return {
    ok: false,
    text: null,
    usage: NO_USAGE,
    latencyMs: 0,
    generationMs: null,
    providerCostUsd: null,
    modelReported: null,
    finishReason: null,
    rateLimit: null,
    error,
    ...extra,
  };
}

function resolveEndpoint(cfg: ResolvedProviderConfig): { ok: true; base: string; loopback: boolean } | { ok: false; issue: string } {
  const v = validateBaseUrl(cfg.baseUrl ?? LAYA_DEFAULT_BASE_URL);
  if (!v.ok) return { ok: false, issue: `Laya ${v.issue.charAt(0).toLowerCase()}${v.issue.slice(1)}` };
  return { ok: true, base: v.url.toString(), loopback: isLoopbackHost(v.url.hostname) };
}

function authHeaders(cfg: ResolvedProviderConfig): Record<string, string> {
  return cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {};
}

// ───────────────────────────── adapter ─────────────────────────────

export function createLayaAdapter(): ProviderAdapter {
  return {
    kind: 'laya',
    capabilities: LAYA_CAPABILITIES,

    check(cfg) {
      const issues: string[] = [];
      const ep = resolveEndpoint(cfg);
      if (!ep.ok) issues.push(ep.issue);
      else if (!ep.loopback) issues.push('Laya base URL is not a loopback address; run laya-serve on this machine with LAYA_HOST=127.0.0.1');
      if (cfg.layaCheckpoint !== undefined && cfg.layaCheckpoint !== '' && !CHECKPOINT_RE.test(cfg.layaCheckpoint)) {
        issues.push('Laya checkpoint may only contain letters, digits, ".", "_" and "-"');
      }
      // Static check only: whether laya-serve is actually running is shown by testConnection.
      return { configured: ep.ok, enabled: ep.ok, issues };
    },

    async testConnection(cfg, signal): Promise<ConnectionTestResult> {
      const testedAt = new Date().toISOString();
      const ep = resolveEndpoint(cfg);
      if (!ep.ok) return { ok: false, testedAt, latencyMs: null, message: ep.issue };
      const res = await httpJson({
        url: joinUrl(ep.base, 'health'),
        method: 'GET',
        headers: authHeaders(cfg),
        timeoutMs: HEALTH_TIMEOUT_MS,
        signal,
        providerLabel: LABEL,
        secrets: [cfg.apiKey],
      });
      if (!res.ok) {
        const hint = res.error.code === 'unavailable' ? ' Start it with optional/laya/start-laya.ps1 (or .sh).' : '';
        return { ok: false, testedAt, latencyMs: res.latencyMs, message: `${res.error.message}${hint}` };
      }
      const h = asRecord(res.json);
      if (!h || typeof h.status !== 'string') {
        return { ok: false, testedAt, latencyMs: res.latencyMs, message: 'Server answered /health but not with the laya-serve shape { status, loaded, device }' };
      }
      const loaded = Array.isArray(h.loaded)
        ? h.loaded.filter((x): x is string => typeof x === 'string')
        : typeof h.loaded === 'boolean'
          ? h.loaded
          : null;
      const loadedText = Array.isArray(loaded) ? (loaded.length ? loaded.join(', ') : 'none yet') : loaded === null ? 'not reported' : String(loaded);
      const device = typeof h.device === 'string' ? h.device : 'not reported';
      const healthy = /^(ok|healthy|ready)$/i.test(h.status);
      return {
        ok: healthy,
        testedAt,
        latencyMs: res.latencyMs,
        message: `laya-serve status "${h.status}", device ${device}, checkpoints loaded: ${loadedText}. Health check only; no classification was run.${ep.loopback ? '' : ' Warning: not a loopback address.'}`,
        ...(Array.isArray(loaded) && loaded.length ? { models: loaded } : {}),
      };
    },

    async decide(req: DecisionRequest, cfg: ResolvedProviderConfig, signal: AbortSignal): Promise<ProviderCallResult> {
      if (signal.aborted) return failure(providerError('cancelled', 'Laya request was cancelled before it was sent'));
      const ep = resolveEndpoint(cfg);
      if (!ep.ok) return failure(providerError('not_configured', ep.issue));
      const checkpoint = cfg.layaCheckpoint || undefined;
      if (checkpoint !== undefined && !CHECKPOINT_RE.test(checkpoint)) {
        return failure(providerError('bad_request', 'Laya checkpoint may only contain letters, digits, ".", "_" and "-"'));
      }
      const obs = req.observation;
      const minStake = obs.limits.minStake;

      const res = await httpJson({
        url: joinUrl(ep.base, 'v1/systemone'),
        method: 'POST',
        headers: authHeaders(cfg),
        body: buildLayaRequestBody(obs, checkpoint),
        timeoutMs: req.timeoutMs,
        signal,
        providerLabel: LABEL,
        secrets: [cfg.apiKey],
      });
      if (!res.ok) {
        return failure(res.error, { latencyMs: res.latencyMs, text: res.text === null ? null : safeText(res.text, [cfg.apiKey]) });
      }

      const body = asRecord(res.json);
      const usageRec = asRecord(body?.usage);
      const inputTokens = asCount(usageRec?.input_tokens);
      const usage: UsageNumbers = {
        inputTokens,
        // A classifier generates nothing: "not applicable", never reported as 0 generated tokens.
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
        known: inputTokens !== null,
      };
      const modelReported = body && typeof body.model === 'string' ? body.model : null;
      const base = {
        text: res.text,
        usage,
        latencyMs: res.latencyMs,
        generationMs: null,
        providerCostUsd: null,
        modelReported,
        finishReason: null,
        rateLimit: null,
      };

      const answer = asRecord(asRecord(body?.answers)?.action);
      const label = answer && typeof answer.choice === 'string' ? answer.choice : null;
      if (!label) {
        return { ok: false, ...base, error: providerError('invalid_output', 'Laya response has no answers.action.choice label') };
      }
      const probs = asRecord(answer?.probabilities) ?? {};
      // Label probability and Laya's own `confidence` score are different quantities; report each
      // only when Laya actually returned it (never substitute one for the other).
      const pRaw = probs[label];
      const p = typeof pRaw === 'number' && Number.isFinite(pRaw) ? pRaw : null;
      const confRaw = answer?.confidence;
      const confidence = typeof confRaw === 'number' && Number.isFinite(confRaw) ? confRaw : null;
      const scores = [
        p === null ? 'label probability not reported' : `label probability ${fmtP(p)}`,
        confidence === null ? 'confidence not reported' : `Laya confidence ${fmtP(confidence)}`,
      ].join(', ');
      const stakeNote = label === 'skip' ? '' : ' Stake fixed at the session minimum by the adapter.';
      const explanation = `Laya classifier chose '${label}' (${scores}; raw, uncalibrated).${stakeNote}`.slice(
        0,
        MAX_EXPLANATION_CHARS,
      );

      const decision = layaLabelToDecision(label, minStake, explanation);
      if (!decision) {
        return {
          ok: false,
          ...base,
          error: providerError('invalid_output', `Laya chose an unknown label "${label.slice(0, 40)}"; it is not converted into any bet`),
        };
      }

      const top = Object.entries(probs)
        .filter((e): e is [string, number] => typeof e[1] === 'number' && Number.isFinite(e[1]))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([k, v]) => `${k} ${fmtP(v)}`)
        .join(', ');
      const routing = asRecord(body?.routing);
      const routeText = routing && typeof routing.model === 'string' ? `; routed to ${routing.model}` : '';
      const note = `Classifier output (not generated text)${top ? `; top labels: ${top}` : ''}${routeText}.`;

      return { ok: true, ...base, structured: decision, error: null, note };
    },
  };
}
