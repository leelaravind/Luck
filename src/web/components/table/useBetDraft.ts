/**
 * OWNER: betting-table agent (A5). Client-side draft bets for manual play.
 *
 * The draft lives only in the browser until the player presses Spin. It is a convenience:
 *  - integer subunits only (every chip is a positive safe integer; totals are exact sums),
 *  - `preview` runs the SHARED validateBetSlip for feedback only — it is labelled a preview in the
 *    UI and the server re-validates every bet authoritatively when the round is submitted.
 */
import { useCallback, useMemo, useReducer } from 'react';
import { validateBetSlip } from '../../../shared/bets';
import { GameError, type BetInput, type RoundBet, type SessionLimits, type Subunits } from '../../../shared/contracts';
import type { BetSpot, DraftBet } from '../../contracts';
import { spotForRoundBet } from './spots';

/** One spot's chips in placement order (the last element is the most recent chip). */
interface Stack {
  readonly spot: BetSpot;
  readonly chips: readonly Subunits[];
}

interface State {
  /** Stacks in order of first placement. */
  readonly stacks: readonly Stack[];
  /** Previous `stacks` values, newest last (undo restores the last one). */
  readonly history: readonly (readonly Stack[])[];
}

type Action =
  | { type: 'place'; spot: BetSpot; stake: Subunits }
  | { type: 'remove'; spot: BetSpot }
  | { type: 'removeAll'; spot: BetSpot }
  | { type: 'undo' }
  | { type: 'clear' }
  | { type: 'repeat'; bets: readonly RoundBet[] }
  | { type: 'reset' };

/** Undo depth. Older steps are dropped (the draft itself is never truncated). */
export const MAX_UNDO_STEPS = 200;

const EMPTY: State = { stacks: [], history: [] };

function commit(state: State, stacks: readonly Stack[]): State {
  if (stacks === state.stacks) return state;
  const history = [...state.history, state.stacks];
  if (history.length > MAX_UNDO_STEPS) history.splice(0, history.length - MAX_UNDO_STEPS);
  return { stacks, history };
}

function isChip(stake: unknown): stake is Subunits {
  return typeof stake === 'number' && Number.isSafeInteger(stake) && stake > 0;
}

/** Convert a server RoundBet into a draft stack (one chip of the full stake). */
function stackFromRoundBet(rb: RoundBet): Stack | null {
  if (!isChip(rb.stake)) return null;
  const spot: BetSpot | undefined = spotForRoundBet(rb);
  return spot ? { spot, chips: [rb.stake] } : null;
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'place': {
      if (!isChip(action.stake)) return state;
      const i = state.stacks.findIndex((s) => s.spot.key === action.spot.key);
      if (i < 0) return commit(state, [...state.stacks, { spot: action.spot, chips: [action.stake] }]);
      const stacks = state.stacks.slice();
      stacks[i] = { spot: stacks[i].spot, chips: [...stacks[i].chips, action.stake] };
      return commit(state, stacks);
    }
    case 'remove': {
      const i = state.stacks.findIndex((s) => s.spot.key === action.spot.key);
      if (i < 0) return state;
      const chips = state.stacks[i].chips.slice(0, -1);
      const stacks = state.stacks.slice();
      if (chips.length === 0) stacks.splice(i, 1);
      else stacks[i] = { spot: stacks[i].spot, chips };
      return commit(state, stacks);
    }
    case 'removeAll': {
      if (!state.stacks.some((s) => s.spot.key === action.spot.key)) return state;
      return commit(
        state,
        state.stacks.filter((s) => s.spot.key !== action.spot.key),
      );
    }
    case 'undo': {
      if (state.history.length === 0) return state;
      return { stacks: state.history[state.history.length - 1], history: state.history.slice(0, -1) };
    }
    case 'clear':
      return state.stacks.length === 0 ? state : commit(state, []);
    case 'repeat': {
      // Replace the draft with the given bets; identical keys are merged in order of appearance.
      const stacks: Stack[] = [];
      for (const rb of action.bets) {
        const next = stackFromRoundBet(rb);
        if (!next) continue;
        const i = stacks.findIndex((s) => s.spot.key === next.spot.key);
        if (i < 0) stacks.push(next);
        else stacks[i] = { spot: stacks[i].spot, chips: [...stacks[i].chips, ...next.chips] };
      }
      if (stacks.length === 0) return state;
      return commit(state, stacks);
    }
    case 'reset':
      return EMPTY;
  }
}

function sum(chips: readonly Subunits[]): Subunits {
  let total = 0;
  for (const c of chips) total += c;
  return total;
}

/** Convert draft bets into the exact BetInput payload the server expects (fresh objects). */
export function draftToBetInputs(draft: readonly DraftBet[]): BetInput[] {
  return draft.map(({ spot, stake }) => {
    const input: BetInput = { type: spot.bet.type, stake };
    if (spot.bet.numbers) input.numbers = [...spot.bet.numbers];
    if (spot.bet.index !== undefined) input.index = spot.bet.index;
    return input;
  });
}

export interface DraftPreview {
  /** true when the shared rules accept the slip right now. FEEDBACK ONLY — the server decides. */
  ok: boolean;
  /** Why the slip would be rejected, or null (also null for an empty draft). */
  message: string | null;
}

/** Client-side preview of validateBetSlip. Never authoritative; the server re-validates on Spin. */
export function previewBetSlip(bets: readonly BetInput[], balance: Subunits, limits: SessionLimits): DraftPreview {
  if (bets.length === 0) return { ok: false, message: null };
  try {
    validateBetSlip(bets, { balance, limits });
    return { ok: true, message: null };
  } catch (err) {
    if (err instanceof GameError) return { ok: false, message: err.message };
    return { ok: false, message: 'Could not check this bet slip locally; the server will validate it.' };
  }
}

export interface BetDraftApi {
  draft: DraftBet[];
  /** Add one chip of `stake` subunits to a spot. Ignored unless stake is a positive safe integer. */
  place(spot: BetSpot, stake: Subunits): void;
  /** Remove the most recent chip on a spot. */
  remove(spot: BetSpot): void;
  /** Remove every chip on a spot (bet slip "remove" button). Extension beyond the brief. */
  removeAll(spot: BetSpot): void;
  /** Revert the last place / remove / clear / repeat. */
  undo(): void;
  /** Remove all chips (undoable). */
  clear(): void;
  /** Replace the draft with a previous round's bets (undoable). Unknown positions are skipped. */
  repeat(bets: RoundBet[]): void;
  /** Empty the draft AND the undo history (e.g. after a successful spin or a session change). */
  reset(): void;
  canUndo: boolean;
  total: Subunits;
  toBetInputs(): BetInput[];
  preview: DraftPreview;
}

export function useBetDraft(opts: { balance: Subunits; limits: SessionLimits }): BetDraftApi {
  const [state, dispatch] = useReducer(reducer, EMPTY);
  const { balance, limits } = opts;

  const draft = useMemo<DraftBet[]>(
    () => state.stacks.map((s) => ({ spot: s.spot, stake: sum(s.chips) })),
    [state.stacks],
  );
  const total = useMemo(() => sum(draft.map((d) => d.stake)), [draft]);
  const inputs = useMemo(() => draftToBetInputs(draft), [draft]);
  const preview = useMemo(() => previewBetSlip(inputs, balance, limits), [inputs, balance, limits]);

  const place = useCallback((spot: BetSpot, stake: Subunits) => dispatch({ type: 'place', spot, stake }), []);
  const remove = useCallback((spot: BetSpot) => dispatch({ type: 'remove', spot }), []);
  const removeAll = useCallback((spot: BetSpot) => dispatch({ type: 'removeAll', spot }), []);
  const undo = useCallback(() => dispatch({ type: 'undo' }), []);
  const clear = useCallback(() => dispatch({ type: 'clear' }), []);
  const repeat = useCallback((bets: RoundBet[]) => dispatch({ type: 'repeat', bets }), []);
  const reset = useCallback(() => dispatch({ type: 'reset' }), []);
  const toBetInputs = useCallback(() => draftToBetInputs(draft), [draft]);

  return {
    draft,
    place,
    remove,
    removeAll,
    undo,
    clear,
    repeat,
    reset,
    canUndo: state.history.length > 0,
    total,
    toBetInputs,
    preview,
  };
}

export default useBetDraft;
