// Per-decision grouping of usage records (display only).
import { describe, expect, it } from 'vitest';
import { fixtureUsageRecord } from './testFixtures';
import { groupUsageByDecision, NO_USAGE } from './usage';

describe('groupUsageByDecision', () => {
  it('matches records to their decision by decisionId, attempts in order', () => {
    const records = [
      fixtureUsageRecord({ id: 'b2', decisionId: 'b', attempt: 2, createdAt: '2026-09-23T10:00:09.000Z' }),
      fixtureUsageRecord({ id: 'a1', decisionId: 'a', attempt: 1 }),
      fixtureUsageRecord({ id: 'b1', decisionId: 'b', attempt: 1, createdAt: '2026-09-23T10:00:08.000Z' }),
      fixtureUsageRecord({ id: 'b3', decisionId: 'b', attempt: 3, createdAt: '2026-09-23T10:00:07.000Z' }),
    ];
    const byDecision = groupUsageByDecision(records);
    expect(byDecision.get('a')?.map((r) => r.id)).toEqual(['a1']);
    expect(byDecision.get('b')?.map((r) => r.id)).toEqual(['b1', 'b2', 'b3']);
    expect(byDecision.get('missing')).toBeUndefined();
    expect(records.map((r) => r.id)).toEqual(['b2', 'a1', 'b1', 'b3']); // input untouched
  });

  it('empty input gives an empty map; NO_USAGE is a frozen empty list', () => {
    expect(groupUsageByDecision([]).size).toBe(0);
    expect(NO_USAGE).toHaveLength(0);
    expect(Object.isFrozen(NO_USAGE)).toBe(true);
  });
});
