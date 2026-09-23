// @vitest-environment jsdom
/**
 * WheelAnimator with a fully injected environment (clock, frames, timers, visibility, rand):
 * covers paths the component test cannot reach through browser globals, e.g. rAF starvation.
 */
import { describe, expect, it } from 'vitest';
import {
  WATCHDOG_GRACE_MS,
  WheelAnimator,
  parseRotate,
  parseTranslate,
  type WheelEnv,
  type WheelStatus,
} from './wheelAnimator';
import { SPIN_DURATION_MS, numberUnderBall } from './wheelMath';
import { angleOfPoint } from './wheelGeometry';

const SVG_NS = 'http://www.w3.org/2000/svg';

function makeHarness(opts: { reducedMotion?: boolean } = {}) {
  let now = 0;
  let hidden = false;
  let nextId = 1;
  let randCalls = 0;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, { at: number; cb: () => void }>();
  const env: WheelEnv = {
    now: () => now,
    requestFrame: (cb) => {
      frames.set(nextId, cb);
      return nextId++;
    },
    cancelFrame: (id) => {
      frames.delete(id);
    },
    isHidden: () => hidden,
    setTimer: (cb, ms) => {
      timers.set(nextId, { at: now + ms, cb });
      return nextId++ as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: (id) => {
      timers.delete(id as unknown as number);
    },
    rand: () => {
      randCalls++;
      return 0.37;
    },
  };
  const root = document.createElementNS(SVG_NS, 'svg');
  const rotor = document.createElementNS(SVG_NS, 'g');
  const ball = document.createElementNS(SVG_NS, 'g');
  const highlight = document.createElementNS(SVG_NS, 'g');
  root.append(rotor, ball);
  rotor.append(highlight);
  const settled: string[] = [];
  const statuses: WheelStatus[] = [];
  const animator = new WheelAnimator(
    { root, rotor, ball, highlight },
    { onSettled: (id) => settled.push(id), onStatus: (s) => statuses.push(s) },
    { reducedMotion: opts.reducedMotion ?? false },
    env,
  );
  return {
    animator,
    root,
    settled,
    statuses,
    frames,
    timers,
    get randCalls() {
      return randCalls;
    },
    setHidden(h: boolean) {
      hidden = h;
    },
    /** Advance time; run frames only if `runFrames`, and due timers always. */
    advance(ms: number, runFrames: boolean, step = 16) {
      const end = now + ms;
      while (now < end) {
        now = Math.min(end, now + step);
        if (runFrames) {
          const cbs = [...frames.values()];
          frames.clear();
          cbs.forEach((cb) => cb());
        }
        for (const [id, t] of [...timers]) {
          if (t.at <= now) {
            timers.delete(id);
            t.cb();
          }
        }
      }
    },
    landed() {
      const p = parseTranslate(ball.getAttribute('transform'));
      return numberUnderBall(parseRotate(rotor.getAttribute('transform')), angleOfPoint(p.x, p.y));
    },
  };
}

describe('WheelAnimator', () => {
  it('settles via the watchdog when animation frames are starved (no visibilitychange)', () => {
    const h = makeHarness();
    h.animator.spin('starved', 22, 'normal');
    h.advance(SPIN_DURATION_MS.normal + WATCHDOG_GRACE_MS - 20, false);
    expect(h.settled).toEqual([]);
    h.advance(40, false);
    expect(h.settled).toEqual(['starved']);
    expect(h.landed()).toBe(22);
    expect(h.root.getAttribute('data-landed-number')).toBe('22');
    h.advance(20_000, true);
    expect(h.settled).toEqual(['starved']);
  });

  it('a normal settle disarms the watchdog (no duplicate settle, no stray timer)', () => {
    const h = makeHarness();
    h.animator.spin('ok', 4, 'fast');
    h.advance(SPIN_DURATION_MS.fast + 50, true);
    expect(h.settled).toEqual(['ok']);
    expect(h.timers.size).toBe(0);
    h.advance(10_000, true);
    expect(h.settled).toEqual(['ok']);
  });

  it('uses the injected presentation rand, and ignores a repeated roundId', () => {
    const h = makeHarness();
    h.animator.spin('r1', 35, 'normal');
    expect(h.randCalls).toBeGreaterThan(0);
    h.animator.spin('r1', 35, 'normal');
    h.advance(SPIN_DURATION_MS.normal + 50, true);
    expect(h.settled).toEqual(['r1']);
    expect(h.statuses.filter((s) => s.kind === 'spinning')).toHaveLength(1);
    expect(h.statuses.at(-1)).toEqual({ kind: 'settled', number: 35 });
  });

  it('destroy() cancels frames and timers and silences every callback', () => {
    const h = makeHarness();
    h.animator.spin('d', 1, 'normal');
    h.advance(500, true);
    h.animator.destroy();
    expect(h.frames.size).toBe(0);
    expect(h.timers.size).toBe(0);
    h.setHidden(true);
    document.dispatchEvent(new Event('visibilitychange'));
    h.animator.spin('after', 2, 'normal');
    h.animator.setReducedMotion(true);
    h.advance(20_000, true);
    expect(h.settled).toEqual([]);
  });

  it('reduced motion: never requests a frame; settle arrives from the next-tick timer', () => {
    const h = makeHarness({ reducedMotion: true });
    expect(h.frames.size).toBe(0);
    h.animator.spin('rm', 10, 'normal');
    expect(h.frames.size).toBe(0);
    expect(h.settled).toEqual([]);
    h.advance(1, false, 1);
    expect(h.settled).toEqual(['rm']);
    expect(h.landed()).toBe(10);
  });

  it('parses the transforms it writes', () => {
    expect(parseRotate('rotate(123.456)')).toBe(123.456);
    expect(parseRotate('rotate(-5e-3)')).toBe(-0.005);
    expect(parseTranslate('translate(1.5 -2.25)')).toEqual({ x: 1.5, y: -2.25 });
    expect(parseTranslate('translate(-3, 4)')).toEqual({ x: -3, y: 4 });
  });
});
