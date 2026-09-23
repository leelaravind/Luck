import { describe, expect, it } from 'vitest';
import { WHEEL_ORDER, wheelIndexOf } from '../../../shared/roulette';
import {
  DROP_START,
  IDLE_DEG_PER_SEC,
  LAUNCH_END,
  POCKET_ANGLE,
  SPIN_DURATION_MS,
  angleDelta,
  nextSpinStart,
  normalizeAngle,
  numberUnderBall,
  planSpin,
  pocketCenterAngle,
  sampleSpin,
  type SpinPlan,
  type SpinStage,
  type SpinStart,
} from './wheelMath';
import { BALL_POCKET_R, BALL_TRACK_R, angleOfPoint, ballRadiusToSvg, polar } from './wheelGeometry';

/** Deterministic PRNG for test fixtures (start states, number sequences, presentation rand). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALL_NUMBERS = Array.from({ length: 37 }, (_, n) => n);
// Animated durations. "instant" is 0 (no spin, covered by the durationMs: 0 tests); a short 400 ms spin
// keeps the short-duration branch of planSpin covered.
const DURATIONS = [SPIN_DURATION_MS.normal, SPIN_DURATION_MS.fast, 400];

function expectLandsOn(plan: SpinPlan, n: number) {
  const end = sampleSpin(plan, plan.durationMs);
  expect(end.stage).toBe('settled');
  expect(numberUnderBall(end.rotorAngle, end.ballAngle)).toBe(n);
  expect(Math.abs(end.ballRelAngle - pocketCenterAngle(wheelIndexOf(n)))).toBeLessThan(1e-9);
  expect(end.ballRelAngle).toBe(pocketCenterAngle(wheelIndexOf(n))); // exact snap
  expect(end.ballAngle).toBe(end.rotorAngle + pocketCenterAngle(wheelIndexOf(n)));
  expect(end.ballRadius).toBe(1);
  return end;
}

describe('angles and pockets', () => {
  it('POCKET_ANGLE is 360/37 and pocket centres step clockwise from 0 at 12 o’clock', () => {
    expect(POCKET_ANGLE).toBe(360 / 37);
    expect(pocketCenterAngle(0)).toBe(0);
    for (let i = 0; i < 37; i++) expect(pocketCenterAngle(i)).toBeCloseTo(i * (360 / 37), 12);
    expect(() => pocketCenterAngle(37)).toThrow(RangeError);
    expect(() => pocketCenterAngle(-1)).toThrow(RangeError);
    expect(() => pocketCenterAngle(1.5)).toThrow(RangeError);
  });

  it('normalizeAngle maps to [0, 360)', () => {
    expect(normalizeAngle(0)).toBe(0);
    expect(normalizeAngle(360)).toBe(0);
    expect(normalizeAngle(720.5)).toBeCloseTo(0.5, 12);
    expect(normalizeAngle(-90)).toBe(270);
    expect(normalizeAngle(-1e-15)).toBeGreaterThanOrEqual(0);
    expect(normalizeAngle(-1e-15)).toBeLessThan(360);
    expect(angleDelta(10, 350)).toBeCloseTo(20, 12);
    expect(angleDelta(350, 10)).toBeCloseTo(-20, 12);
  });

  it('numberUnderBall picks the pocket whose sector contains the ball, for any rotor angle', () => {
    const rotorAngles = [0, 123.456, -500.25, 7200.5, 359.999];
    const offsets = [0, POCKET_ANGLE / 2 - 1e-6, -(POCKET_ANGLE / 2 - 1e-6), 1.3, -2.7];
    for (const rotor of rotorAngles) {
      WHEEL_ORDER.forEach((n, i) => {
        for (const off of offsets) {
          expect(numberUnderBall(rotor, rotor + pocketCenterAngle(i) + off)).toBe(n);
          // Same physical position expressed with extra full turns.
          expect(numberUnderBall(rotor + 720, rotor + pocketCenterAngle(i) + off - 1080)).toBe(n);
        }
      });
    }
  });

  it('polar / angleOfPoint are inverse and the ball radius maps track → pocket inward', () => {
    for (const deg of [0, 45, 90, 179.5, 270, 359]) {
      const p = polar(50, deg);
      expect(angleOfPoint(p.x, p.y)).toBeCloseTo(deg, 9);
    }
    expect(polar(10, 0).y).toBeCloseTo(-10, 12); // 12 o'clock is up (SVG y down)
    expect(polar(10, 90).x).toBeCloseTo(10, 12); // clockwise: 90° is 3 o'clock
    expect(ballRadiusToSvg(0)).toBe(BALL_TRACK_R);
    expect(ballRadiusToSvg(1)).toBe(BALL_POCKET_R);
    expect(BALL_POCKET_R).toBeLessThan(BALL_TRACK_R);
  });
});

describe('planSpin / sampleSpin landing', () => {
  const rand = mulberry32(7);
  const randomStarts: SpinStart[] = Array.from({ length: 4 }, () => ({
    rotorAngle: (rand() - 0.5) * 5000,
    ballRelAngle: (rand() - 0.5) * 5000,
    ballRadius: rand(),
  }));

  it('lands exactly on every number from 0°, random, and previous-end start states at every speed', () => {
    for (const durationMs of DURATIONS) {
      for (const n of ALL_NUMBERS) {
        const starts: SpinStart[] = [{ rotorAngle: 0, ballRelAngle: 0 }, ...randomStarts];
        // "previous end": the settled state of a spin to another number, sampled after some idle drift.
        const prevPlan = planSpin({ rotorAngle: 33, ballRelAngle: 250 }, (n + 11) % 37, {
          durationMs,
          rand: mulberry32(n),
        });
        starts.push(nextSpinStart(sampleSpin(prevPlan, durationMs + 2345)));
        for (const start of starts) {
          const plan = planSpin(start, n, { durationMs, rand: mulberry32(n * 31 + 1) });
          expectLandsOn(plan, n);
          // Continuity: just before the end psi is already (mod 360) on the pocket centre.
          const almost = sampleSpin(plan, durationMs - 1e-3);
          expect(Math.abs(angleDelta(almost.ballRelAngle, pocketCenterAngle(wheelIndexOf(n))))).toBeLessThan(1e-3);
          expect(numberUnderBall(almost.rotorAngle, almost.ballAngle)).toBe(n);
        }
      }
    }
  });

  it('a chain of 100 consecutive spins (fixed rand) always lands correctly and starts where the last ended', () => {
    const presentationRand = mulberry32(42);
    const fixtureNumbers = mulberry32(2024); // test fixture sequence, not an outcome generator
    let start: SpinStart = { rotorAngle: 0, ballRelAngle: 32, ballRadius: 0 };
    for (let k = 0; k < 100; k++) {
      const n = Math.floor(fixtureNumbers() * 37);
      const durationMs = DURATIONS[k % 3]!;
      const plan = planSpin(start, n, { durationMs, rand: presentationRand });
      // Starts from the previous rendered end state (rotor incl. idle drift, psi = previous pocket).
      expect(Math.abs(angleDelta(sampleSpin(plan, 0).rotorAngle, start.rotorAngle))).toBeLessThan(1e-9);
      expect(Math.abs(angleDelta(sampleSpin(plan, 0).ballRelAngle, start.ballRelAngle))).toBeLessThan(1e-9);
      expectLandsOn(plan, n);
      const idleGapMs = 500 + Math.floor(presentationRand() * 4000);
      const rest = sampleSpin(plan, durationMs + idleGapMs);
      expect(numberUnderBall(rest.rotorAngle, rest.ballAngle)).toBe(n); // still attached while drifting
      start = nextSpinStart(rest);
      expect(start.ballRelAngle).toBe(pocketCenterAngle(wheelIndexOf(n)));
    }
  });

  it('presentation randomness never changes the landing pocket (even for degenerate rand values)', () => {
    const degenerate = [() => 0, () => 0.999999, () => 1, () => Number.NaN, () => -3];
    for (const n of [0, 5, 17, 26, 32, 36]) {
      for (const r of degenerate) expectLandsOn(planSpin({ rotorAngle: 10, ballRelAngle: 200 }, n, { durationMs: 6500, rand: r }), n);
    }
  });

  it('normal speed uses at least 4 relative laps', () => {
    for (const n of ALL_NUMBERS) {
      const plan = planSpin({ rotorAngle: 0, ballRelAngle: 0 }, n, { durationMs: SPIN_DURATION_MS.normal, rand: mulberry32(n) });
      expect(plan.laps).toBeGreaterThanOrEqual(4);
      expect(plan.relTravel).toBeGreaterThanOrEqual(4 * 360);
    }
  });

  it('rejects invalid outcomes and durations instead of inventing a number', () => {
    const s = { rotorAngle: 0, ballRelAngle: 0 };
    for (const bad of [-1, 37, 1.5, Number.NaN]) expect(() => planSpin(s, bad, { durationMs: 1000 })).toThrow(RangeError);
    expect(() => planSpin(s, 3, { durationMs: -1 })).toThrow(RangeError);
    expect(() => planSpin({ rotorAngle: Number.NaN, ballRelAngle: 0 }, 3, { durationMs: 10 })).toThrow(RangeError);
  });

  it('durationMs 0 (reduced motion) is settled at t = 0 with the rotor untouched', () => {
    const plan = planSpin({ rotorAngle: 400, ballRelAngle: 99, ballRadius: 0 }, 17, { durationMs: 0, idleDegPerSec: 0 });
    const s = sampleSpin(plan, 0);
    expect(s.stage).toBe('settled');
    expect(s.rotorAngle).toBe(40);
    expect(numberUnderBall(s.rotorAngle, s.ballAngle)).toBe(17);
    expect(sampleSpin(plan, 60_000).rotorAngle).toBe(40); // no drift
  });
});

describe('kinematics', () => {
  const D = SPIN_DURATION_MS.normal;

  it('early orbit: rotor turns clockwise while the ball moves counter-clockwise (absolute frame)', () => {
    for (const durationMs of DURATIONS) {
      for (const n of [0, 9, 17, 26, 32]) {
        const plan = planSpin({ rotorAngle: 12, ballRelAngle: 300 }, n, { durationMs, rand: mulberry32(n + 3) });
        const h = durationMs / 2000;
        for (let u = 0.02; u <= 0.5; u += 0.02) {
          const a = sampleSpin(plan, u * durationMs);
          const b = sampleSpin(plan, u * durationMs + h);
          const rotorVel = b.rotorAngle - a.rotorAngle;
          const ballVel = b.ballAngle - a.ballAngle;
          expect(rotorVel).toBeGreaterThan(0);
          expect(ballVel).toBeLessThan(0);
          expect(Math.sign(ballVel)).toBe(-Math.sign(rotorVel));
        }
      }
    }
  });

  it('rotor never turns backwards, and ends the spin with zero relative ball velocity', () => {
    const plan = planSpin({ rotorAngle: 0, ballRelAngle: 0 }, 21, { durationMs: D, rand: mulberry32(1) });
    let prev = sampleSpin(plan, 0).rotorAngle;
    for (let t = 10; t <= D + 5000; t += 10) {
      const r = sampleSpin(plan, t).rotorAngle;
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
    const a = sampleSpin(plan, D - 2);
    const b = sampleSpin(plan, D - 1);
    expect(Math.abs(b.ballRelAngle - a.ballRelAngle)).toBeLessThan(1e-4); // carried by the rotor at the end
  });

  it('after settle the ball stays attached to the pocket while the rotor idles clockwise', () => {
    const plan = planSpin({ rotorAngle: 77, ballRelAngle: 5 }, 8, { durationMs: D, rand: mulberry32(9) });
    const centre = pocketCenterAngle(wheelIndexOf(8));
    const atSettle = sampleSpin(plan, D);
    for (const extra of [0, 16, 1000, 30_000]) {
      const s = sampleSpin(plan, D + extra);
      expect(s.stage).toBe('settled');
      expect(s.ballAngle).toBe(s.rotorAngle + centre);
      expect(s.rotorAngle - atSettle.rotorAngle).toBeCloseTo((IDLE_DEG_PER_SEC * extra) / 1000, 9);
      expect(numberUnderBall(s.rotorAngle, s.ballAngle)).toBe(8);
    }
  });

  it('ball radius: lifted to the track, rolls on it, spirals in with small damped bounces, ends in the pocket', () => {
    const plan = planSpin({ rotorAngle: 0, ballRelAngle: 100, ballRadius: 1 }, 30, { durationMs: D, rand: mulberry32(5) });
    const at = (u: number) => sampleSpin(plan, u * D).ballRadius;
    expect(at(0)).toBe(1); // starts in the previous pocket
    for (let u = LAUNCH_END; u < DROP_START; u += 0.01) expect(at(u)).toBe(0); // on the outer track
    // Spiral: SVG radius strictly shrinks from track to pocket in the first part of the drop.
    const spiral: number[] = [];
    for (let u = DROP_START; u <= DROP_START + 0.4 * (1 - DROP_START); u += 0.005) spiral.push(ballRadiusToSvg(at(u)));
    for (let i = 1; i < spiral.length; i++) expect(spiral[i]!).toBeLessThanOrEqual(spiral[i - 1]! + 1e-12);
    expect(spiral[0]).toBeCloseTo(BALL_TRACK_R, 6);
    // Bounces: bounded, damped, and actually present.
    let minAfterLanding = 1;
    for (let u = DROP_START + 0.4 * (1 - DROP_START); u < 1; u += 0.001) {
      const r = at(u);
      expect(r).toBeGreaterThanOrEqual(1 - plan.bounceAmp - 1e-12);
      expect(r).toBeLessThanOrEqual(1);
      minAfterLanding = Math.min(minAfterLanding, r);
    }
    expect(minAfterLanding).toBeLessThan(0.97);
    expect(sampleSpin(plan, D).ballRadius).toBe(1);
    expect(ballRadiusToSvg(sampleSpin(plan, D).ballRadius)).toBe(BALL_POCKET_R);
  });

  it('stages progress launch → orbit → drop → settled without going back', () => {
    const order: SpinStage[] = ['launch', 'orbit', 'drop', 'settled'];
    for (const durationMs of DURATIONS) {
      const plan = planSpin({ rotorAngle: 0, ballRelAngle: 0 }, 14, { durationMs, rand: mulberry32(2) });
      const seen = new Set<SpinStage>();
      let last = 0;
      for (let t = 0; t <= durationMs + 200; t += durationMs / 400) {
        const idx = order.indexOf(sampleSpin(plan, t).stage);
        expect(idx).toBeGreaterThanOrEqual(last);
        last = idx;
        seen.add(order[idx]!);
      }
      expect([...seen]).toEqual(order);
    }
  });

  it('non-finite elapsed values are handled without NaN angles', () => {
    const plan = planSpin({ rotorAngle: 0, ballRelAngle: 0 }, 3, { durationMs: 1000, rand: () => 0.5 });
    expect(sampleSpin(plan, Number.NaN).stage).toBe('launch');
    const inf = sampleSpin(plan, Number.POSITIVE_INFINITY);
    expect(inf.stage).toBe('settled');
    expect(Number.isFinite(inf.rotorAngle)).toBe(true);
    expect(numberUnderBall(inf.rotorAngle, inf.ballAngle)).toBe(3);
  });
});

describe('pocket sequence against an independent, hand-typed oracle (reviewer D8)', () => {
  // Typed from a physical European wheel, NOT imported from src/shared/roulette.ts.
  const EUROPEAN_ORDER = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26];
  const REDS = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
  it('WHEEL_ORDER and colours match the physical wheel', async () => {
    const { WHEEL_ORDER, colorOf } = await import('../../../shared/roulette');
    expect([...WHEEL_ORDER]).toEqual(EUROPEAN_ORDER);
    for (let n = 0; n <= 36; n++) expect(colorOf(n)).toBe(n === 0 ? 'green' : REDS.includes(n) ? 'red' : 'black');
    // Colours alternate red/black around the wheel after zero.
    for (let i = 1; i < 36; i++) expect(colorOf(EUROPEAN_ORDER[i]!)).not.toBe(colorOf(EUROPEAN_ORDER[i + 1]!));
  });
});
