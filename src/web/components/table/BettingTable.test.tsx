// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { betKey } from '../../../shared/bets';
import type { BetInput, RoundBet } from '../../../shared/contracts';
import type { BetSpot, BettingTableProps, DraftBet } from '../../contracts';
import { BettingTable, LONG_PRESS_MS } from './BettingTable';
import { findSpot } from './spots';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Pos = Omit<BetInput, 'stake'>;

function setup(overrides: Partial<BettingTableProps> & { orientation?: 'horizontal' | 'vertical' } = {}) {
  const onPlace = vi.fn<(spot: BetSpot) => void>();
  const onRemove = vi.fn<(spot: BetSpot) => void>();
  const props = {
    draft: [] as DraftBet[],
    committed: [] as RoundBet[],
    disabled: false,
    highlightNumber: null,
    onPlace,
    onRemove,
    ...overrides,
  };
  const utils = render(<BettingTable {...props} />);
  const spotEl = (pos: Pos) => {
    const el = utils.container.querySelector<HTMLButtonElement>(`[data-bet-key="${betKey(pos)}"]`);
    if (!el) throw new Error(`no element for ${betKey(pos)}`);
    return el;
  };
  return { ...utils, onPlace, onRemove, spotEl, props };
}

const REPRESENTATIVE: { name: string; pos: Pos }[] = [
  { name: 'split 8/11', pos: { type: 'split', numbers: [8, 11] } },
  { name: 'corner 1/2/4/5', pos: { type: 'corner', numbers: [1, 2, 4, 5] } },
  { name: 'trio 0/1/2', pos: { type: 'trio', numbers: [0, 1, 2] } },
  { name: 'first four', pos: { type: 'firstFour', numbers: [0, 1, 2, 3] } },
  { name: 'street 7-9', pos: { type: 'street', numbers: [7, 8, 9] } },
  { name: 'six line 1-6', pos: { type: 'sixLine', numbers: [1, 2, 3, 4, 5, 6] } },
  { name: 'dozen 2', pos: { type: 'dozen', index: 2 } },
  { name: 'column 3', pos: { type: 'column', index: 3 } },
  { name: 'red', pos: { type: 'red' } },
  { name: 'straight 0', pos: { type: 'straight', numbers: [0] } },
];

describe('BettingTable rendering', () => {
  it('renders every bet position exactly once with a descriptive accessible name', () => {
    const { container } = setup();
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('[data-bet-key]')];
    expect(buttons.length).toBe(157);
    expect(new Set(buttons.map((b) => b.dataset.betKey)).size).toBe(157);
    for (const b of buttons) {
      expect(b.getAttribute('aria-label')).toMatch(/, pays \d+ to 1, your stake V\$ \d/);
    }
  });

  it('announces the draft stake in the aria-label and shows a draft chip', () => {
    const spot = findSpot(betKey({ type: 'split', numbers: [8, 11] }))!;
    const { spotEl } = setup({ draft: [{ spot, stake: 50 }] });
    const el = spotEl(spot.bet);
    expect(el.getAttribute('aria-label')).toBe('Split 8 and 11, pays 17 to 1, your stake V$ 0.50');
    const chip = el.querySelector('[data-chip="draft"]');
    expect(chip?.textContent).toBe('.50');
    expect(chip?.getAttribute('title')).toBe('V$ 0.50');
  });

  it('shows committed bets read-only and visually distinct from draft chips', () => {
    const committed: RoundBet[] = [
      { key: 'red', type: 'red', numbers: [], stake: 500, payout: 1, label: 'Red', won: null, returned: null },
    ];
    const { spotEl } = setup({ committed, disabled: true });
    const red = spotEl({ type: 'red' });
    expect(red.querySelector('[data-chip="committed"]')?.textContent).toBe('5');
    expect(red.querySelector('[data-chip="draft"]')).toBeNull();
    expect(red.getAttribute('aria-label')).toContain('committed V$ 5.00');
  });

  it('highlights the revealed winning number only', () => {
    const { spotEl } = setup({ highlightNumber: 17 });
    expect(spotEl({ type: 'straight', numbers: [17] }).getAttribute('aria-label')).toContain('winning number');
    expect(spotEl({ type: 'straight', numbers: [18] }).getAttribute('aria-label')).not.toContain('winning number');
  });

  it('uses a single roving tab stop', () => {
    const { container } = setup();
    const tabbable = container.querySelectorAll('[data-bet-key][tabindex="0"]');
    expect(tabbable.length).toBe(1);
    expect((tabbable[0] as HTMLElement).dataset.betKey).toBe('straight:0');
  });
});

describe('BettingTable pointer input', () => {
  it.each(REPRESENTATIVE)('click on $name → onPlace with that bet', async ({ pos }) => {
    const user = userEvent.setup();
    const { spotEl, onPlace, onRemove } = setup();
    await user.click(spotEl(pos));
    expect(onPlace).toHaveBeenCalledTimes(1);
    expect(onRemove).not.toHaveBeenCalled();
    const spot = onPlace.mock.calls[0][0];
    expect(spot.key).toBe(betKey(pos));
    expect(spot.bet).toEqual(pos);
  });

  it('works the same in the vertical (mobile) layout', async () => {
    const user = userEvent.setup();
    const { spotEl, onPlace, container } = setup({ orientation: 'vertical' });
    expect(container.querySelector('[data-orientation="vertical"]')).not.toBeNull();
    await user.click(spotEl({ type: 'corner', numbers: [1, 2, 4, 5] }));
    expect(onPlace.mock.calls[0][0].bet).toEqual({ type: 'corner', numbers: [1, 2, 4, 5] });
  });

  it('Shift+click removes instead of placing', async () => {
    const user = userEvent.setup();
    const { spotEl, onPlace, onRemove } = setup();
    await user.keyboard('{Shift>}');
    await user.click(spotEl({ type: 'split', numbers: [8, 11] }));
    await user.keyboard('{/Shift}');
    expect(onPlace).not.toHaveBeenCalled();
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove.mock.calls[0][0].key).toBe('split:8-11');
  });

  it('right-click removes (and suppresses the browser menu)', () => {
    const { spotEl, onPlace, onRemove } = setup();
    const notCancelled = fireEvent.contextMenu(spotEl({ type: 'dozen', index: 2 }));
    expect(notCancelled).toBe(false);
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove.mock.calls[0][0].key).toBe('dozen:2');
    expect(onPlace).not.toHaveBeenCalled();
  });

  it('long-press on touch removes one chip and swallows the trailing click/contextmenu', () => {
    vi.useFakeTimers();
    const { spotEl, onPlace, onRemove } = setup();
    const el = spotEl({ type: 'straight', numbers: [17] });
    fireEvent.pointerDown(el, { pointerType: 'touch' });
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    });
    expect(onRemove).toHaveBeenCalledTimes(1);
    fireEvent.contextMenu(el); // Android fires contextmenu on long-press
    fireEvent.pointerUp(el, { pointerType: 'touch' });
    fireEvent.click(el);
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onPlace).not.toHaveBeenCalled();
  });

  it('a short touch tap places normally', () => {
    vi.useFakeTimers();
    const { spotEl, onPlace, onRemove } = setup();
    const el = spotEl({ type: 'straight', numbers: [17] });
    fireEvent.pointerDown(el, { pointerType: 'touch' });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    fireEvent.pointerUp(el, { pointerType: 'touch' });
    fireEvent.click(el);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    });
    expect(onPlace).toHaveBeenCalledTimes(1);
    expect(onRemove).not.toHaveBeenCalled();
  });

  it('a disabled table ignores clicks, shift-clicks, right-clicks and keys', async () => {
    const user = userEvent.setup();
    const { spotEl, onPlace, onRemove, container } = setup({ disabled: true });
    const el = spotEl({ type: 'red' });
    expect(el.getAttribute('aria-disabled')).toBe('true');
    await user.click(el);
    await user.keyboard('{Shift>}');
    await user.click(el);
    await user.keyboard('{/Shift}');
    fireEvent.contextMenu(el);
    el.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    await user.keyboard('{Delete}');
    expect(onPlace).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Table locked');
  });

  it('a disabled table ignores long-presses', () => {
    vi.useFakeTimers();
    const { spotEl, onPlace, onRemove } = setup({ disabled: true });
    const el = spotEl({ type: 'straight', numbers: [17] });
    fireEvent.pointerDown(el, { pointerType: 'touch' });
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    });
    fireEvent.pointerUp(el, { pointerType: 'touch' });
    expect(onRemove).not.toHaveBeenCalled();
    expect(onPlace).not.toHaveBeenCalled();
  });

  it('a long-press that started enabled does nothing if the table becomes disabled first', () => {
    vi.useFakeTimers();
    const { spotEl, onRemove, rerender, props } = setup();
    fireEvent.pointerDown(spotEl({ type: 'red' }), { pointerType: 'touch' });
    rerender(<BettingTable {...props} disabled />);
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    });
    expect(onRemove).not.toHaveBeenCalled();
  });
});

describe('BettingTable keyboard', () => {
  it('arrow keys move focus to the nearest spot and Enter places a chip there', async () => {
    const user = userEvent.setup();
    const { spotEl, onPlace } = setup();
    const eight = spotEl({ type: 'straight', numbers: [8] });
    eight.focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(spotEl({ type: 'split', numbers: [8, 11] }));
    await user.keyboard('{ArrowRight}');
    const eleven = spotEl({ type: 'straight', numbers: [11] });
    expect(document.activeElement).toBe(eleven);
    expect(eleven.tabIndex).toBe(0);
    expect(eight.tabIndex).toBe(-1);
    await user.keyboard('{Enter}');
    expect(onPlace).toHaveBeenCalledTimes(1);
    expect(onPlace.mock.calls[0][0].key).toBe('straight:11');
    await user.keyboard(' ');
    expect(onPlace).toHaveBeenCalledTimes(2);
  });

  it('ArrowDown walks split → straight → street; Delete/Backspace remove; Home/End jump', async () => {
    const user = userEvent.setup();
    const { spotEl, onRemove, container } = setup();
    spotEl({ type: 'straight', numbers: [8] }).focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(spotEl({ type: 'split', numbers: [7, 8] }));
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(document.activeElement).toBe(spotEl({ type: 'street', numbers: [7, 8, 9] }));
    await user.keyboard('{Delete}');
    await user.keyboard('{Backspace}');
    expect(onRemove).toHaveBeenCalledTimes(2);
    expect(onRemove.mock.calls[0][0].key).toBe('street:7-8-9');
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(spotEl({ type: 'straight', numbers: [0] }));
    await user.keyboard('{End}');
    expect((document.activeElement as HTMLElement).dataset.betKey).toBe('high');
    expect(container.querySelectorAll('[data-bet-key][tabindex="0"]').length).toBe(1);
  });
});

describe('BettingTable orientation', () => {
  it('follows the container width through ResizeObserver', () => {
    let callback: ResizeObserverCallback | null = null;
    class FakeResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        callback = cb;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    const { container } = setup();
    const resize = (width: number) =>
      act(() => {
        callback?.([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver);
      });
    resize(390);
    expect(container.querySelector('[data-orientation]')?.getAttribute('data-orientation')).toBe('vertical');
    resize(900);
    expect(container.querySelector('[data-orientation]')?.getAttribute('data-orientation')).toBe('horizontal');
    resize(639);
    expect(container.querySelector('[data-orientation]')?.getAttribute('data-orientation')).toBe('vertical');
  });
});
