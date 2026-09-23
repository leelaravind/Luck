// @vitest-environment jsdom
// A live spin always takes priority over restingNumber (adapted from the A11 reviewer's closure check).
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RouletteWheel } from './RouletteWheel';

let clock = 0;
let nextFrameId = 1;
const frames = new Map<number, FrameRequestCallback>();
beforeEach(() => {
  clock = 10_000;
  frames.clear();
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { const id = nextFrameId++; frames.set(id, cb); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function advance(ms: number, step = 16) {
  act(() => {
    const end = clock + ms;
    while (clock < end) { clock = Math.min(end, clock + step); const cbs = [...frames.values()]; frames.clear(); for (const cb of cbs) cb(clock); }
  });
}
const svgOf = (c: HTMLElement) => c.querySelector('svg')!;

describe('RouletteWheel: live spin priority over restingNumber', () => {
  it('spin prop present + restingNumber: animates the spin, never rests, onSettled once for the spin', async () => {
    const onSettled = vi.fn();
    const { container } = render(
      <RouletteWheel spin={{ roundId: 'r1', winningNumber: 17 }} speed="normal" reducedMotion={false} onSettled={onSettled} restingNumber={5} />,
    );
    await act(async () => {});
    expect(svgOf(container).getAttribute('data-spin-state')).toBe('spinning');
    advance(20_000);
    expect(svgOf(container).getAttribute('data-spin-state')).toBe('settled');
    expect(svgOf(container).getAttribute('data-landed-number')).toBe('17');
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith('r1');
  });

  it('rest first, then a live spin arrives: spin animates and lands on its own number; restingNumber changes mid-spin are ignored', async () => {
    const onSettled = vi.fn();
    const { container, rerender } = render(
      <RouletteWheel spin={null} speed="normal" reducedMotion={false} onSettled={onSettled} restingNumber={5} />,
    );
    await act(async () => {});
    expect(svgOf(container).getAttribute('data-landed-number')).toBe('5');
    rerender(<RouletteWheel spin={{ roundId: 'r2', winningNumber: 26 }} speed="normal" reducedMotion={false} onSettled={onSettled} restingNumber={5} />);
    await act(async () => {});
    expect(svgOf(container).getAttribute('data-spin-state')).toBe('spinning');
    advance(500);
    // restingNumber changes while spinning (e.g. an older revealed round) — must not interrupt.
    rerender(<RouletteWheel spin={{ roundId: 'r2', winningNumber: 26 }} speed="normal" reducedMotion={false} onSettled={onSettled} restingNumber={9} />);
    await act(async () => {});
    expect(svgOf(container).getAttribute('data-spin-state')).toBe('spinning');
    advance(20_000);
    expect(svgOf(container).getAttribute('data-landed-number')).toBe('26');
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith('r2');
  });
});
