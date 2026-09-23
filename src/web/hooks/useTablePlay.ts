/**
 * Wires the store to the betting table (agent 5's BettingTable + useBetDraft) and the apron ControlBar.
 * Everything the table and control bar display is the REVEALED presentation (see state/reveal.ts), so
 * neither can leak a result before the wheel settles.
 */
import { useCallback, useEffect, useMemo } from 'react';
import type { RoundBet, SessionLimits } from '../../shared/contracts';
import { DEFAULT_LIMITS } from '../../shared/contracts';
import type { BetSpot, BettingTableProps, ControlBarProps } from '../contracts';
import type { ControlBarExtraProps } from '../components/controls/ControlBar';
import { useBetDraft } from '../components/table/useBetDraft';
import type { LuckStore } from '../state/useLuck';
import { useChips } from './useChips';

const TERMINAL = new Set(['stopped', 'completed']);

/** Hide per-bet win/loss for a round whose result is not revealed yet. */
function maskBets(bets: readonly RoundBet[]): RoundBet[] {
  return bets.map((b) => ({ ...b, won: null, returned: null }));
}

export function useTablePlay(store: LuckStore) {
  const { state, presentation: p, actions, speed } = store;
  const snapshot = state.snapshot;
  const session = snapshot?.session ?? null;
  const limits: SessionLimits = session?.limits ?? DEFAULT_LIMITS;

  const betDraft = useBetDraft({ balance: p?.balance ?? 0, limits });
  const chips = useChips(limits);

  // A different session starts with an empty draft.
  const { reset } = betDraft;
  useEffect(() => {
    reset();
  }, [session?.id, reset]);

  const manual = session?.mode === 'manual';
  const terminal = session ? TERMINAL.has(session.status) : true;
  const animating = p?.animating ?? false;
  const roundBusy = state.busy.round || (snapshot?.inFlight.round ?? false);
  const canPlace = !!session && manual && !terminal && !roundBusy && !animating && !state.busy.sessionLoading;
  const canSpin = canPlace && betDraft.draft.length > 0 && betDraft.preview.ok;

  // Committed chips from the server: the round in play / spinning, or the last revealed round while no
  // new draft has been started. Win/loss flags are masked until the result is revealed.
  const committed: RoundBet[] = useMemo(() => {
    if (!p || betDraft.draft.length) return [];
    if (p.spinningRound) return maskBets(p.spinningRound.bets);
    if (p.inPlayRound) return maskBets(p.inPlayRound.bets);
    return p.lastRound ? p.lastRound.bets : [];
  }, [p, betDraft.draft.length]);

  const { placeRound, control, setAnimationSpeed } = actions;
  const onSpin = useCallback(async () => {
    if (!canSpin) return;
    const ok = await placeRound(betDraft.toBetInputs());
    if (ok) betDraft.reset();
  }, [canSpin, placeRound, betDraft]);

  const repeatSource = p?.lastRound?.bets ?? [];
  const onRepeat = useCallback(() => {
    if (canPlace && repeatSource.length) betDraft.repeat([...repeatSource]);
  }, [canPlace, repeatSource, betDraft]);

  const onPlace = useCallback(
    (spot: BetSpot) => {
      if (canPlace) betDraft.place(spot, chips.chipValue);
    },
    [canPlace, betDraft, chips.chipValue],
  );
  const onRemove = useCallback(
    (spot: BetSpot) => {
      if (canPlace) betDraft.remove(spot);
    },
    [canPlace, betDraft],
  );

  const tableProps: BettingTableProps | null = session
    ? {
        draft: betDraft.draft,
        committed,
        disabled: !canPlace,
        highlightNumber: p?.highlightNumber ?? null,
        onPlace,
        onRemove,
      }
    : null;

  const controlProps: (ControlBarProps & ControlBarExtraProps) | null =
    session && p
      ? {
          mode: session.mode,
          status: session.status,
          phase: session.phase,
          balance: p.balance,
          sessionNet: p.sessionNet,
          currentStake: manual && betDraft.draft.length ? betDraft.total : p.stakeOnTable,
          lastNet: p.lastRound?.net ?? null,
          chipValue: chips.chipValue,
          chipValues: chips.chipValues,
          onChipChange: chips.setChipValue,
          speed,
          onSpeedChange: setAnimationSpeed,
          onSpin: () => void onSpin(),
          canSpin,
          onClear: betDraft.clear,
          onUndo: betDraft.undo,
          onRepeat,
          onStart: () => void control('start'),
          onPause: () => void control('pause'),
          onStop: () => void control('stop'),
          onStep: () => void control('step'),
          busy: state.busy.control !== null || state.busy.round,
          animating,
          canUndo: canPlace && betDraft.canUndo,
          canClear: canPlace && betDraft.draft.length > 0,
          canRepeat: canPlace && repeatSource.length > 0,
        }
      : null;

  return {
    tableProps,
    controlProps,
    /** Client-side preview message (never authoritative). */
    draftMessage: betDraft.draft.length && !betDraft.preview.ok ? betDraft.preview.message : null,
    roundError: state.lastError?.scope === 'round' ? state.lastError : null,
    controlError: state.lastError?.scope === 'control' ? state.lastError : null,
  };
}
