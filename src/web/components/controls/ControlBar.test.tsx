// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionMode, SessionStatus } from '../../../shared/contracts';
import type { ControlBarProps } from '../../contracts';
import { ControlBar, enableState } from './ControlBar';

afterEach(cleanup);

const STATUSES: SessionStatus[] = ['ready', 'running', 'pause_requested', 'paused', 'stop_requested', 'stopped', 'completed'];

function props(over: Partial<ControlBarProps> = {}): ControlBarProps {
  return {
    mode: 'manual',
    status: 'ready',
    phase: 'ready',
    balance: 100_000,
    sessionNet: 0,
    currentStake: 0,
    lastNet: null,
    chipValue: 100,
    chipValues: [10, 50, 100, 500, 2500, 10000],
    onChipChange: vi.fn(),
    speed: 'normal',
    onSpeedChange: vi.fn(),
    onSpin: vi.fn(),
    canSpin: true,
    onClear: vi.fn(),
    onUndo: vi.fn(),
    onRepeat: vi.fn(),
    onStart: vi.fn(),
    onPause: vi.fn(),
    onStop: vi.fn(),
    onStep: vi.fn(),
    busy: false,
    animating: false,
    ...over,
  };
}

const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement;

describe('enableState matrix', () => {
  // Expected autonomous enables per status (not busy): [start, pause, stop, step]
  const AUTO: Record<SessionStatus, [boolean, boolean, boolean, boolean]> = {
    ready: [true, false, true, true],
    running: [false, true, true, false],
    pause_requested: [false, false, true, false],
    paused: [true, false, true, true],
    stop_requested: [false, false, false, false],
    stopped: [false, false, false, false],
    completed: [false, false, false, false],
  };

  it.each(STATUSES)('autonomous (%s)', (status) => {
    for (const mode of ['demo', 'ai'] as SessionMode[]) {
      const e = enableState({ mode, status, canSpin: true, busy: false, animating: false });
      expect([e.start, e.pause, e.stop, e.step]).toEqual(AUTO[status]);
      expect([e.spin, e.undo, e.clear, e.repeat, e.chips]).toEqual([false, false, false, false, false]);
      expect(e.speed).toBe(true);
      // busy disables every autonomous control
      const b = enableState({ mode, status, canSpin: true, busy: true, animating: false });
      expect([b.start, b.pause, b.stop, b.step]).toEqual([false, false, false, false]);
    }
  });

  it.each(STATUSES)('manual (%s)', (status) => {
    const e = enableState({ mode: 'manual', status, canSpin: true, busy: false, animating: false });
    const ready = status === 'ready';
    expect([e.spin, e.undo, e.clear, e.repeat]).toEqual([ready, ready, ready, ready]);
    expect(e.chips).toBe(status !== 'stopped' && status !== 'completed');
    expect([e.start, e.pause, e.stop, e.step]).toEqual([false, false, false, false]);
    expect(e.speed).toBe(true);
  });

  it('Spin needs canSpin, not busy and not animating', () => {
    const base = { mode: 'manual' as const, status: 'ready' as const, canSpin: true, busy: false, animating: false };
    expect(enableState(base).spin).toBe(true);
    expect(enableState({ ...base, canSpin: false }).spin).toBe(false);
    expect(enableState({ ...base, busy: true }).spin).toBe(false);
    expect(enableState({ ...base, animating: true }).spin).toBe(false);
  });
});

describe('ControlBar rendering', () => {
  it('shows balance, session net, current stake and "—" for no last round', () => {
    render(<ControlBar {...props({ balance: 104_550, sessionNet: 4_550, currentStake: 5_000 })} />);
    expect(screen.getByText('Virtual balance')).toBeTruthy();
    expect(screen.getByText('V$ 1,045.50')).toBeTruthy();
    expect(screen.getByText('+V$ 45.50 session net')).toBeTruthy();
    expect(screen.getByText('V$ 50.00')).toBeTruthy();
    expect(screen.getByText('Last round net')).toBeTruthy();
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('formats a negative last round net with a sign', () => {
    render(<ControlBar {...props({ lastNet: -250 })} />);
    expect(screen.getByText('−V$ 2.50')).toBeTruthy();
  });

  it('manual mode: Spin/Undo/Clear/Repeat call their handlers', async () => {
    const user = userEvent.setup();
    const p = props();
    render(<ControlBar {...p} />);
    await user.click(button('Spin'));
    await user.click(button('Undo'));
    await user.click(button('Undo'));
    await user.click(button('Clear'));
    await user.click(button('Repeat last'));
    expect(p.onSpin).toHaveBeenCalledTimes(1);
    expect(p.onUndo).toHaveBeenCalledTimes(2); // draft edits are not click-guarded
    expect(p.onClear).toHaveBeenCalledTimes(1);
    expect(p.onRepeat).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
  });

  it('Spin is disabled while busy (repeated-click protection)', async () => {
    const user = userEvent.setup();
    const p = props({ busy: true });
    const { rerender } = render(<ControlBar {...p} />);
    expect(button('Spin').disabled).toBe(true);
    await user.click(button('Spin'));
    expect(p.onSpin).not.toHaveBeenCalled();
    rerender(<ControlBar {...p} busy={false} />);
    expect(button('Spin').disabled).toBe(false);
  });

  it('a double click before the parent re-renders fires Spin once', () => {
    const p = props();
    render(<ControlBar {...p} />);
    const spin = button('Spin');
    fireEvent.click(spin);
    fireEvent.click(spin);
    expect(p.onSpin).toHaveBeenCalledTimes(1);
  });

  it('Spin is disabled while the wheel animates or when canSpin is false', () => {
    const { rerender } = render(<ControlBar {...props({ animating: true })} />);
    expect(button('Spin').disabled).toBe(true);
    rerender(<ControlBar {...props({ canSpin: false })} />);
    expect(button('Spin').disabled).toBe(true);
    expect(button('Undo').disabled).toBe(false);
  });

  it.each(STATUSES)('autonomous buttons follow the matrix in status %s', (status) => {
    render(<ControlBar {...props({ mode: 'ai', status })} />);
    const e = enableState({ mode: 'ai', status, canSpin: false, busy: false, animating: false });
    expect(button('Start').disabled).toBe(!e.start);
    expect(button('Pause after round').disabled).toBe(!e.pause);
    expect(button('Stop').disabled).toBe(!e.stop);
    expect(button('Next round').disabled).toBe(!e.step);
    expect(screen.queryByRole('button', { name: 'Spin' })).toBeNull();
  });

  it('autonomous buttons call their handlers', async () => {
    const user = userEvent.setup();
    const p = props({ mode: 'demo', status: 'ready' });
    const { rerender } = render(<ControlBar {...p} />);
    await user.click(button('Start'));
    expect(p.onStart).toHaveBeenCalledTimes(1);
    rerender(<ControlBar {...p} status="running" />);
    await user.click(button('Pause after round'));
    await user.click(button('Stop'));
    expect(p.onPause).toHaveBeenCalledTimes(1);
    expect(p.onStop).toHaveBeenCalledTimes(1);
    rerender(<ControlBar {...p} status="paused" />);
    await user.click(button('Next round'));
    expect(p.onStep).toHaveBeenCalledTimes(1);
  });

  it.each(['stopped', 'completed'] as SessionStatus[])('terminal status %s disables everything except speed', async (status) => {
    const user = userEvent.setup();
    for (const mode of ['manual', 'ai'] as SessionMode[]) {
      const p = props({ mode, status });
      const { unmount } = render(<ControlBar {...p} />);
      const buttons = screen.getAllByRole('button');
      const radios = screen.getAllByRole('radio');
      const speedRadios = radios.filter((r) => /speed/i.test(r.getAttribute('aria-label') ?? ''));
      expect(speedRadios.length).toBe(3);
      for (const b of [...buttons, ...radios.filter((r) => !speedRadios.includes(r))]) {
        expect((b as HTMLButtonElement).disabled).toBe(true);
      }
      for (const r of speedRadios) expect((r as HTMLButtonElement).disabled).toBe(false);
      await user.click(screen.getByRole('radio', { name: 'Maximum speed' }));
      expect(p.onSpeedChange).toHaveBeenCalledWith('instant');
      unmount();
    }
  });

  it('speed control is a labelled radio group with the helper text', async () => {
    const user = userEvent.setup();
    const p = props({ speed: 'fast' });
    render(<ControlBar {...p} />);
    expect(screen.getByText('Animation only — does not change how often the model is called')).toBeTruthy();
    const group = screen.getByRole('radiogroup', { name: 'Animation speed' });
    expect(group.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Double speed' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Double speed' }).textContent).toBe('2×');
    await user.click(screen.getByRole('radio', { name: 'Normal speed' }));
    expect(p.onSpeedChange).toHaveBeenCalledWith('normal');
    screen.getByRole('radio', { name: 'Double speed' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(p.onSpeedChange).toHaveBeenLastCalledWith('instant');
  });

  it('chip selector shows the given values and reports a new chip', async () => {
    const user = userEvent.setup();
    const p = props({ chipValues: [50, 100, 500], chipValue: 100 });
    render(<ControlBar {...p} />);
    const chips = screen.getAllByRole('radio').filter((r) => /^Chip /.test(r.getAttribute('aria-label') ?? ''));
    expect(chips.map((c) => c.getAttribute('aria-label'))).toEqual(['Chip V$ 0.50', 'Chip V$ 1.00', 'Chip V$ 5.00']);
    expect(screen.getByRole('radio', { name: 'Chip V$ 1.00' }).getAttribute('aria-checked')).toBe('true');
    await user.click(screen.getByRole('radio', { name: 'Chip V$ 5.00' }));
    expect(p.onChipChange).toHaveBeenCalledWith(500);
    screen.getByRole('radio', { name: 'Chip V$ 1.00' }).focus();
    await user.keyboard('{ArrowLeft}');
    expect(p.onChipChange).toHaveBeenLastCalledWith(50);
  });

  it('every control has a text label and an icon', () => {
    render(<ControlBar {...props()} />);
    for (const name of ['Spin', 'Undo', 'Clear', 'Repeat last']) {
      const b = button(name);
      expect(b.textContent).toBe(name);
      expect(b.querySelector('svg')).not.toBeNull();
      expect(b.className).toContain('min-h-10');
    }
  });
});
