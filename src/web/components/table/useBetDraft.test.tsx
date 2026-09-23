// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { betKey } from '../../../shared/bets';
import { DEFAULT_LIMITS, type BetInput, type RoundBet, type SessionLimits } from '../../../shared/contracts';
import type { BetSpot } from '../../contracts';
import { allSpots, findSpot } from './spots';
import { previewBetSlip, useBetDraft } from './useBetDraft';

afterEach(cleanup);

const spot = (pos: Omit<BetInput, 'stake'>): BetSpot => {
  const s = findSpot(betKey(pos));
  if (!s) throw new Error(`no spot ${betKey(pos)}`);
  return s;
};
const RED = spot({ type: 'red' });
const SPLIT_8_11 = spot({ type: 'split', numbers: [8, 11] });
const DOZEN_2 = spot({ type: 'dozen', index: 2 });

function draftHook(balance = DEFAULT_LIMITS.startingBalance, limits: SessionLimits = DEFAULT_LIMITS) {
  return renderHook((p: { balance: number; limits: SessionLimits }) => useBetDraft(p), {
    initialProps: { balance, limits },
  });
}

const roundBet = (over: Partial<RoundBet> & Pick<RoundBet, 'key' | 'type' | 'stake'>): RoundBet => ({
  numbers: [],
  payout: 1,
  label: over.key,
  won: true,
  returned: 0,
  ...over,
});

describe('useBetDraft', () => {
  it('keeps totals exact integers across many 10-subunit chips', () => {
    const { result } = draftHook(10_000_000, { ...DEFAULT_LIMITS, maxStakePerBet: 1_000_000, maxStakePerRound: 10_000_000 });
    const spots = allSpots().slice(0, 7);
    act(() => {
      for (let i = 0; i < 1000; i++) result.current.place(spots[i % spots.length], 10);
    });
    expect(result.current.total).toBe(10_000);
    expect(Number.isSafeInteger(result.current.total)).toBe(true);
    const inputs = result.current.toBetInputs();
    expect(inputs.length).toBe(7);
    expect(inputs.reduce((a, b) => a + b.stake, 0)).toBe(10_000);
    for (const b of inputs) expect(Number.isInteger(b.stake)).toBe(true);
    // For contrast: adding 0.10 credits 1000 times in floating point drifts; subunits do not.
    let floatCredits = 0;
    for (let i = 0; i < 1000; i++) floatCredits += 0.1;
    expect(floatCredits).not.toBe(100);
  });

  it('stacks chips per spot and remove() takes off the most recent chip', () => {
    const { result } = draftHook();
    act(() => {
      result.current.place(RED, 10);
      result.current.place(RED, 50);
      result.current.place(SPLIT_8_11, 100);
    });
    expect(result.current.draft.map((d) => [d.spot.key, d.stake])).toEqual([
      ['red', 60],
      ['split:8-11', 100],
    ]);
    act(() => result.current.remove(RED));
    expect(result.current.draft[0]).toMatchObject({ stake: 10 });
    act(() => result.current.remove(RED));
    expect(result.current.draft.map((d) => d.spot.key)).toEqual(['split:8-11']);
    act(() => result.current.remove(RED)); // nothing left on red: no-op
    expect(result.current.total).toBe(100);
  });

  it('ignores non-integer, zero and negative chips', () => {
    const { result } = draftHook();
    act(() => {
      result.current.place(RED, 0);
      result.current.place(RED, -10);
      result.current.place(RED, 12.5);
      result.current.place(RED, Number.NaN);
    });
    expect(result.current.draft).toEqual([]);
    expect(result.current.canUndo).toBe(false);
  });

  it('undo reverts place, remove, clear and repeat in order', () => {
    const { result } = draftHook();
    act(() => {
      result.current.place(RED, 10);
      result.current.place(SPLIT_8_11, 50);
      result.current.place(SPLIT_8_11, 50);
    });
    act(() => result.current.remove(SPLIT_8_11));
    expect(result.current.total).toBe(60);
    act(() => result.current.clear());
    expect(result.current.total).toBe(0);
    act(() => result.current.undo()); // undo clear
    expect(result.current.total).toBe(60);
    act(() => result.current.undo()); // undo remove
    expect(result.current.total).toBe(110);
    act(() => result.current.undo()); // undo 2nd split chip
    expect(result.current.total).toBe(60);
    act(() => {
      result.current.undo();
      result.current.undo();
    });
    expect(result.current.draft).toEqual([]);
    expect(result.current.canUndo).toBe(false);
    act(() => result.current.undo()); // empty history: no-op
    expect(result.current.draft).toEqual([]);
  });

  it('repeat() replaces the draft with last round bets (merging keys) and is undoable', () => {
    const { result } = draftHook();
    act(() => result.current.place(RED, 10));
    const last: RoundBet[] = [
      roundBet({ key: 'dozen:2', type: 'dozen', index: 2, numbers: [13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24], stake: 200, payout: 2 }),
      roundBet({ key: 'split:8-11', type: 'split', numbers: [8, 11], stake: 50, payout: 17 }),
      roundBet({ key: 'split:8-11', type: 'split', numbers: [8, 11], stake: 30, payout: 17 }),
      roundBet({ key: 'split:3-4', type: 'split', numbers: [3, 4], stake: 30, payout: 17 }), // not a layout position
    ];
    act(() => result.current.repeat(last));
    expect(result.current.total).toBe(280);
    expect(result.current.toBetInputs()).toEqual([
      { type: 'dozen', index: 2, stake: 200 }, // index only, never the covered numbers
      { type: 'split', numbers: [8, 11], stake: 80 },
    ]);
    act(() => result.current.remove(SPLIT_8_11)); // most recent chip = the 30 from the 2nd entry
    expect(result.current.draft.find((d) => d.spot.key === 'split:8-11')?.stake).toBe(50);
    act(() => {
      result.current.undo();
      result.current.undo();
    });
    expect(result.current.draft.map((d) => [d.spot.key, d.stake])).toEqual([['red', 10]]);
  });

  it('removeAll() and reset()', () => {
    const { result } = draftHook();
    act(() => {
      result.current.place(DOZEN_2, 10);
      result.current.place(DOZEN_2, 10);
      result.current.place(RED, 10);
    });
    act(() => result.current.removeAll(DOZEN_2));
    expect(result.current.draft.map((d) => d.spot.key)).toEqual(['red']);
    act(() => result.current.reset());
    expect(result.current.draft).toEqual([]);
    expect(result.current.canUndo).toBe(false);
  });

  it('preview accepts a valid slip and flags maxStakePerRound and balance (feedback only)', () => {
    const limits: SessionLimits = { ...DEFAULT_LIMITS, maxStakePerBet: 10_000, maxStakePerRound: 15_000 };
    const { result, rerender } = draftHook(100_000, limits);
    expect(result.current.preview).toEqual({ ok: false, message: null }); // empty draft
    act(() => result.current.place(RED, 10_000));
    expect(result.current.preview).toEqual({ ok: true, message: null });
    act(() => result.current.place(DOZEN_2, 10_000));
    expect(result.current.preview.ok).toBe(false);
    expect(result.current.preview.message).toMatch(/maximum stake per round/);
    act(() => result.current.undo());
    rerender({ balance: 5_000, limits });
    expect(result.current.preview.ok).toBe(false);
    expect(result.current.preview.message).toMatch(/exceeds the balance/);
  });

  it('preview flags stakes off the increment and over the per-bet cap', () => {
    const limits: SessionLimits = { ...DEFAULT_LIMITS, stakeIncrement: 50, minStake: 50, maxStakePerBet: 100 };
    expect(previewBetSlip([{ type: 'red', stake: 60 }], 10_000, limits).message).toMatch(/multiple of the stake increment/);
    expect(previewBetSlip([{ type: 'red', stake: 150 }], 10_000, limits).message).toMatch(/maximum stake per bet/);
    expect(previewBetSlip([{ type: 'red', stake: 100 }], 10_000, limits)).toEqual({ ok: true, message: null });
  });
});
