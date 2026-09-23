/**
 * Per-decision usage: groups the session's UsageRecords (GET /api/sessions/:id/usage and live 'usage'
 * events) by decisionId, attempts in order. Display only — nothing here estimates a missing number.
 */
import type { UsageRecord } from '../../shared/contracts';

/** Shared empty list, so components receiving "no records" do not re-render on every new array. */
export const NO_USAGE: readonly UsageRecord[] = Object.freeze([]);

export function groupUsageByDecision(records: readonly UsageRecord[]): ReadonlyMap<string, readonly UsageRecord[]> {
  const byDecision = new Map<string, UsageRecord[]>();
  for (const r of records) {
    const list = byDecision.get(r.decisionId);
    if (list) list.push(r);
    else byDecision.set(r.decisionId, [r]);
  }
  for (const list of byDecision.values()) {
    list.sort((a, b) => a.attempt - b.attempt || a.createdAt.localeCompare(b.createdAt));
  }
  return byDecision;
}
