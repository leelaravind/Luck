/**
 * Request validation for the HTTP layer (zod). These schemas check SHAPE and basic types only;
 * game rules (legal bets, stake limits, balances, provider-specific settings) are enforced by
 * the session service, which is authoritative. Objects are strict so the browser cannot smuggle
 * extra fields such as an "apiKey" into a stored PlayerConfig.
 */
import { z } from 'zod';
import { AI_PROVIDER_KINDS, type AiProviderKind, type ControlAction, type PlayerKind } from '../../shared/contracts.js';

export const PLAYER_KINDS = ['manual', 'demo', 'ollama', 'anthropic', 'openai', 'claude-cli', 'laya'] as const satisfies readonly PlayerKind[];
const AI_KINDS = ['ollama', 'anthropic', 'openai', 'claude-cli', 'laya'] as const satisfies readonly AiProviderKind[];
export const CONTROL_ACTIONS = ['start', 'pause', 'stop', 'step'] as const satisfies readonly ControlAction[];

/** Idempotency-Key header: 8–128 characters of [A-Za-z0-9_-] (a UUID fits). */
export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** Session ids in URLs: opaque, url-safe. */
export const idParams = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'Invalid session id') });

export const kindParams = z.object({ kind: z.string().max(32) });

export function isAiProviderKind(kind: string): kind is AiProviderKind {
  return (AI_PROVIDER_KINDS as readonly string[]).includes(kind);
}

/** Optional positive integer query parameter given as a decimal string. */
const intQuery = (max: number) =>
  z
    .string()
    .regex(/^\d{1,9}$/, 'Must be a whole number')
    .transform(Number)
    .pipe(z.number().int().min(1).max(max))
    .optional();

export const pricingSchema = z.strictObject({
  inputPerMTokUsd: z.number().min(0),
  outputPerMTokUsd: z.number().min(0),
  cacheReadPerMTokUsd: z.number().min(0).optional(),
  cacheWritePerMTokUsd: z.number().min(0).optional(),
  source: z.enum(['user', 'default-assumption']),
  asOf: z.string().max(40).optional(),
});

/** Non-secret player configuration. Unknown keys (e.g. apiKey) are rejected. */
export const playerConfigSchema = z.strictObject({
  kind: z.enum(PLAYER_KINDS),
  model: z.string().max(200).optional(),
  baseUrl: z.string().max(2048).optional(),
  temperature: z.number().min(0).max(2).optional(),
  pricing: pricingSchema.optional(),
  layaCheckpoint: z.string().max(64).optional(),
});

const count = z.number().int();
/** Every SessionLimits field, all required. Values are range-checked by the service. */
export const sessionLimitsSchema = z.strictObject({
  startingBalance: count,
  minStake: count,
  stakeIncrement: count,
  maxStakePerBet: count.nullable(),
  maxStakePerRound: count.nullable(),
  maxBetsPerRound: count.nullable(),
  maxRounds: count.nullable(),
  maxRuntimeSec: count.nullable(),
  maxOutputTokens: count,
  budgetMicros: count.nullable(),
  decisionTimeoutMs: count,
  maxRetries: count,
  maxConsecutiveFailures: count,
  historyWindow: count,
  allowModelStop: z.boolean(),
});

export const createSessionBody = z.strictObject({
  name: z.string().max(120).optional(),
  player: playerConfigSchema,
  limits: sessionLimitsSchema.partial().optional(),
});

/** Detailed bet validation is the service's job (validateBetSlip); here we only require an array. */
export const manualRoundBody = z.object({ bets: z.array(z.unknown()) });

export const controlBody = z.strictObject({ action: z.enum(CONTROL_ACTIONS) });

/** Body of POST /api/providers/:kind/test and /models. The whole body is optional. */
export const providerBody = z.strictObject({ player: playerConfigSchema.optional() }).optional();

/** Partial<AppSettings>. Nested objects are type-checked; the service validates values. */
export const settingsPatchBody = z.strictObject({
  defaultLimits: sessionLimitsSchema.optional(),
  animationSpeed: z.enum(['normal', 'fast', 'instant']).optional(),
  reduceMotion: z.enum(['system', 'on', 'off']).optional(),
  pricing: z.record(z.string().max(300), pricingSchema).optional(),
  players: z.partialRecord(z.enum(AI_KINDS), playerConfigSchema).optional(),
});

export const roundsQuery = z.object({ limit: intQuery(1000), beforeSeq: intQuery(1_000_000_000) });
export const limitQuery = z.object({ limit: intQuery(1000) });
export const exportQuery = z.object({ format: z.enum(['json', 'csv']).default('json') });
export const eventsQuery = z.object({ sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'Invalid session id') });
