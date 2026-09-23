/**
 * App settings (persisted under repo setting key 'app') and validation of session inputs.
 *
 * Every schema here is STRICT: unknown keys are rejected rather than silently stored. This is
 * also a secret guard — a request can never smuggle an apiKey/cliPath into a stored PlayerConfig.
 */
import { z } from 'zod';
import {
  AI_PROVIDER_KINDS,
  DEFAULT_LIMITS,
  GameError,
  type AiProviderKind,
  type AppSettings,
  type CreateSessionRequest,
  type PlayerConfig,
  type PlayerKind,
  type Pricing,
  type SessionLimits,
} from '../../shared/contracts.js';
import type { Repository } from '../types.js';
import { isValidCliModel } from '../providers/claudeCli.js';
import { DEFAULT_PRICING } from '../providers/pricing.js';

export const SETTINGS_KEY = 'app';

/** Default server wait between autonomous rounds (AppSettings.roundPacingMs). */
export const DEFAULT_ROUND_PACING_MS = 7_000;
/** Upper bound for roundPacingMs (10 minutes). 0 = no wait between rounds. */
export const MAX_ROUND_PACING_MS = 600_000;

// ───────────────────────────── schemas ─────────────────────────────

const PLAYER_KINDS = ['manual', 'demo', ...AI_PROVIDER_KINDS] as [PlayerKind, ...PlayerKind[]];

const posInt = (max: number) => z.int().min(1).max(max);

const PricingSchema = z.strictObject({
  inputPerMTokUsd: z.number().min(0).max(10_000),
  outputPerMTokUsd: z.number().min(0).max(10_000),
  cacheReadPerMTokUsd: z.number().min(0).max(10_000).optional(),
  cacheWritePerMTokUsd: z.number().min(0).max(10_000).optional(),
  source: z.enum(['user', 'default-assumption']),
  asOf: z.string().max(40).optional(),
});

/** Printable, no whitespace/control chars; the CLI adapter validates its own stricter rules. */
const modelId = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[\x21-\x7e]+$/, 'model must be printable ASCII without spaces');

const baseUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => {
    try {
      const u = new URL(v);
      return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password;
    } catch {
      return false;
    }
  }, 'baseUrl must be an http(s) URL without embedded credentials');

const PlayerConfigSchema = z
  .strictObject({
    kind: z.enum(PLAYER_KINDS),
    model: modelId.optional(),
    baseUrl: baseUrl.optional(),
    temperature: z.number().min(0).max(2).optional(),
    pricing: PricingSchema.optional(),
    layaCheckpoint: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9._-]+$/, 'layaCheckpoint may contain letters, digits, ".", "_" and "-"')
      .optional(),
  })
  .superRefine((p, ctx) => {
    // The Claude Code CLI receives the model as a command-line argument: refuse anything that is not
    // an alias or model id up front (at session creation / when settings are saved), not at the
    // first decision.
    if (p.kind === 'claude-cli' && p.model !== undefined && !isValidCliModel(p.model)) {
      ctx.addIssue({
        code: 'custom',
        path: ['model'],
        message: 'Claude Code CLI model must be an alias like "haiku" or a model id (letters, digits, . _ : - [ ]; it may not start with "-")',
      });
    }
  });

/** Shape + range rules for each limit (consistency across fields is checked in validateLimits). */
const LimitsShape = {
  startingBalance: posInt(1_000_000_000_00),
  minStake: posInt(1_000_000_00),
  stakeIncrement: posInt(1_000_000_00),
  maxStakePerBet: posInt(1_000_000_000_00).nullable(),
  maxStakePerRound: posInt(1_000_000_000_00).nullable(),
  maxBetsPerRound: posInt(1_000).nullable(),
  maxRounds: posInt(1_000_000).nullable(),
  maxRuntimeSec: posInt(7 * 24 * 3600).nullable(),
  maxOutputTokens: posInt(64_000),
  budgetMicros: z.int().min(0).max(1_000_000_000_000).nullable(),
  decisionTimeoutMs: z.int().min(1_000).max(600_000),
  maxRetries: z.int().min(0).max(5),
  maxConsecutiveFailures: posInt(100),
  historyWindow: z.int().min(0).max(200),
  // Older stored sessions have no value: treat as "the model may not end the session".
  allowModelStop: z.boolean().default(false),
} satisfies Record<keyof SessionLimits, z.ZodType>;

const SessionLimitsSchema = z.strictObject(LimitsShape);
const PartialLimitsSchema = z.strictObject(LimitsShape).partial();

const CreateSessionRequestSchema = z.strictObject({
  name: z.string().trim().max(80).optional(),
  player: PlayerConfigSchema,
  limits: PartialLimitsSchema.optional(),
});

const SettingsPatchSchema = z.strictObject({
  defaultLimits: PartialLimitsSchema.optional(),
  animationSpeed: z.enum(['normal', 'fast', 'instant']).optional(),
  roundPacingMs: z.int().min(0).max(MAX_ROUND_PACING_MS).optional(),
  reduceMotion: z.enum(['system', 'on', 'off']).optional(),
  /** The COMPLETE map of the user's pricing entries (see saveSettings). */
  pricing: z.record(z.string().min(3).max(260), PricingSchema).optional(),
  players: z.partialRecord(z.enum(AI_PROVIDER_KINDS as unknown as [AiProviderKind, ...AiProviderKind[]]), PlayerConfigSchema).optional(),
});

function zodMessage(err: z.ZodError): string {
  return err.issues
    .slice(0, 8)
    .map((i) => `${i.path.length ? i.path.join('.') : 'value'}: ${i.message}`)
    .join('; ');
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new GameError('validation_error', `Invalid ${what}: ${zodMessage(r.error)}`, {
      issues: r.error.issues.map((i) => ({ path: i.path.map(String), message: i.message })),
    });
  }
  return r.data;
}

// ───────────────────────────── limits ─────────────────────────────

/**
 * Validate a complete limits object: types/ranges, then cross-field consistency.
 * Throws GameError('validation_error') listing every violated rule.
 */
export function validateLimits(value: unknown): SessionLimits {
  const l = parseOrThrow(SessionLimitsSchema, value, 'limits') as SessionLimits;
  const problems: string[] = [];
  const inc = l.stakeIncrement;
  if (l.minStake % inc !== 0) problems.push(`minStake (${l.minStake}) must be a multiple of stakeIncrement (${inc})`);
  if (l.maxStakePerBet !== null && l.maxStakePerBet % inc !== 0) problems.push(`maxStakePerBet (${l.maxStakePerBet}) must be a multiple of stakeIncrement (${inc})`);
  if (l.maxStakePerRound !== null && l.maxStakePerRound % inc !== 0) problems.push(`maxStakePerRound (${l.maxStakePerRound}) must be a multiple of stakeIncrement (${inc})`);
  if (l.maxStakePerBet !== null && l.maxStakePerBet < l.minStake) problems.push(`maxStakePerBet (${l.maxStakePerBet}) must be >= minStake (${l.minStake})`);
  if (l.maxStakePerRound !== null && l.maxStakePerRound < l.minStake) problems.push(`maxStakePerRound (${l.maxStakePerRound}) must be >= minStake (${l.minStake})`);
  if (l.startingBalance < l.minStake) problems.push(`startingBalance (${l.startingBalance}) must be >= minStake (${l.minStake})`);
  if (problems.length) {
    throw new GameError('validation_error', `Inconsistent limits: ${problems.join('; ')}`, { problems });
  }
  return l;
}

export function validateCreateSessionRequest(value: unknown): CreateSessionRequest {
  return parseOrThrow(CreateSessionRequestSchema, value, 'session request') as CreateSessionRequest;
}

export function validatePlayerConfig(value: unknown): PlayerConfig {
  return parseOrThrow(PlayerConfigSchema, value, 'player config') as PlayerConfig;
}

// ───────────────────────────── settings ─────────────────────────────

/** What is actually stored: user choices only (defaults are merged in on load). */
interface StoredSettings {
  defaultLimits?: Partial<SessionLimits>;
  animationSpeed?: AppSettings['animationSpeed'];
  roundPacingMs?: number;
  reduceMotion?: AppSettings['reduceMotion'];
  /** User pricing entries only; the default assumptions always come from DEFAULT_PRICING. */
  pricing?: Record<string, Pricing>;
  players?: AppSettings['players'];
}

function defaultSettings(): AppSettings {
  return {
    defaultLimits: { ...DEFAULT_LIMITS },
    animationSpeed: 'normal',
    roundPacingMs: DEFAULT_ROUND_PACING_MS,
    reduceMotion: 'system',
    pricing: { ...DEFAULT_PRICING },
    players: {},
  };
}

/**
 * The entries of a pricing map that belong to the user: every 'user' entry, plus any entry for a
 * key that has no default. A 'default-assumption' copy of a built-in default is not the user's
 * (older versions stored the whole merged map), so the current default is used for it instead.
 */
function userPricingEntries(pricing: Readonly<Record<string, Pricing>> | undefined): Record<string, Pricing> {
  const out: Record<string, Pricing> = {};
  for (const [key, p] of Object.entries(pricing ?? {})) {
    if (!p || typeof p !== 'object') continue;
    if (p.source === 'default-assumption' && Object.hasOwn(DEFAULT_PRICING, key)) continue;
    out[key] = p;
  }
  return out;
}

function validRoundPacing(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_ROUND_PACING_MS;
}

function readStored(repo: Repository): StoredSettings {
  const raw = repo.getSetting<StoredSettings>(SETTINGS_KEY);
  return raw && typeof raw === 'object' ? raw : {};
}

/** Current settings = defaults, overlaid with stored user values. Invalid stored limits fall back to defaults. */
export function loadSettings(repo: Repository): AppSettings {
  const stored = readStored(repo);
  const base = defaultSettings();
  let defaultLimits = base.defaultLimits;
  if (stored.defaultLimits) {
    try {
      defaultLimits = validateLimits({ ...DEFAULT_LIMITS, ...stored.defaultLimits });
    } catch {
      defaultLimits = base.defaultLimits;
    }
  }
  return {
    defaultLimits,
    animationSpeed: stored.animationSpeed ?? base.animationSpeed,
    roundPacingMs: validRoundPacing(stored.roundPacingMs) ? stored.roundPacingMs : base.roundPacingMs,
    reduceMotion: stored.reduceMotion ?? base.reduceMotion,
    pricing: { ...base.pricing, ...userPricingEntries(stored.pricing) },
    players: { ...(stored.players ?? {}) },
  };
}

/**
 * Apply a validated partial update and persist it. Returns the merged settings.
 *  - `players` entries are merged key by key (a patch never wipes another provider's config).
 *  - `pricing`, when present, is the COMPLETE map of the user's entries: a user entry that is not
 *    in it is deleted. Default assumptions cannot be deleted (they always come from
 *    DEFAULT_PRICING); sending one back unchanged — as the Settings form does — stores nothing.
 */
export function saveSettings(repo: Repository, patch: unknown): AppSettings {
  const p = parseOrThrow(SettingsPatchSchema, patch ?? {}, 'settings');
  const stored = readStored(repo);
  const next: StoredSettings = { ...stored };

  if (p.defaultLimits) {
    const merged = { ...DEFAULT_LIMITS, ...(stored.defaultLimits ?? {}), ...p.defaultLimits };
    validateLimits(merged); // throws on inconsistency; nothing is stored
    next.defaultLimits = { ...(stored.defaultLimits ?? {}), ...p.defaultLimits };
  }
  if (p.animationSpeed) next.animationSpeed = p.animationSpeed;
  if (p.roundPacingMs !== undefined) next.roundPacingMs = p.roundPacingMs;
  if (p.reduceMotion) next.reduceMotion = p.reduceMotion;
  if (p.pricing) next.pricing = userPricingEntries(p.pricing as Record<string, Pricing>);
  if (p.players) {
    for (const [kind, cfg] of Object.entries(p.players)) {
      if (cfg && cfg.kind !== kind) {
        throw new GameError('validation_error', `Invalid settings: players.${kind}.kind must be "${kind}"`);
      }
    }
    next.players = { ...(stored.players ?? {}), ...(p.players as AppSettings['players']) };
  }

  repo.putSetting(SETTINGS_KEY, next);
  return loadSettings(repo);
}

/** Remember the last-used (non-secret) config for an AI provider. */
export function rememberPlayer(repo: Repository, player: PlayerConfig): void {
  if (!(AI_PROVIDER_KINDS as readonly string[]).includes(player.kind)) return;
  const stored = readStored(repo);
  const clean = validatePlayerConfig(player);
  repo.putSetting(SETTINGS_KEY, {
    ...stored,
    players: { ...(stored.players ?? {}), [player.kind]: clean },
  } satisfies StoredSettings);
}
