// @vitest-environment jsdom
/**
 * RouletteWheel component tests. requestAnimationFrame and performance.now() are replaced by a manual
 * frame queue and a controllable clock, so every frame is driven explicitly by the test.
 * Landing is checked from the RENDERED transforms (parsed here independently of the component's code).
 */
import { StrictMode } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WHEEL_ORDER, colorOf, wheelIndexOf } from '../../../shared/roulette';
import type { AnimationSpeed } from '../../../shared/contracts';
import type { RouletteWheelProps, WheelSpin } from '../../contracts';
import { RouletteWheel } from './RouletteWheel';
import { SPIN_DURATION_MS, angleDelta, numberUnderBall, pocketCenterAngle } from './wheelMath';
import { BALL_POCKET_R, BALL_TRACK_R, WHEEL_R } from './wheelGeometry';

// ── fake clock + rAF ────────────────────────────────────────────────────────
let clock = 0;
let hidden = false;
let nextFrameId = 1;
const frames = new Map<number, FrameRequestCallback>();

beforeEach(() => {
  clock = 10_000;
  hidden = false;
  frames.clear();
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextFrameId++;
    frames.set(id, cb);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id);
  });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  // Deterministic presentation randomness (laps / bounce size); landing must not depend on it anyway.
  let seed = 12345;
  vi.spyOn(Math, 'random').mockImplementation(() => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (document as unknown as { hidden?: boolean }).hidden;
});

/** Advance the clock in `step` ms increments, running queued animation frames each step. */
function advance(ms: number, step = 16) {
  act(() => {
    const end = clock + ms;
    while (clock < end) {
      clock = Math.min(end, clock + step);
      const cbs = [...frames.values()];
      frames.clear();
      for (const cb of cbs) cb(clock);
    }
  });
}

async function nextTick() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

// ── DOM readers (independent of the component's own parsing helpers) ───────
function rotateOf(el: Element | null): number {
  const m = /rotate\(([-\d.e]+)/.exec(el?.getAttribute('transform') ?? '');
  if (!m) throw new Error(`no rotate() on ${el?.outerHTML.slice(0, 80)}`);
  return Number(m[1]);
}

function translateOf(el: Element | null): { x: number; y: number } {
  const m = /translate\(([-\d.e]+)[ ,]+([-\d.e]+)\)/.exec(el?.getAttribute('transform') ?? '');
  if (!m) throw new Error('no translate() on ball');
  return { x: Number(m[1]), y: Number(m[2]) };
}

function read(container: HTMLElement) {
  const svg = container.querySelector('svg[role="img"]') as SVGSVGElement;
  const rotor = svg.querySelector('[data-layer="rotor"]');
  const ball = svg.querySelector('[data-layer="ball"]');
  const highlight = svg.querySelector('[data-layer="highlight"]');
  const rotorDeg = rotateOf(rotor);
  const p = translateOf(ball);
  let ballDeg = (Math.atan2(p.x, -p.y) * 180) / Math.PI;
  if (ballDeg < 0) ballDeg += 360;
  return {
    svg,
    rotorDeg,
    ballDeg,
    ballR: Math.hypot(p.x, p.y),
    landedFromTransforms: numberUnderBall(rotorDeg, ballDeg),
    landedAttr: svg.getAttribute('data-landed-number'),
    state: svg.getAttribute('data-spin-state'),
    label: svg.getAttribute('aria-label'),
    highlightVisible: highlight?.getAttribute('opacity') === '1' && highlight?.getAttribute('visibility') === 'visible',
    highlightDeg: highlight?.getAttribute('transform') ? rotateOf(highlight) : null,
  };
}

function setup(initial: Partial<RouletteWheelProps> = {}, strict = false) {
  const onSettled = vi.fn<(roundId: string) => void>();
  let props: RouletteWheelProps = { spin: null, speed: 'normal', reducedMotion: false, onSettled, ...initial };
  const el = () => <RouletteWheel {...props} />;
  const utils = render(strict ? <StrictMode>{el()}</StrictMode> : el());
  const update = (next: Partial<RouletteWheelProps>) => {
    props = { ...props, ...next };
    utils.rerender(strict ? <StrictMode>{el()}</StrictMode> : el());
  };
  return { ...utils, onSettled, update };
}

const spinOf = (roundId: string, winningNumber: number): WheelSpin => ({ roundId, winningNumber });

// ── tests ───────────────────────────────────────────────────────────────────
describe('RouletteWheel structure', () => {
  it('draws separate housing / rotor / highlight / ball layers in a scalable viewBox', () => {
    const { container } = setup();
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toMatch(/^-?\d+ -?\d+ \d+ \d+$/);
    expect(svg.hasAttribute('width')).toBe(false);
    expect(svg.hasAttribute('height')).toBe(false);
    const housing = svg.querySelector('[data-layer="housing"]')!;
    const rotor = svg.querySelector('[data-layer="rotor"]')!;
    const ball = svg.querySelector('[data-layer="ball"]')!;
    const highlight = svg.querySelector('[data-layer="highlight"]')!;
    expect(housing.querySelectorAll('[data-deflector]')).toHaveLength(8);
    expect(housing.contains(rotor)).toBe(false);
    expect(rotor.contains(highlight)).toBe(true); // highlight turns with the rotor
    expect(rotor.contains(ball)).toBe(false); // ball is its own element
    expect(housing.contains(ball)).toBe(false);
    expect(read(container).highlightVisible).toBe(false);
    expect(read(container).state).toBe('idle');
    expect(read(container).landedAttr).toBe('');
    expect(read(container).label).toBe('Roulette wheel. No result yet');
    expect(read(container).ballR).toBeCloseTo(BALL_TRACK_R, 2); // waiting on the track
  });

  it('places all 37 wedges and labels in WHEEL_ORDER at pocketCenterAngle(wheelIndexOf(n)) with correct colours', () => {
    const { container } = setup();
    const groups = [...container.querySelectorAll('[data-layer="rotor"] [data-pocket]')];
    expect(groups.map((g) => Number(g.getAttribute('data-pocket')))).toEqual([...WHEEL_ORDER]);
    for (let n = 0; n <= 36; n++) {
      const g = container.querySelector(`[data-pocket="${n}"]`)!;
      expect(Math.abs(rotateOf(g) - pocketCenterAngle(wheelIndexOf(n)))).toBeLessThan(1e-9);
      const text = g.querySelector('text')!;
      expect(text.textContent).toBe(String(n));
      expect(Number(text.getAttribute('x'))).toBe(0);
      expect(Number(text.getAttribute('y'))).toBe(-WHEEL_R.label); // on the wedge's centre line
      expect(text.hasAttribute('transform')).toBe(false); // upright in pocket coordinates
      const path = g.querySelector('path')!;
      expect(path.getAttribute('data-color')).toBe(colorOf(n));
      expect(path.getAttribute('fill')).toBe(`var(--color-pocket-${colorOf(n)})`);
    }
  });
});

describe('RouletteWheel landing', () => {
  it('for all 37 numbers (consecutive spins) the rendered angles land in the supplied pocket; onSettled once each', () => {
    const { container, onSettled, update } = setup();
    const order = [...WHEEL_ORDER].reverse(); // every number, in an order unrelated to 0..36
    order.forEach((n, k) => {
      const roundId = `round-${k}-${n}`;
      update({ spin: spinOf(roundId, n) });
      advance(1500, 50);
      const mid = read(container);
      expect(mid.state).toBe('spinning');
      expect(mid.landedAttr).toBe('');
      expect(mid.highlightVisible).toBe(false);
      expect(mid.label).toBe('Roulette wheel. Spinning');
      expect(onSettled).toHaveBeenCalledTimes(k);

      advance(SPIN_DURATION_MS.normal - 1500 + 50, 50);
      const end = read(container);
      expect(end.state).toBe('settled');
      expect(end.landedFromTransforms).toBe(n);
      expect(end.landedAttr).toBe(String(n));
      expect(Math.abs(end.ballR - BALL_POCKET_R)).toBeLessThan(0.01);
      expect(end.highlightVisible).toBe(true);
      expect(Math.abs(angleDelta(end.highlightDeg!, pocketCenterAngle(wheelIndexOf(n))))).toBeLessThan(1e-3);
      expect(end.label).toBe(`Roulette wheel. Last result: ${n} ${colorOf(n)}`);
      expect(onSettled).toHaveBeenCalledTimes(k + 1);
      expect(onSettled).toHaveBeenLastCalledWith(roundId);
    });
    expect(onSettled).toHaveBeenCalledTimes(37);
  });

  it.each<[AnimationSpeed, number]>([
    ['normal', 6500],
    ['fast', 3200],
    ['instant', 400],
  ])('%s speed settles after about %i ms on the right pocket', (speed, duration) => {
    const { container, onSettled, update } = setup({ speed });
    update({ spin: spinOf(`r-${speed}`, 17) });
    advance(duration - 40, 16);
    expect(onSettled).not.toHaveBeenCalled();
    advance(80, 16);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(read(container).landedFromTransforms).toBe(17);
    expect(read(container).label).toBe('Roulette wheel. Last result: 17 black');
  });

  it('renders rotor clockwise and ball counter-clockwise early in the spin', () => {
    const { container, update } = setup();
    update({ spin: spinOf('dir', 5) });
    advance(400, 16);
    const a = read(container);
    advance(16, 16);
    const b = read(container);
    expect(angleDelta(b.rotorDeg, a.rotorDeg)).toBeGreaterThan(0);
    expect(angleDelta(b.ballDeg, a.ballDeg)).toBeLessThan(0);
  });

  it('keeps the ball attached to the pocket during the idle drift', () => {
    const { container, onSettled, update } = setup();
    update({ spin: spinOf('idle', 26) });
    advance(SPIN_DURATION_MS.normal + 20, 20);
    const settled = read(container);
    advance(5000, 100);
    const later = read(container);
    expect(angleDelta(later.rotorDeg, settled.rotorDeg)).toBeGreaterThan(0); // rotor still drifting
    expect(later.landedFromTransforms).toBe(26);
    expect(later.landedAttr).toBe('26');
    expect(onSettled).toHaveBeenCalledTimes(1);
  });
});

describe('RouletteWheel settle bookkeeping', () => {
  it('re-rendering the same roundId (new object, new callback) does not animate or settle again', () => {
    const { container, onSettled, update } = setup();
    update({ spin: spinOf('same', 11) });
    advance(SPIN_DURATION_MS.normal + 50, 50);
    expect(onSettled).toHaveBeenCalledTimes(1);
    const before = read(container);
    const onSettled2 = vi.fn();
    update({ spin: spinOf('same', 11), onSettled: onSettled2 });
    update({ spin: { roundId: 'same', winningNumber: 11 } });
    advance(SPIN_DURATION_MS.normal + 50, 50);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled2).not.toHaveBeenCalled();
    expect(read(container).state).toBe('settled');
    expect(read(container).landedFromTransforms).toBe(before.landedFromTransforms);
  });

  it('a new roundId mid-spin settles the previous one once (snapped), then the new one once', () => {
    const { container, onSettled, update } = setup();
    update({ spin: spinOf('a', 3) });
    advance(2000, 16);
    expect(onSettled).not.toHaveBeenCalled();
    update({ spin: spinOf('b', 36) });
    expect(onSettled.mock.calls).toEqual([['a']]); // immediately, without waiting for frames
    expect(read(container).state).toBe('spinning');
    advance(SPIN_DURATION_MS.normal + 50, 50);
    expect(onSettled.mock.calls).toEqual([['a'], ['b']]);
    expect(read(container).landedFromTransforms).toBe(36);
    advance(10_000, 100);
    expect(onSettled).toHaveBeenCalledTimes(2);
  });

  it('reduced motion: no rotation, ball placed in the pocket, highlight shown, settles on the next tick', async () => {
    const { container, onSettled, update } = setup({ reducedMotion: true });
    expect(frames.size).toBe(0); // no animation loop at all
    const before = read(container);
    update({ spin: spinOf('rm', 0) });
    expect(frames.size).toBe(0);
    const placed = read(container);
    expect(placed.rotorDeg).toBe(before.rotorDeg); // rotor did not move
    expect(placed.landedFromTransforms).toBe(0);
    expect(Math.abs(placed.ballR - BALL_POCKET_R)).toBeLessThan(0.01);
    expect(onSettled).not.toHaveBeenCalled();
    await nextTick();
    expect(onSettled.mock.calls).toEqual([['rm']]);
    const after = read(container);
    expect(after.state).toBe('settled');
    expect(after.landedAttr).toBe('0');
    expect(after.highlightVisible).toBe(true);
    expect(after.label).toBe('Roulette wheel. Last result: 0 green');
    clock += 60_000;
    await nextTick();
    expect(read(container).rotorDeg).toBe(before.rotorDeg); // no idle drift either
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('turning reduced motion on mid-spin settles the running spin immediately, once', () => {
    const { container, onSettled, update } = setup();
    update({ spin: spinOf('mid-rm', 19) });
    advance(1000, 16);
    update({ reducedMotion: true });
    expect(onSettled.mock.calls).toEqual([['mid-rm']]);
    expect(read(container).landedFromTransforms).toBe(19);
    expect(frames.size).toBe(0);
  });

  it('document.hidden when a spin starts: settles immediately without any animation frame', () => {
    const { container, onSettled, update } = setup();
    hidden = true;
    update({ spin: spinOf('bg', 13) });
    expect(onSettled.mock.calls).toEqual([['bg']]);
    expect(read(container).landedFromTransforms).toBe(13);
    expect(read(container).landedAttr).toBe('13');
  });

  it('tab hidden during a spin: settles immediately on visibilitychange, and only once', () => {
    const { container, onSettled, update } = setup();
    update({ spin: spinOf('bg2', 29) });
    advance(1200, 16);
    hidden = true;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(onSettled.mock.calls).toEqual([['bg2']]);
    expect(read(container).landedFromTransforms).toBe(29);
    hidden = false;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    advance(SPIN_DURATION_MS.normal, 50);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(read(container).landedFromTransforms).toBe(29);
  });

  it('unmount mid-spin: frames cancelled, listeners removed, no callback ever', async () => {
    const { onSettled, update, unmount } = setup();
    update({ spin: spinOf('gone', 7) });
    advance(1000, 16);
    unmount();
    expect(frames.size).toBe(0);
    advance(SPIN_DURATION_MS.normal + 100, 50);
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    await nextTick();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('unmount before the reduced-motion tick: no callback', async () => {
    const { onSettled, update, unmount } = setup({ reducedMotion: true });
    update({ spin: spinOf('gone-rm', 7) });
    unmount();
    await nextTick();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('StrictMode double effects still settle exactly once', () => {
    const { container, onSettled, update } = setup({}, true);
    update({ spin: spinOf('strict', 32) });
    advance(SPIN_DURATION_MS.normal + 50, 50);
    expect(onSettled.mock.calls).toEqual([['strict']]);
    expect(read(container).landedFromTransforms).toBe(32);
  });

  it('an invalid winningNumber is not animated, not settled and not replaced by another number', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container, onSettled, update } = setup();
    update({ spin: spinOf('bad', 37) });
    advance(SPIN_DURATION_MS.normal + 50, 50);
    expect(onSettled).not.toHaveBeenCalled();
    expect(read(container).state).toBe('error');
    expect(read(container).landedAttr).toBe('');
    expect(err).toHaveBeenCalled();
  });
});

describe('resting result after reload / session switch', () => {
  it('shows the last revealed number in its pocket without animating or calling onSettled', async () => {
    const { render, act } = await import('@testing-library/react');
    const { RouletteWheel } = await import('./RouletteWheel');
    const onSettled = vi.fn();
    for (const n of [0, 17, 34]) {
      const { container, unmount } = render(
        <RouletteWheel spin={null} speed="normal" reducedMotion={false} onSettled={onSettled} restingNumber={n} />,
      );
      await act(async () => {});
      const svg = container.querySelector('svg')!;
      expect(svg.getAttribute('data-spin-state')).toBe('settled');
      expect(svg.getAttribute('data-landed-number')).toBe(String(n));
      expect(svg.getAttribute('aria-label')).toContain(`Last result: ${n}`);
      unmount();
    }
    expect(onSettled).not.toHaveBeenCalled();
  });
});
