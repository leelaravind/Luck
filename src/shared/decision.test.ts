import { describe, expect, it } from 'vitest';
import { MAX_EXPLANATION_CHARS } from './contracts.js';
import {
  DECISION_BET_TYPES,
  PLAYER_DECISION_JSON_SCHEMA,
  decisionJsonSchema,
  extractSingleJsonObject,
  normalizeDecisionText,
  parseDecision,
  stripReasoning,
} from './decision.js';

const text = (t: string) => parseDecision({ text: t });

function expectErrors(r: ReturnType<typeof parseDecision>, pattern: RegExp): void {
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.errors.join(' | ')).toMatch(pattern);
}

describe('PLAYER_DECISION_JSON_SCHEMA', () => {
  const schema = PLAYER_DECISION_JSON_SCHEMA as any;

  it('is an object schema with required action enum and closed objects', () => {
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['action']);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.action.enum).toEqual(['bet', 'skip', 'stop']);
    expect(schema.properties.explanation.type).toBe('string');
    const item = schema.properties.bets.items;
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(['type', 'stake']);
    expect(item.properties.numbers).toMatchObject({ type: 'array', items: { type: 'integer' } });
    expect(item.properties.index.type).toBe('integer');
    expect(item.properties.stake.type).toBe('integer');
  });

  it('lists all 15 bet types', () => {
    const item = schema.properties.bets.items;
    expect(item.properties.type.enum).toEqual([...DECISION_BET_TYPES]);
    expect(new Set(DECISION_BET_TYPES).size).toBe(15);
  });

  it('uses no keywords unsupported by Anthropic structured outputs', () => {
    const banned = ['minimum', 'maximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', 'oneOf', 'if'];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node)) {
        // "properties" maps field names to schemas; field names are not keywords.
        if (k !== 'properties') expect(banned).not.toContain(k);
        if (k === 'additionalProperties') expect(v).toBe(false);
        walk(v);
      }
    };
    walk(schema);
  });
});

describe('decisionJsonSchema (per session)', () => {
  /** Every "description" string anywhere in a schema. */
  const descriptions = (node: unknown): string[] => {
    if (!node || typeof node !== 'object') return [];
    return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
      k === 'description' && typeof v === 'string' ? [v] : descriptions(v),
    );
  };

  it('without allowStop: no "stop" in the action enum or in ANY description (bets included)', () => {
    const schema = decisionJsonSchema({ allowStop: false }) as any;
    expect(schema.properties.action.enum).toEqual(['bet', 'skip']);
    const texts = descriptions(schema);
    expect(texts.length).toBeGreaterThanOrEqual(5);
    for (const t of texts) expect(t).not.toMatch(/stop/i);
    expect(schema.properties.bets.description).toBe('Required and non-empty when action is "bet"; omit (or leave empty) for "skip".');
    // Everything else is the shared schema, unchanged.
    expect(schema.properties.bets.items).toBe((PLAYER_DECISION_JSON_SCHEMA as any).properties.bets.items);
    expect(schema.required).toEqual(['action']);
    expect(schema.additionalProperties).toBe(false);
  });

  it('with allowStop: "stop" is offered in the enum and described', () => {
    const schema = decisionJsonSchema({ allowStop: true }) as any;
    expect(schema.properties.action.enum).toEqual(['bet', 'skip', 'stop']);
    expect(schema.properties.action.description).toMatch(/"stop" to end the session/);
    expect(schema.properties.bets.description).toMatch(/"stop"/);
  });
});

describe('parseDecision — valid output', () => {
  it('accepts a bet decision and returns every bet exactly as stated', () => {
    const r = text(
      '{"action":"bet","bets":[{"type":"split","numbers":[3,0],"stake":20},{"type":"dozen","index":2,"stake":50},{"type":"red","stake":100}],"explanation":"  mixed  "}',
    );
    expect(r).toEqual({
      ok: true,
      decision: {
        action: 'bet',
        bets: [
          { type: 'split', numbers: [3, 0], stake: 20 },
          { type: 'dozen', index: 2, stake: 50 },
          { type: 'red', stake: 100 },
        ],
        explanation: 'mixed',
      },
    });
  });

  it('accepts skip and stop, with or without explanation', () => {
    expect(text('{"action":"skip"}')).toEqual({ ok: true, decision: { action: 'skip' } });
    expect(text('{"action":"stop","explanation":"done"}')).toEqual({ ok: true, decision: { action: 'stop', explanation: 'done' } });
  });

  it('accepts skip with an empty bets array and drops it', () => {
    expect(text('{"action":"skip","bets":[]}')).toEqual({ ok: true, decision: { action: 'skip' } });
  });

  it('strips <think> blocks, code fences and whitespace', () => {
    const r = text('<think>\nMaybe red? {"action":"stop"}\n</think>\n\n```json\n{"action":"bet","bets":[{"type":"red","stake":10}]}\n```\n');
    expect(r).toEqual({ ok: true, decision: { action: 'bet', bets: [{ type: 'red', stake: 10 }] } });
  });

  it('handles an orphan </think> (opening tag in the chat template)', () => {
    expect(text('reasoning text here </think> {"action":"skip"}')).toEqual({ ok: true, decision: { action: 'skip' } });
  });

  it('tolerates prose around exactly one object', () => {
    expect(text('Here is my decision: {"action":"skip"} Good luck.')).toEqual({ ok: true, decision: { action: 'skip' } });
  });

  it('is not confused by braces inside strings', () => {
    const r = text('{"action":"skip","explanation":"not {really} a \\"brace\\" }"}');
    expect(r).toEqual({ ok: true, decision: { action: 'skip', explanation: 'not {really} a "brace" }' } });
  });

  it('trims the explanation to MAX_EXPLANATION_CHARS and omits an empty one', () => {
    const long = 'x'.repeat(MAX_EXPLANATION_CHARS + 50);
    const r = text(JSON.stringify({ action: 'skip', explanation: `  ${long}  ` }));
    expect(r.ok && r.decision.explanation?.length).toBe(MAX_EXPLANATION_CHARS);
    expect(text('{"action":"skip","explanation":"   "}')).toEqual({ ok: true, decision: { action: 'skip' } });
  });

  it('accepts an already-structured object and a structured string', () => {
    expect(parseDecision({ text: null, structured: { action: 'stop' } })).toEqual({ ok: true, decision: { action: 'stop' } });
    expect(parseDecision({ text: null, structured: '```json\n{"action":"skip"}\n```' })).toEqual({
      ok: true,
      decision: { action: 'skip' },
    });
  });

  it('prefers structured over text when both are present', () => {
    expect(parseDecision({ text: '{"action":"skip"}', structured: { action: 'stop' } })).toEqual({
      ok: true,
      decision: { action: 'stop' },
    });
  });

  it('does not apply game rules (illegal numbers pass shape validation, left to validateBetSlip)', () => {
    const r = text('{"action":"bet","bets":[{"type":"straight","numbers":[99],"stake":-5}]}');
    expect(r).toEqual({ ok: true, decision: { action: 'bet', bets: [{ type: 'straight', numbers: [99], stake: -5 }] } });
  });
});

describe('parseDecision — rejected output', () => {
  it('rejects null / empty output', () => {
    expectErrors(parseDecision({ text: null }), /no output/);
    expectErrors(text('   '), /no output/);
  });

  it('rejects malformed JSON', () => {
    expectErrors(text('{"action":"bet",}'), /malformed JSON/);
    expectErrors(text("{'action':'skip'}"), /malformed JSON/);
  });

  it('rejects a truncated object with a max-tokens hint', () => {
    expectErrors(text('{"action":"bet","bets":[{"type":"red","sta'), /incomplete.*max output tokens/);
  });

  it('rejects text with no JSON object', () => {
    expectErrors(text('I will skip this round.'), /no JSON object/);
  });

  it('rejects multiple objects (including trailing prose with a second object)', () => {
    expectErrors(text('{"action":"skip"}\n{"action":"stop"}'), /exactly one JSON object, found 2/);
    expectErrors(text('{"action":"skip"} Actually, on second thought: {"action":"bet","bets":[]}'), /found 2/);
    expectErrors(text('{"action":"skip"} and then {"action":'), /second incomplete object/);
  });

  it('rejects a top-level array', () => {
    expectErrors(text('[{"action":"skip"}]'), /array/);
  });

  it('rejects an unterminated <think> block', () => {
    expectErrors(text('<think>I am still thinking about {"action":"skip"}'), /unterminated <think>/);
  });

  it('rejects extra top-level keys and extra bet keys', () => {
    expectErrors(text('{"action":"skip","confidence":0.9}'), /Unrecognized key.*confidence/);
    expectErrors(text('{"action":"bet","bets":[{"type":"red","stake":10,"color":"red"}]}'), /bets\.0.*Unrecognized key.*color/);
  });

  it('rejects wrong types and unknown enums', () => {
    expectErrors(text('{"action":"bet","bets":[{"type":"red","stake":"10"}]}'), /bets\.0\.stake/);
    expectErrors(text('{"action":"bet","bets":[{"type":"red","stake":10.5}]}'), /bets\.0\.stake/);
    expectErrors(text('{"action":"bet","bets":[{"type":"straight","numbers":[1.5],"stake":10}]}'), /bets\.0\.numbers\.0/);
    expectErrors(text('{"action":"bet","bets":[{"type":"basket","stake":10}]}'), /bets\.0\.type/);
    expectErrors(text('{"action":"double"}'), /action/);
    expectErrors(text('{"action":"skip","explanation":42}'), /explanation/);
    expectErrors(text('{"action":"bet","bets":[{"type":"red","stake":10,"numbers":null}]}'), /numbers/);
  });

  it('requires non-empty bets for action "bet" and no bets for skip/stop', () => {
    expectErrors(text('{"action":"bet"}'), /non-empty "bets"/);
    expectErrors(text('{"action":"bet","bets":[]}'), /non-empty "bets"/);
    expectErrors(text('{"action":"skip","bets":[{"type":"red","stake":10}]}'), /must not include bets/);
    expectErrors(text('{"action":"stop","bets":[{"type":"red","stake":10}]}'), /must not include bets/);
  });

  it('rejects a missing action', () => {
    expectErrors(text('{"bets":[{"type":"red","stake":10}]}'), /action/);
  });

  it('rejects structured values that are not objects', () => {
    expectErrors(parseDecision({ text: null, structured: [1] }), /array/);
    expectErrors(parseDecision({ text: null, structured: 7 }), /number/);
    expectErrors(parseDecision({ text: null, structured: { action: 'skip', extra: 1 } }), /Unrecognized key/);
  });
});

describe('text helpers', () => {
  it('normalizeDecisionText strips multiple think blocks and fences', () => {
    expect(normalizeDecisionText('<THINK>a</THINK> <thinking>b</thinking>```json\n{"x":1}\n```').text).toBe('{"x":1}');
  });

  it('stripReasoning removes think blocks, orphan closing tags and unterminated blocks, keeping everything else', () => {
    expect(stripReasoning('<think>secret plan</think>{"action":"skip"}')).toEqual({ text: '{"action":"skip"}', removed: true, unterminatedThink: false });
    expect(stripReasoning('plan...</think>\n{"action":"skip"}').text).toBe('\n{"action":"skip"}');
    expect(stripReasoning('{"action":"skip"} <thinking>more')).toEqual({ text: '{"action":"skip"} ', removed: true, unterminatedThink: true });
    // No reasoning: returned unchanged (fences and whitespace are kept for inspection).
    const plain = '```json\n{"action":"skip"}\n```';
    expect(stripReasoning(plain)).toEqual({ text: plain, removed: false, unterminatedThink: false });
  });

  it('extractSingleJsonObject reports empty output after stripping', () => {
    const r = extractSingleJsonObject('<think>only reasoning</think>');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/empty/);
  });
});
