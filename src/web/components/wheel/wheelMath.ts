/**
 * WHEEL MATH — pure kinematics for the roulette wheel animation (no DOM, no React).
 *
 * Angle conventions (degrees):
 * - Every angle is measured CLOCKWISE from 12 o'clock, which is also what SVG `rotate(θ)` does
 *   (SVG's y axis points down), so these numbers can be written straight into transforms.
 * - Rotor coordinates: pocket `WHEEL_ORDER[i]` is centred at `pocketCenterAngle(i)`; pocket 0 sits at 0°.
 * - `rotorAngle` is the rotor's rotation in the stationary (absolute) frame.
 * - `psi` (a.k.a. ballRelAngle) is the ball's angle RELATIVE to the rotor, so the absolute ball angle is
 *   `rotorAngle + psi`.
 *
 * The outcome is an INPUT. Nothing here chooses a number: `planSpin` receives the server-drawn
 * `winningNumber` and builds a trajectory that ends exactly in that pocket. The optional `rand` only
 * varies presentation (extra laps, rotor push, bounce size) and can never change where the ball lands.
 */
import { POCKET_COUNT, WHEEL_ORDER, isRouletteNumber, wheelIndexOf } from '../../../shared/roulette';
import type { AnimationSpeed } from '../../../shared/contracts';

/** Angular width of one pocket: 360 / 37 ≈ 9.73°. */
export const POCKET_ANGLE = 360 / POCKET_COUNT;

/** Slow clockwise rotor drift while idle (after a settle), in degrees per second. */
export const IDLE_DEG_PER_SEC = 6;

/**
 * Spin durations per animation speed (presentation only; never affects model call frequency).
 * "instant" is 0: no spin at all — the ball is placed straight into the pocket, as with reduced motion.
 */
export const SPIN_DURATION_MS: Readonly<Record<AnimationSpeed, number>> = Object.freeze({
  normal: 6500,
  fast: 3200,
  instant: 0,
});

/** Fractions of the spin duration at which the ball stages change. */
export const LAUNCH_END = 0.06;
export const DROP_START = 0.62;
/** Within the drop stage: fraction spent spiralling in before the damped bounces start. */
const DROP_SPIRAL_PORTION = 0.4;

export type SpinStage = 'launch' | 'orbit' | 'drop' | 'settled';

/** Where a spin starts. Consecutive spins pass the previous spin's end state here. */
export interface SpinStart {
  /** Rotor angle in the absolute frame (any real number; normalised internally). */
  rotorAngle: number;
  /** Ball angle relative to the rotor (psi). For a follow-up spin this is the previous pocket centre. */
  ballRelAngle: number;
  /**
   * Normalised ball radius at the start: 0 = on the outer ball track, 1 = resting in a pocket.
   * Defaults to 1 (ball lifted out of the previous pocket and launched back onto the track).
   */
  ballRadius?: number;
}

export interface SpinOptions {
  /** Total animation time; 0 = rest immediately in the pocket (reduced motion). */
  durationMs: number;
  /** Presentation-only randomness in [0, 1). Default Math.random. Never influences the landing pocket. */
  rand?: () => number;
  /** Full relative laps of the ball around the rotor (k). Default by duration: 4–5 normal, 3 fast, 1 for short spins. */
  laps?: number;
  /** Rotor push in full turns during the spin (clockwise ease-out). Default scales with duration. */
  rotorTurns?: number;
  /** Idle drift speed in degrees per second (0 = no drift, e.g. reduced motion). */
  idleDegPerSec?: number;
}

/** A fully determined trajectory. Treat as immutable; sample it with `sampleSpin`. */
export interface SpinPlan {
  readonly winningNumber: number;
  /** Index of the winning number in WHEEL_ORDER. */
  readonly winnerIndex: number;
  /** pocketCenterAngle(winnerIndex): psi at and after the settle, exactly. */
  readonly targetRelAngle: number;
  readonly durationMs: number;
  /** Normalised rotor angle at t = 0. */
  readonly rotorStart: number;
  /** Clockwise ease-out travel of the rotor over the spin (degrees, >= 0), on top of the idle drift. */
  readonly rotorTravel: number;
  readonly idleDegPerSec: number;
  /** Normalised psi at t = 0. */
  readonly psiStart: number;
  /** Total decrease of psi over the spin: normalise(psiStart - target) + 360 * laps. */
  readonly relTravel: number;
  readonly laps: number;
  /** Normalised ball radius at t = 0 (0 track … 1 pocket). */
  readonly startRadius: number;
  /** Peak bounce height as a fraction of the track→pocket distance (visual only). */
  readonly bounceAmp: number;
  readonly bounceCount: number;
}

export interface SpinSample {
  /** Absolute rotor angle (not normalised; continuous within one plan). */
  rotorAngle: number;
  /** Absolute ball angle = rotorAngle + ballRelAngle. */
  ballAngle: number;
  /** psi: ball angle relative to the rotor. Equals pocketCenterAngle(winnerIndex) exactly once settled. */
  ballRelAngle: number;
  /** 0 = on the outer ball track … 1 = resting in the pocket. */
  ballRadius: number;
  stage: SpinStage;
}

/** Normalise an angle to [0, 360). */
export function normalizeAngle(deg: number): number {
  const r = deg % 360;
  const n = r < 0 ? r + 360 : r;
  // -1e-15 % 360 + 360 can round to exactly 360.
  return n >= 360 ? 0 : n;
}

/** Signed smallest difference a - b in (-180, 180]. */
export function angleDelta(a: number, b: number): number {
  const d = normalizeAngle(a - b);
  return d > 180 ? d - 360 : d;
}

/** Centre of pocket `WHEEL_ORDER[index]` in rotor coordinates (clockwise from 12 o'clock). */
export function pocketCenterAngle(index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= POCKET_COUNT) {
    throw new RangeError(`Pocket index out of range: ${index}`);
  }
  return index * POCKET_ANGLE;
}

/** Which number's pocket is under an absolute ball angle, given the absolute rotor angle. */
export function numberUnderBall(rotorAngleDeg: number, ballAngleDeg: number): number {
  const rel = normalizeAngle(ballAngleDeg - rotorAngleDeg);
  const index = Math.round(rel / POCKET_ANGLE) % POCKET_COUNT;
  return WHEEL_ORDER[index]!;
}

/** Rotor angle during a pre-spin idle drift. */
export function idleRotorAngle(baseAngle: number, elapsedMs: number, degPerSec = IDLE_DEG_PER_SEC): number {
  return baseAngle + (degPerSec * Math.max(0, elapsedMs)) / 1000;
}

// ── easing ──────────────────────────────────────────────────────────────────

/** Rotor: quadratic ease-out, zero extra velocity at the end (only the idle drift remains). */
const easeRotor = (u: number) => 1 - (1 - u) * (1 - u);
/** Ball (relative): cubic ease-out, zero relative velocity at the end so the rotor carries the ball. */
const easeBall = (u: number) => 1 - (1 - u) * (1 - u) * (1 - u);
const smoothstep = (x: number) => x * x * (3 - 2 * x);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

function safeRand(rand: () => number): number {
  const r = rand();
  return Number.isFinite(r) ? Math.min(Math.max(r, 0), 0.999999) : 0.5;
}

function assertFinite(name: string, v: number): void {
  if (!Number.isFinite(v)) throw new RangeError(`${name} must be a finite number, got ${v}`);
}

// ── planning ────────────────────────────────────────────────────────────────

/**
 * Build a trajectory from `start` that lands in `winningNumber`'s pocket at t = durationMs.
 * With durationMs = 0 the plan is already settled at t = 0 (ball placed straight into the pocket,
 * rotor untouched) — used for reduced motion and the "instant" speed.
 */
export function planSpin(start: SpinStart, winningNumber: number, opts: SpinOptions): SpinPlan {
  if (!isRouletteNumber(winningNumber)) throw new RangeError(`Not a roulette number: ${winningNumber}`);
  assertFinite('rotorAngle', start.rotorAngle);
  assertFinite('ballRelAngle', start.ballRelAngle);
  const durationMs = opts.durationMs;
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new RangeError(`durationMs must be >= 0, got ${durationMs}`);
  }
  const rand = opts.rand ?? Math.random;
  const winnerIndex = wheelIndexOf(winningNumber);
  const targetRelAngle = pocketCenterAngle(winnerIndex);
  const rotorStart = normalizeAngle(start.rotorAngle);
  const psiStart = normalizeAngle(start.ballRelAngle);
  const idleDegPerSec = opts.idleDegPerSec ?? IDLE_DEG_PER_SEC;
  const startRadius = clamp01(start.ballRadius ?? 1);

  if (durationMs === 0) {
    return Object.freeze({
      winningNumber,
      winnerIndex,
      targetRelAngle,
      durationMs: 0,
      rotorStart,
      rotorTravel: 0,
      idleDegPerSec,
      psiStart,
      relTravel: 0,
      laps: 0,
      startRadius,
      bounceAmp: 0,
      bounceCount: 0,
    });
  }

  // Draw every presentation-only random value up front, in a fixed order.
  const rLaps = safeRand(rand);
  const rRotor = safeRand(rand);
  const rBounceAmp = safeRand(rand);
  const rBounceCount = safeRand(rand);

  const defaultLaps =
    durationMs >= 5000 ? 4 + Math.floor(rLaps * 2) : durationMs >= 2000 ? 3 : 1;
  const laps = Math.max(0, Math.floor(opts.laps ?? defaultLaps));
  const defaultTurns = durationMs >= 5000 ? 1.25 : durationMs >= 2000 ? 0.9 : 0.12;
  const rotorTurns = Math.max(0, opts.rotorTurns ?? defaultTurns * (0.9 + 0.2 * rRotor));

  // psi must decrease by exactly this much so that psiStart - relTravel ≡ target (mod 360).
  const relTravel = normalizeAngle(psiStart - targetRelAngle) + 360 * laps;

  return Object.freeze({
    winningNumber,
    winnerIndex,
    targetRelAngle,
    durationMs,
    rotorStart,
    rotorTravel: 360 * rotorTurns,
    idleDegPerSec,
    psiStart,
    relTravel,
    laps,
    startRadius,
    bounceAmp: 0.1 + 0.12 * rBounceAmp,
    bounceCount: 2 + Math.floor(rBounceCount * 2),
  });
}

/** Normalised ball radius (0 track … 1 pocket) at spin fraction u in [0, 1). */
function radiusAt(plan: SpinPlan, u: number): number {
  if (u < LAUNCH_END) {
    // Lifted out of the previous pocket (if it was in one) back onto the track.
    return plan.startRadius * (1 - smoothstep(u / LAUNCH_END));
  }
  if (u < DROP_START) return 0;
  const v = (u - DROP_START) / (1 - DROP_START);
  if (v < DROP_SPIRAL_PORTION) return smoothstep(v / DROP_SPIRAL_PORTION);
  // Damped hops over the frets: zero at both ends, so the ball ends exactly at the pocket radius.
  const w = (v - DROP_SPIRAL_PORTION) / (1 - DROP_SPIRAL_PORTION);
  const hop = Math.abs(Math.sin(Math.PI * plan.bounceCount * w)) * (1 - w) * (1 - w);
  return 1 - plan.bounceAmp * hop;
}

/** Settled end state of a plan (rotor includes idle drift up to `elapsedMs`). */
function settledSample(plan: SpinPlan, elapsedMs: number): SpinSample {
  const rotorAngle = plan.rotorStart + plan.rotorTravel + (plan.idleDegPerSec * elapsedMs) / 1000;
  const ballRelAngle = plan.targetRelAngle; // snapped: kills accumulated float error
  return { rotorAngle, ballAngle: rotorAngle + ballRelAngle, ballRelAngle, ballRadius: 1, stage: 'settled' };
}

/**
 * Sample the plan at `elapsedMs` since its start. At and after `durationMs` the ball is attached to
 * the winning pocket (ballAngle = rotorAngle + pocketCenterAngle(winnerIndex)) while the rotor drifts.
 */
export function sampleSpin(plan: SpinPlan, elapsedMs: number): SpinSample {
  // Non-finite input: +Infinity means "long over" (settled, no extra drift); NaN / -Infinity mean t = 0.
  const t = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : elapsedMs > 0 ? plan.durationMs : 0;
  if (plan.durationMs <= 0 || t >= plan.durationMs) return settledSample(plan, t);

  const u = t / plan.durationMs;
  const rotorAngle = plan.rotorStart + plan.rotorTravel * easeRotor(u) + (plan.idleDegPerSec * t) / 1000;
  const ballRelAngle = plan.psiStart - plan.relTravel * easeBall(u);
  const stage: SpinStage = u < LAUNCH_END ? 'launch' : u < DROP_START ? 'orbit' : 'drop';
  return {
    rotorAngle,
    ballAngle: rotorAngle + ballRelAngle,
    ballRelAngle,
    ballRadius: radiusAt(plan, u),
    stage,
  };
}

/** The start state for the next spin, taken from a sample of the previous one. */
export function nextSpinStart(sample: Pick<SpinSample, 'rotorAngle' | 'ballRelAngle' | 'ballRadius'>): SpinStart {
  return { rotorAngle: sample.rotorAngle, ballRelAngle: sample.ballRelAngle, ballRadius: sample.ballRadius };
}
