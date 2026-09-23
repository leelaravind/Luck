/**
 * WEB CONTRACTS — props shared between UI owners so components can be built in parallel.
 * Components are presentational: they receive server-authoritative data and callbacks.
 */
import type {
  AnimationSpeed,
  BetInput,
  RoundBet,
  SessionMode,
  SessionPhase,
  SessionStatus,
  Subunits,
} from '../shared/contracts';

/** One spin to animate. Supplied by the server AFTER the outcome is persisted. */
export interface WheelSpin {
  roundId: string;
  winningNumber: number;
}

export interface RouletteWheelProps {
  /** Latest spin; null = idle. A new roundId starts a new animation. */
  readonly spin: WheelSpin | null;
  readonly speed: AnimationSpeed;
  /** Resolved reduced-motion preference (system setting or user override). */
  readonly reducedMotion: boolean;
  /** Called exactly once per roundId when the ball rests in the pocket. Presentation only. */
  readonly onSettled: (roundId: string) => void;
  /**
   * Last REVEALED result to show at rest when no spin is being animated (after a reload or a session
   * switch), so the ball stays in its pocket. Never animates and never calls onSettled.
   */
  readonly restingNumber?: number | null;
  readonly className?: string;
}

/** A clickable betting spot on the table (bet without stake). */
export interface BetSpot {
  key: string;
  bet: Omit<BetInput, 'stake'>;
  label: string;
  payout: number;
}

/** A draft (not yet committed) chip stack on a spot. Client-side only until "Spin". */
export interface DraftBet {
  spot: BetSpot;
  stake: Subunits;
}

export interface BettingTableProps {
  /** Draft chips (manual mode). */
  readonly draft: readonly DraftBet[];
  /** Committed bets of the current round (from the server) — shown read-only. */
  readonly committed: readonly RoundBet[];
  /** Disable placing (autonomous mode, round in flight, session ended). */
  readonly disabled: boolean;
  /** Number to highlight after the wheel settles (revealed result only). */
  readonly highlightNumber: number | null;
  readonly onPlace: (spot: BetSpot) => void;
  readonly onRemove: (spot: BetSpot) => void;
}

export interface ControlBarProps {
  readonly mode: SessionMode;
  readonly status: SessionStatus;
  readonly phase: SessionPhase;
  /** Revealed balance (updates after the wheel settles). */
  readonly balance: Subunits;
  readonly sessionNet: Subunits;
  /** Draft total (manual) or committed total (current round). */
  readonly currentStake: Subunits;
  /** Net of the last revealed round; null if none yet. */
  readonly lastNet: Subunits | null;
  readonly chipValue: Subunits;
  readonly chipValues: readonly Subunits[];
  readonly onChipChange: (v: Subunits) => void;
  readonly speed: AnimationSpeed;
  readonly onSpeedChange: (s: AnimationSpeed) => void;
  /** Manual: commit draft bets. */
  readonly onSpin: () => void;
  readonly canSpin: boolean;
  readonly onClear: () => void;
  readonly onUndo: () => void;
  readonly onRepeat: () => void;
  /** Autonomous controls. */
  readonly onStart: () => void;
  readonly onPause: () => void;
  readonly onStop: () => void;
  readonly onStep: () => void;
  /** A control request is in flight (disable buttons to prevent repeated clicks). */
  readonly busy: boolean;
  /** Wheel is still animating the latest committed round. */
  readonly animating: boolean;
}
