/**
 * OWNER: cloud/ollama provider agent (A7). PlayerDecision schema + tolerant-but-strict parsing (shared).
 *
 * Two layers of validation exist for a model decision:
 *   1. SHAPE (this file): is the output exactly one JSON object with the fields and types of
 *      PlayerDecision? Extra keys, wrong types, unknown bet types or actions → invalid.
 *   2. GAME RULES (bets.ts validateBetSlip): legal number combinations, stake increments,
 *      per-bet / per-round limits, balance. Not checked here.
 *
 * Nothing in this file ever repairs, re-orders, merges or invents a bet: a decision is either
 * returned exactly as the model stated it, or rejected with human-readable errors.
 */
import { z } from 'zod';
import { MAX_EXPLANATION_CHARS, type BetInput, type BetType, type PlayerDecision } from './contracts.js';

// ───────────────────────────── bet types ─────────────────────────────

/**
 * Record keyed by BetType so the compiler fails if a bet type is added to the contract
 * but not to the decision schema.
 */
const BET_TYPE_PRESENT: Record<BetType, true> = {
  straight: true,
  split: true,
  street: true,
  trio: true,
  corner: true,
  firstFour: true,
  sixLine: true,
  dozen: true,
  column: true,
  red: true,
  black: true,
  odd: true,
  even: true,
  low: true,
  high: true,
};

/** Every BetType, in contract order. */
export const DECISION_BET_TYPES = Object.freeze(Object.keys(BET_TYPE_PRESENT) as BetType[]);

export const DECISION_ACTIONS = Object.freeze(['bet', 'skip', 'stop'] as const);

// ───────────────────────────── JSON Schema ─────────────────────────────

/**
 * JSON Schema for PlayerDecision (used for structured-output requests).
 *
 * Hand-written to stay inside the subset every target accepts:
 *  - Anthropic structured outputs (output_config.format): additionalProperties:false on every
 *    object, no numeric/string/array constraints (minimum, minLength, minItems are unsupported).
 *  - OpenAI response_format json_schema (non-strict) and Ollama "format".
 * Conditional rules that JSON Schema subsets cannot express portably ("bets required and
 * non-empty only for action bet") are enforced by PlayerDecisionSchema below.
 */
export const PLAYER_DECISION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: [...DECISION_ACTIONS],
      description: '"bet" to place the bets listed in "bets", "skip" to sit this round out, "stop" to end the session.',
    },
    bets: {
      type: 'array',
      description: 'Required and non-empty when action is "bet"; omit (or leave empty) for "skip" and "stop".',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: [...DECISION_BET_TYPES] },
          numbers: {
            type: 'array',
            items: { type: 'integer' },
            description: 'Covered numbers for straight/split/street/trio/corner/firstFour/sixLine.',
          },
          index: { type: 'integer', description: '1, 2 or 3 for dozen/column.' },
          stake: { type: 'integer', description: 'Stake in integer credit subunits (100 = 1 credit).' },
        },
        required: ['type', 'stake'],
        additionalProperties: false,
      },
    },
    explanation: {
      type: 'string',
      description: `Optional short reason (at most ${MAX_EXPLANATION_CHARS} characters are kept).`,
    },
  },
  required: ['action'],
  additionalProperties: false,
};

// ───────────────────────────── zod mirror ─────────────────────────────

/** One bet as a model may state it. Strict: unknown keys are rejected. */
export const BetInputSchema = z.strictObject({
  type: z.enum(DECISION_BET_TYPES as unknown as [BetType, ...BetType[]]),
  numbers: z.array(z.int()).optional(),
  index: z.int().optional(),
  stake: z.int(),
});

/**
 * Strict mirror of PLAYER_DECISION_JSON_SCHEMA plus the action/bets coupling:
 *  - action "bet"        → bets required and non-empty
 *  - action "skip"/"stop" → bets absent or empty (a non-empty list is contradictory → invalid)
 */
export const PlayerDecisionSchema = z
  .strictObject({
    action: z.enum(DECISION_ACTIONS),
    bets: z.array(BetInputSchema).optional(),
    explanation: z.string().optional(),
  })
  .superRefine((d, ctx) => {
    if (d.action === 'bet' && (!d.bets || d.bets.length === 0)) {
      ctx.addIssue({ code: 'custom', path: ['bets'], message: 'action "bet" requires a non-empty "bets" array' });
    }
    if (d.action !== 'bet' && d.bets && d.bets.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['bets'],
        message: `action "${d.action}" must not include bets (omit "bets" or send an empty array)`,
      });
    }
  });

// ───────────────────────────── text normalisation ─────────────────────────────

/** Guard against pathological inputs; real decisions are a few hundred characters. */
const MAX_PARSE_CHARS = 200_000;

/**
 * Strip reasoning blocks and markdown code fences from model text.
 *  - <think>…</think> / <thinking>…</thinking> blocks (any number, case-insensitive) are removed.
 *  - A dangling "</think>" (opening tag was part of the chat template) → keep only what follows it.
 *  - An unterminated "<think>" → everything after it is reasoning and is removed.
 *  - ``` / ```json fence markers are removed (their content is kept).
 * Returns the trimmed remainder plus flags that explain an empty result.
 */
export function normalizeDecisionText(text: string): { text: string; unterminatedThink: boolean } {
  let s = text.replace(/^﻿/, '');
  s = s.replace(/<(think|thinking)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');

  // Orphan closing tag: the reasoning started before the returned text.
  const orphanClose = /<\/(think|thinking)\s*>/gi;
  let lastCloseEnd = -1;
  for (let m = orphanClose.exec(s); m; m = orphanClose.exec(s)) lastCloseEnd = m.index + m[0].length;
  if (lastCloseEnd >= 0) s = s.slice(lastCloseEnd);

  let unterminatedThink = false;
  const open = /<(think|thinking)\b[^>]*>/i.exec(s);
  if (open) {
    unterminatedThink = true;
    s = s.slice(0, open.index);
  }

  s = s.replace(/```[A-Za-z0-9_-]*[ \t]*/g, '');
  return { text: s.trim(), unterminatedThink };
}

/**
 * Find the top-level JSON objects in a string (string-literal aware brace matching).
 * Prose outside the objects is ignored; the caller decides what counts as acceptable.
 */
function scanTopLevelObjects(s: string): { objects: string[]; unterminated: boolean } {
  const objects: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] !== '{') {
      i++;
      continue;
    }
    const start = i;
    let depth = 0;
    let inString = false;
    let closedAt = -1;
    for (; i < s.length; i++) {
      const ch = s[i];
      if (inString) {
        if (ch === '\\') i++; // skip the escaped character
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) {
          closedAt = i;
          break;
        }
      }
    }
    if (closedAt < 0) return { objects, unterminated: true };
    objects.push(s.slice(start, closedAt + 1));
    i = closedAt + 1;
  }
  return { objects, unterminated: false };
}

/**
 * Normalise text and parse EXACTLY ONE top-level JSON object out of it.
 * Zero objects, two or more objects, a top-level array, a truncated object or malformed JSON
 * are all errors (never "best effort" picks).
 */
export function extractSingleJsonObject(text: string): { ok: true; value: unknown } | { ok: false; errors: string[] } {
  if (text.length > MAX_PARSE_CHARS) {
    return { ok: false, errors: [`output is too long to be a decision (${text.length} characters)`] };
  }
  const norm = normalizeDecisionText(text);
  if (norm.text === '') {
    return {
      ok: false,
      errors: [
        norm.unterminatedThink
          ? 'output contains only an unterminated <think> block (reasoning may have used all output tokens)'
          : 'output is empty after removing reasoning blocks and code fences',
      ],
    };
  }
  if (norm.text.startsWith('[')) {
    return { ok: false, errors: ['expected one JSON object at the top level, got a JSON array'] };
  }
  const scan = scanTopLevelObjects(norm.text);
  if (scan.objects.length === 0) {
    return {
      ok: false,
      errors: [
        scan.unterminated
          ? 'JSON object is incomplete (output may have been cut off; consider raising max output tokens)'
          : 'no JSON object found in output',
      ],
    };
  }
  if (scan.objects.length > 1) {
    return { ok: false, errors: [`expected exactly one JSON object, found ${scan.objects.length}`] };
  }
  if (scan.unterminated) {
    return { ok: false, errors: ['expected exactly one JSON object, found a second incomplete object after it'] };
  }
  try {
    return { ok: true, value: JSON.parse(scan.objects[0]!) };
  } catch (e) {
    return { ok: false, errors: [`malformed JSON: ${(e as Error).message}`] };
  }
}

// ───────────────────────────── validation ─────────────────────────────

function formatPath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? '(root)' : path.map((p) => String(p)).join('.');
}

/** Code-point-safe truncation (never splits a surrogate pair). */
function truncateChars(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max).join('');
}

/** Validate an already-parsed value against the strict decision schema. */
export function validateDecisionObject(value: unknown):
  | { ok: true; decision: PlayerDecision }
  | { ok: false; errors: string[] } {
  const r = PlayerDecisionSchema.safeParse(value);
  if (!r.success) {
    return { ok: false, errors: r.error.issues.map((iss) => `${formatPath(iss.path)}: ${iss.message}`) };
  }
  const d = r.data;
  const explanationText = d.explanation === undefined ? '' : truncateChars(d.explanation.trim(), MAX_EXPLANATION_CHARS);
  const explanation = explanationText === '' ? {} : { explanation: explanationText };

  if (d.action === 'bet') {
    // Copy each bet field by field, exactly as stated (numbers keep the model's order).
    const bets: BetInput[] = (d.bets ?? []).map((b) => ({
      type: b.type,
      ...(b.numbers !== undefined ? { numbers: [...b.numbers] } : {}),
      ...(b.index !== undefined ? { index: b.index } : {}),
      stake: b.stake,
    }));
    return { ok: true, decision: { action: 'bet', bets, ...explanation } };
  }
  return { ok: true, decision: { action: d.action, ...explanation } };
}

/**
 * Parse provider output into a PlayerDecision. Accepts an already-structured object or text.
 * Text normalisation: strip <think>…</think> blocks and ``` fences, then take the single JSON object.
 * Strict: unknown actions/fields or wrong types → { ok:false, errors }. Never invents or changes a bet.
 * Explanation is trimmed to MAX_EXPLANATION_CHARS.
 *
 * When `structured` is a non-null value it is authoritative (a string there is parsed as text);
 * otherwise `text` is parsed.
 */
export function parseDecision(input: { text: string | null; structured?: unknown }):
  | { ok: true; decision: PlayerDecision }
  | { ok: false; errors: string[] } {
  const { text, structured } = input;
  if (structured !== undefined && structured !== null) {
    if (typeof structured === 'string') return parseDecision({ text: structured });
    if (typeof structured !== 'object' || Array.isArray(structured)) {
      return { ok: false, errors: [`structured output must be a JSON object, got ${Array.isArray(structured) ? 'array' : typeof structured}`] };
    }
    return validateDecisionObject(structured);
  }
  if (text === null || text.trim() === '') {
    return { ok: false, errors: ['provider returned no output'] };
  }
  const extracted = extractSingleJsonObject(text);
  if (!extracted.ok) return extracted;
  if (extracted.value === null || typeof extracted.value !== 'object' || Array.isArray(extracted.value)) {
    return { ok: false, errors: ['expected a JSON object'] };
  }
  return validateDecisionObject(extracted.value);
}
