// @vitest-environment jsdom
// Per-decision usage and the provider note (#5, #29): exact server figures, "Not reported" when missing.
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { USAGE_STATUS_LABEL } from '../../copy';
import { fixtureDecision, fixtureUsageRecord } from '../../state/testFixtures';
import { DecisionUsage } from './DecisionUsage';
import { LatestDecisionCard } from './LatestDecisionCard';
import { LogsDecisionsPanel } from './LogsDecisionsPanel';
import { ProviderNote } from './ProviderNote';

afterEach(cleanup);

describe('DecisionUsage', () => {
  it('shows each attempt with tokens, cost + basis, latency and the attempt status label', () => {
    render(
      <DecisionUsage
        decisionStatus="accepted"
        records={[
          fixtureUsageRecord({ id: 'x1', attempt: 1, status: 'rate_limited', known: false, inputTokens: null, outputTokens: null, cacheReadTokens: null, costMicros: null, costBasis: 'unknown', latencyMs: 320 }),
          fixtureUsageRecord({
            id: 'x2',
            attempt: 2,
            inputTokens: 4_321,
            outputTokens: 99,
            cacheReadTokens: 4_000,
            cacheWriteTokens: 300,
            reasoningTokens: 12,
            costMicros: 25_000,
            costBasis: 'provider-reported',
            latencyMs: 12_345,
          }),
        ]}
      />,
    );
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    const [a1, a2] = items as [HTMLElement, HTMLElement];
    expect(within(a1).getByText(USAGE_STATUS_LABEL.rate_limited)).toBeTruthy();
    expect(within(a1).getAllByText('Not reported')).toHaveLength(4); // in, out, cached, cost
    expect(within(a1).getByText('320 ms')).toBeTruthy();
    expect(within(a2).getByText(USAGE_STATUS_LABEL.ok)).toBeTruthy();
    for (const t of ['4,321', '99', '4,000', '300', '12', '$0.025', '(reported by the provider tool)', '12.3 s']) {
      expect(within(a2).getByText(t)).toBeTruthy();
    }
    expect(within(a2).queryByText('Not reported')).toBeNull();
  });

  it('local providers show "no charge" instead of a cost; unreported latency is "Not reported"', () => {
    render(
      <DecisionUsage
        decisionStatus="accepted"
        records={[fixtureUsageRecord({ providerKind: 'ollama', costMicros: null, costBasis: 'local-no-charge', latencyMs: null })]}
      />,
    );
    expect(screen.getByText('Local — no cloud inference charge')).toBeTruthy();
    expect(screen.getAllByText('Not reported')).toHaveLength(1); // latency only
  });

  it('no records: in flight, not sent (budget) or not reported — never zero', () => {
    const { rerender } = render(<DecisionUsage decisionStatus="pending" records={[]} />);
    expect(screen.getByText('In flight')).toBeTruthy();
    rerender(<DecisionUsage decisionStatus="blocked_budget" records={[]} />);
    expect(screen.getByText('Not sent')).toBeTruthy();
    rerender(<DecisionUsage decisionStatus="failed" records={[]} />);
    expect(screen.getByText('Not reported')).toBeTruthy();
    expect(screen.queryByText('0')).toBeNull();
  });
});

describe('provider note', () => {
  it('is labelled as an adapter note and hidden when absent', () => {
    const { container, rerender } = render(<ProviderNote note={null} />);
    expect(container.textContent).toBe('');
    rerender(<ProviderNote note="  " />);
    expect(container.textContent).toBe('');
    rerender(<ProviderNote note="top labels: red 0.61, black 0.30 · routing: bet" />);
    expect(screen.getByText('Provider note (adapter, not the model)')).toBeTruthy();
    expect(screen.getByText('top labels: red 0.61, black 0.30 · routing: bet')).toBeTruthy();
  });

  it('appears in the latest decision card and the decisions log; demo decisions show no usage block', () => {
    const ai = fixtureDecision({ id: 'd-ai', providerNote: 'conversation 1234 · turn 3 (resumed)' });
    const demo = fixtureDecision({ id: 'd-demo', roundNumber: 2, providerKind: 'demo', model: null, providerNote: null });
    render(
      <>
        <LatestDecisionCard decision={ai} mode="ai" usage={[fixtureUsageRecord({ decisionId: 'd-ai' })]} />
        <LogsDecisionsPanel
          logs={[]}
          decisions={[demo, ai]}
          usageByDecision={new Map([['d-ai', [fixtureUsageRecord({ decisionId: 'd-ai' })]]])}
          heldBack={0}
        />
      </>,
    );
    expect(screen.getAllByText('conversation 1234 · turn 3 (resumed)')).toHaveLength(2);
    expect(screen.getAllByText('Usage per attempt')).toHaveLength(2); // card + the AI decision in the log
    const demoItem = screen.getByText('Round #2').closest('li')!;
    expect(within(demoItem).queryByText('Usage per attempt')).toBeNull();
  });
});
