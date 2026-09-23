/**
 * WHEEL ANIMATOR — the imperative side of RouletteWheel.
 *
 * Owns the requestAnimationFrame loop and writes `transform` / data attributes straight onto the SVG
 * elements (no React state per frame). Time comes from performance.now(). It never chooses a number:
 * the winning number is an input, and the "landed" number it reports is re-derived from the angles it
 * actually rendered, so a mismatch would be visible rather than papered over.
 *
 * Lifecycle rules (see RouletteWheel for the React wiring):
 * - `spin(roundId, …)` for a roundId already seen by this animator is ignored.
 * - A new spin while one is running first snaps the running one to its end and settles it.
 * - Reduced motion: nothing turns; the ball is placed in the pocket and the settle fires on the next tick.
 * - Hidden document (background tab): a spin settles immediately instead of waiting on rAF.
 * - After `destroy()` no callback of any kind is invoked.
 */
import type { AnimationSpeed } from '../../../shared/contracts';
import { isRouletteNumber } from '../../../shared/roulette';
import {
  IDLE_DEG_PER_SEC,
  SPIN_DURATION_MS,
  idleRotorAngle,
  nextSpinStart,
  normalizeAngle,
  numberUnderBall,
  planSpin,
  sampleSpin,
  type SpinPlan,
  type SpinStage,
} from './wheelMath';
import { BALL_REST_ANGLE, angleOfPoint, ballRadiusToSvg, polar } from './wheelGeometry';

export interface WheelElements {
  root: SVGSVGElement;
  rotor: SVGGElement;
  ball: SVGGElement;
  highlight: SVGGElement;
}

export type WheelStatus =
  | { kind: 'idle' }
  | { kind: 'spinning' }
  | { kind: 'settled'; number: number }
  | { kind: 'error' };

export type WheelSpinState = 'idle' | 'spinning' | 'settled' | 'error';

export interface WheelAnimatorCallbacks {
  /** Presentation settle of `roundId`; the component dedupes per roundId. */
  onSettled(roundId: string): void;
  /** Coarse status changes (start, settle) — at most a few per spin, never per frame. */
  onStatus(status: WheelStatus): void;
}

/** Injectable environment (defaults resolve the browser globals at call time, so tests can stub them). */
export interface WheelEnv {
  now(): number;
  requestFrame(cb: () => void): number;
  cancelFrame(id: number): void;
  isHidden(): boolean;
  setTimer(cb: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimer(id: ReturnType<typeof setTimeout>): void;
  /** Presentation-only randomness for laps / bounce size. */
  rand(): number;
}

export const browserWheelEnv: WheelEnv = {
  now: () => performance.now(),
  requestFrame: (cb) => requestAnimationFrame(() => cb()),
  cancelFrame: (id) => cancelAnimationFrame(id),
  isHidden: () => typeof document !== 'undefined' && document.hidden === true,
  setTimer: (cb, ms) => setTimeout(cb, ms),
  clearTimer: (id) => clearTimeout(id),
  rand: () => Math.random(),
};

interface ActiveSpin {
  roundId: string;
  plan: SpinPlan;
  /** performance.now() at the plan's t = 0 (moved back when a spin is snapped to its end). */
  startedAt: number;
  settled: boolean;
}

interface Frame {
  rotorAngle: number;
  ballAngle: number;
  ballRelAngle: number;
  ballRadius: number;
  stage: SpinStage | 'idle';
}

/**
 * Fallback for starved rAF without a visibilitychange (occluded window, offscreen iframe): settle anyway
 * this long after the planned end, so the dashboard's reveal never hangs on the animation.
 */
export const WATCHDOG_GRACE_MS = 1000;

/** Fixed precision for every written angle/coordinate (also what data-landed-number is derived from). */
const fmt = (n: number) => n.toFixed(3);

export class WheelAnimator {
  private active: ActiveSpin | null = null;
  /** Pre-first-spin idle: rotor drifts from `rotor` since `at`; the ball waits on the track. */
  private idleBase: { rotor: number; at: number };
  private reduced: boolean;
  private rafId: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  /** The latest spin request carried an invalid number (contract violation upstream). */
  private lastSpinInvalid = false;
  private readonly seen = new Set<string>();
  private readonly onVisibility = () => this.handleVisibility();

  constructor(
    private readonly els: WheelElements,
    private readonly callbacks: WheelAnimatorCallbacks,
    options: { reducedMotion: boolean },
    private readonly env: WheelEnv = browserWheelEnv,
  ) {
    this.reduced = options.reducedMotion;
    this.idleBase = { rotor: 0, at: env.now() };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
    this.setHighlight(null);
    this.render(env.now());
    this.ensureLoop();
  }

  /** Start animating a server-supplied outcome. The number is never chosen or altered here. */
  spin(roundId: string, winningNumber: number, speed: AnimationSpeed): void {
    if (this.destroyed || this.seen.has(roundId)) return;
    this.seen.add(roundId);
    const now = this.env.now();
    this.finishActive(now);

    if (!isRouletteNumber(winningNumber)) {
      // Contract violation upstream: show nothing new and report no settle for an invalid outcome.
      console.error(`RouletteWheel: ignoring spin ${roundId} with invalid winningNumber`, winningNumber);
      this.lastSpinInvalid = true;
      this.render(now);
      this.callbacks.onStatus({ kind: 'error' });
      return;
    }
    this.lastSpinInvalid = false;

    const start = nextSpinStart(this.frame(now));
    const plan = this.reduced
      ? planSpin(start, winningNumber, { durationMs: 0, idleDegPerSec: 0 })
      : planSpin(start, winningNumber, {
          durationMs: SPIN_DURATION_MS[speed] ?? SPIN_DURATION_MS.normal,
          rand: this.env.rand,
        });
    const entry: ActiveSpin = { roundId, plan, startedAt: now, settled: false };
    this.active = entry;
    this.setHighlight(null);
    this.callbacks.onStatus({ kind: 'spinning' });

    if (this.reduced) {
      // Ball goes straight into the pocket; settle on the next tick (no rAF involved).
      this.render(now);
      this.timer = this.env.setTimer(() => {
        this.timer = null;
        if (!this.destroyed && this.active === entry && !entry.settled) this.settle(entry, this.env.now());
      }, 0);
      return;
    }
    if (this.env.isHidden()) {
      this.finishActive(now);
      return;
    }
    this.render(now);
    this.ensureLoop();
    this.armWatchdog(entry);
  }

  setReducedMotion(reduced: boolean): void {
    if (this.destroyed || reduced === this.reduced) return;
    const now = this.env.now();
    this.finishActive(now);
    const frame = this.frame(now);
    this.reduced = reduced;
    const idle = reduced ? 0 : IDLE_DEG_PER_SEC;
    // Re-base the resting state at the current angles with the new drift speed (no visual jump).
    if (this.active) {
      this.active.plan = planSpin(nextSpinStart(frame), this.active.plan.winningNumber, {
        durationMs: 0,
        idleDegPerSec: idle,
      });
      this.active.startedAt = now;
    } else {
      this.idleBase = { rotor: frame.rotorAngle, at: now };
    }
    if (reduced) this.stopLoop();
    this.render(now);
    this.ensureLoop();
  }

  destroy(): void {
    this.destroyed = true;
    this.stopLoop();
    if (this.timer !== null) this.env.clearTimer(this.timer);
    this.timer = null;
    this.clearWatchdog();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private handleVisibility(): void {
    if (this.destroyed) return;
    const now = this.env.now();
    if (this.env.isHidden()) {
      this.finishActive(now);
    } else {
      this.render(now);
      this.ensureLoop();
    }
  }

  /** Snap a running spin to its end state and settle it (once). */
  private finishActive(now: number): void {
    const a = this.active;
    if (!a || a.settled) return;
    if (this.timer !== null) {
      this.env.clearTimer(this.timer);
      this.timer = null;
    }
    if (now - a.startedAt < a.plan.durationMs) a.startedAt = now - a.plan.durationMs;
    this.settle(a, now);
  }

  private armWatchdog(entry: ActiveSpin): void {
    this.clearWatchdog();
    this.watchdog = this.env.setTimer(() => {
      this.watchdog = null;
      if (!this.destroyed && this.active === entry && !entry.settled) this.finishActive(this.env.now());
    }, entry.plan.durationMs + WATCHDOG_GRACE_MS);
  }

  private clearWatchdog(): void {
    if (this.watchdog !== null) this.env.clearTimer(this.watchdog);
    this.watchdog = null;
  }

  private settle(a: ActiveSpin, now: number): void {
    a.settled = true;
    this.clearWatchdog();
    this.setHighlight(a.plan.targetRelAngle);
    this.render(now);
    const landed = this.renderedLandedNumber();
    this.callbacks.onStatus({ kind: 'settled', number: landed });
    this.callbacks.onSettled(a.roundId);
  }

  private frame(now: number): Frame {
    const a = this.active;
    if (a) return sampleSpin(a.plan, now - a.startedAt);
    const rotorAngle = idleRotorAngle(
      this.idleBase.rotor,
      now - this.idleBase.at,
      this.reduced ? 0 : IDLE_DEG_PER_SEC,
    );
    return {
      rotorAngle,
      ballAngle: BALL_REST_ANGLE,
      ballRelAngle: BALL_REST_ANGLE - rotorAngle,
      ballRadius: 0,
      stage: 'idle',
    };
  }

  private spinState(): WheelSpinState {
    if (this.lastSpinInvalid) return 'error';
    if (!this.active) return 'idle';
    return this.active.settled ? 'settled' : 'spinning';
  }

  /** Write one frame to the DOM. */
  private render(now: number): void {
    const f = this.frame(now);
    const { root, rotor, ball } = this.els;
    const rotorDeg = fmt(normalizeAngle(f.rotorAngle));
    const ballDeg = fmt(normalizeAngle(f.ballAngle));
    const r = ballRadiusToSvg(f.ballRadius);
    const p = polar(r, Number(ballDeg));
    rotor.setAttribute('transform', `rotate(${rotorDeg})`);
    ball.setAttribute('transform', `translate(${fmt(p.x)} ${fmt(p.y)})`);
    root.setAttribute('data-rotor-angle', rotorDeg);
    root.setAttribute('data-ball-angle', ballDeg);
    root.setAttribute('data-ball-radius', fmt(r));
    root.setAttribute('data-spin-stage', f.stage);
    const state = this.spinState();
    root.setAttribute('data-spin-state', state);
    root.setAttribute('data-round-id', this.active?.roundId ?? '');
    root.setAttribute('data-landed-number', state === 'settled' ? String(this.renderedLandedNumber()) : '');
  }

  /** The pocket under the ball, derived from the transforms currently written to the DOM. */
  private renderedLandedNumber(): number {
    const rotorDeg = parseRotate(this.els.rotor.getAttribute('transform'));
    const pos = parseTranslate(this.els.ball.getAttribute('transform'));
    return numberUnderBall(rotorDeg, angleOfPoint(pos.x, pos.y));
  }

  private setHighlight(relAngle: number | null): void {
    const h = this.els.highlight;
    if (relAngle === null) {
      h.setAttribute('opacity', '0');
      h.setAttribute('visibility', 'hidden');
      return;
    }
    h.setAttribute('transform', `rotate(${fmt(relAngle)})`);
    h.setAttribute('opacity', '1');
    h.setAttribute('visibility', 'visible');
  }

  private readonly tick = () => {
    this.rafId = null;
    if (this.destroyed) return;
    const now = this.env.now();
    this.render(now);
    const a = this.active;
    if (a && !a.settled && now - a.startedAt >= a.plan.durationMs) this.settle(a, now);
    this.ensureLoop();
  };

  /** Keep a frame requested whenever something can move (a spin, or the idle drift). */
  private ensureLoop(): void {
    if (this.destroyed || this.reduced || this.rafId !== null) return;
    this.rafId = this.env.requestFrame(this.tick);
  }

  private stopLoop(): void {
    if (this.rafId !== null) this.env.cancelFrame(this.rafId);
    this.rafId = null;
  }
}

/** Parse `rotate(θ …)` → θ. */
export function parseRotate(transform: string | null): number {
  const m = /rotate\(\s*(-?[\d.eE+-]+)/.exec(transform ?? '');
  return m ? Number(m[1]) : 0;
}

/** Parse `translate(x y)` / `translate(x, y)` → {x, y}. */
export function parseTranslate(transform: string | null): { x: number; y: number } {
  const m = /translate\(\s*(-?[\d.eE+-]+)[\s,]+(-?[\d.eE+-]+)\s*\)/.exec(transform ?? '');
  return m ? { x: Number(m[1]), y: Number(m[2]) } : { x: 0, y: 0 };
}
