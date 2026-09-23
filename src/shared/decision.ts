/**
 * OWNER: cloud/ollama provider agent. PlayerDecision schema + tolerant-but-strict parsing (shared).
 * STUB — signatures are the contract; bodies are replaced by the owner.
 */
import type { PlayerDecision } from './contracts.js';

/** JSON Schema for PlayerDecision (used for structured-output requests). */
export const PLAYER_DECISION_JSON_SCHEMA: Record<string, unknown> = {};

/**
 * Parse provider output into a PlayerDecision. Accepts an already-structured object or text.
 * Text normalisation: strip <think>…</think> blocks and ``` fences, then take the single JSON object.
 * Strict: unknown actions/fields or wrong types → { ok:false, errors }. Never invents or changes a bet.
 * Explanation is trimmed to MAX_EXPLANATION_CHARS.
 */
export function parseDecision(input: { text: string | null; structured?: unknown }):
  | { ok: true; decision: PlayerDecision }
  | { ok: false; errors: string[] } {
  throw new Error('not implemented');
}
