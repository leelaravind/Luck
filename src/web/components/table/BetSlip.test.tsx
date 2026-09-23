// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DraftBet } from '../../contracts';
import { BetSlip } from './BetSlip';
import { findSpot } from './spots';

afterEach(cleanup);

const draft: DraftBet[] = [
  { spot: findSpot('split:8-11')!, stake: 50 },
  { spot: findSpot('red')!, stake: 1_000 },
];

describe('BetSlip', () => {
  it('lists draft bets with stakes, payout and total', () => {
    render(<BetSlip draft={draft} total={1_050} preview={{ ok: true, message: null }} onRemove={vi.fn()} />);
    expect(screen.getByText('Split 8/11')).toBeTruthy();
    expect(screen.getByText('pays 17 to 1')).toBeTruthy();
    expect(screen.getByText('V$ 0.50')).toBeTruthy();
    expect(screen.getByText('V$ 10.50')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/^Preview: within the rules and limits\. The server re-checks/);
  });

  it('remove buttons report the spot', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(<BetSlip draft={draft} total={1_050} preview={{ ok: true, message: null }} onRemove={onRemove} />);
    await user.click(screen.getByRole('button', { name: 'Remove Red (V$ 10.00)' }));
    expect(onRemove).toHaveBeenCalledWith(draft[1].spot);
  });

  it('labels the local check as a preview and shows the server error separately', () => {
    render(
      <BetSlip
        draft={draft}
        total={1_050}
        preview={{ ok: false, message: 'Combined stake exceeds the balance' }}
        serverError="Insufficient funds"
        onRemove={vi.fn()}
      />,
    );
    expect(screen.getByRole('status').textContent).toContain('Preview: Combined stake exceeds the balance');
    expect(screen.getByRole('alert').textContent).toContain('Insufficient funds');
  });

  it('shows an empty state without a preview', () => {
    render(<BetSlip draft={[]} total={0} preview={{ ok: false, message: null }} onRemove={vi.fn()} />);
    expect(screen.getByText(/No chips placed yet/)).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('disables remove buttons when disabled', () => {
    render(<BetSlip draft={draft} total={1_050} preview={{ ok: true, message: null }} onRemove={vi.fn()} disabled />);
    for (const b of screen.getAllByRole('button')) expect((b as HTMLButtonElement).disabled).toBe(true);
  });
});
