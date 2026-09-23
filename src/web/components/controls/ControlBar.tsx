/**
 * OWNER: betting-table agent (A5). Apron control bar under the table.
 *
 * Shows the revealed virtual balance (+ session net), the current stake and the last round's net,
 * the chip picker (manual), the round controls and the animation-speed switch. It only reports
 * clicks; the server decides whether a request is legal.
 *
 * Enable rules (see enableState):
 *   Spin              manual && status === 'ready' && canSpin && !busy && !animating
 *   Undo/Clear/Repeat manual && status === 'ready' && !busy && !animating (&& canUndo/canClear/canRepeat)
 *   Start             autonomous && status ∈ {ready, paused} && !busy
 *   Pause after round autonomous && status === 'running' && !busy
 *   Stop              autonomous && status ∈ {ready, running, pause_requested, paused} && !busy
 *   Next round        autonomous && status ∈ {ready, paused} && !busy
 *   Speed             always (presentation only)
 * Terminal statuses (stopped, completed) therefore disable everything except the speed switch.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Disc3, Eraser, Pause, Play, Repeat, SkipForward, Square, Undo2, type LucideIcon } from 'lucide-react';
import { formatCredits } from '../../../shared/money';
import type { AnimationSpeed, SessionMode, SessionPhase, SessionStatus } from '../../../shared/contracts';
import type { ControlBarProps } from '../../contracts';
import { ChipSelector } from './ChipSelector';

export type { ControlBarProps };

export interface ControlBarExtraProps {
  /** Optional finer-grained flags for the draft buttons (default true). */
  readonly canUndo?: boolean;
  readonly canClear?: boolean;
  readonly canRepeat?: boolean;
  readonly className?: string;
}

export interface EnableState {
  spin: boolean;
  undo: boolean;
  clear: boolean;
  repeat: boolean;
  start: boolean;
  pause: boolean;
  stop: boolean;
  step: boolean;
  chips: boolean;
  speed: boolean;
}

export const TERMINAL_STATUSES: readonly SessionStatus[] = ['stopped', 'completed'];

/** Pure enable/disable matrix (exported for tests and for the dashboard's keyboard shortcuts). */
export function enableState(p: {
  mode: SessionMode;
  status: SessionStatus;
  canSpin: boolean;
  busy: boolean;
  animating: boolean;
  canUndo?: boolean;
  canClear?: boolean;
  canRepeat?: boolean;
}): EnableState {
  const manual = p.mode === 'manual';
  const terminal = TERMINAL_STATUSES.includes(p.status);
  const draftEditable = manual && p.status === 'ready' && !p.busy && !p.animating;
  const auto = !manual && !p.busy;
  return {
    spin: draftEditable && p.canSpin,
    undo: draftEditable && (p.canUndo ?? true),
    clear: draftEditable && (p.canClear ?? true),
    repeat: draftEditable && (p.canRepeat ?? true),
    start: auto && (p.status === 'ready' || p.status === 'paused'),
    pause: auto && p.status === 'running',
    stop: auto && (p.status === 'ready' || p.status === 'running' || p.status === 'pause_requested' || p.status === 'paused'),
    step: auto && (p.status === 'ready' || p.status === 'paused'),
    chips: manual && !terminal,
    speed: true,
  };
}

const STATUS_TEXT: Record<SessionStatus, string> = {
  ready: 'Ready',
  running: 'Running',
  pause_requested: 'Pausing after this round',
  paused: 'Paused',
  stop_requested: 'Stopping',
  stopped: 'Stopped',
  completed: 'Completed',
};

const PHASE_TEXT: Record<SessionPhase, string | null> = {
  ready: null,
  requesting_decision: 'waiting for the player’s decision',
  committed: 'bets committed',
  outcome_recorded: 'outcome recorded',
  settled: 'round settled',
};

const SPEEDS: readonly { value: AnimationSpeed; label: string; name: string }[] = [
  { value: 'normal', label: '1×', name: 'Normal speed' },
  { value: 'fast', label: '2×', name: 'Double speed' },
  { value: 'instant', label: 'Max', name: 'Maximum speed' },
];

/** After a server-bound click, ignore further clicks on it until the props change (or a short timeout). */
const CLICK_GUARD_MS = 800;

type Tone = 'gold' | 'primary' | 'danger' | 'neutral';
const TONE: Record<Tone, string> = {
  gold: 'bg-champagne text-walnut-dark hover:bg-champagne-light',
  primary: 'bg-primary text-white hover:bg-primary-strong',
  danger: 'bg-danger text-white hover:bg-danger-strong',
  neutral: 'bg-white/10 text-white hover:bg-white/20',
};

function CtrlButton(props: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  enabled: boolean;
  tone?: Tone;
  title?: string;
}) {
  const { icon: Icon, label, onClick, enabled, tone = 'neutral', title } = props;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!enabled}
      title={title}
      className={[
        'inline-flex min-h-10 min-w-10 items-center justify-center gap-1.5 rounded-lg px-3 py-2',
        'font-mono text-xs font-bold shadow-sm transition-colors active:scale-95',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-champagne-pale',
        'disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100',
        TONE[tone],
      ].join(' ')}
    >
      <Icon aria-hidden="true" size={16} strokeWidth={2.25} />
      <span>{label}</span>
    </button>
  );
}

function Metric({ label, value, sub, tone = 'text-white' }: { label: string; value: string; sub?: ReactNode; tone?: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-champagne">{label}</span>
      <span className={`tnum font-mono text-lg font-bold leading-tight tracking-tight sm:text-xl ${tone}`}>{value}</span>
      {sub}
    </div>
  );
}

function netTone(v: number): string {
  return v > 0 ? 'text-mint' : v < 0 ? 'text-danger-soft' : 'text-white';
}

export function ControlBar(props: ControlBarProps & ControlBarExtraProps) {
  const {
    mode,
    status,
    phase,
    balance,
    sessionNet,
    currentStake,
    lastNet,
    chipValue,
    chipValues,
    onChipChange,
    speed,
    onSpeedChange,
    onSpin,
    canSpin,
    onClear,
    onUndo,
    onRepeat,
    onStart,
    onPause,
    onStop,
    onStep,
    busy,
    animating,
    className = '',
  } = props;

  const en = enableState(props);
  const manual = mode === 'manual';
  const speedHelpId = useId();

  // Repeated-click protection for server-bound actions: `busy` is the primary guard; this also
  // swallows a second click that lands before the parent has re-rendered with busy = true.
  const [guarded, setGuarded] = useState<string | null>(null);
  const guardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setGuarded(null);
  }, [busy, status, phase, animating, canSpin]);
  useEffect(() => () => {
    if (guardTimer.current) clearTimeout(guardTimer.current);
  }, []);
  const guardedRef = useRef<string | null>(null);
  guardedRef.current = guarded;
  const once = (id: string, fn: () => void) => () => {
    if (guardedRef.current === id) return;
    guardedRef.current = id;
    setGuarded(id);
    if (guardTimer.current) clearTimeout(guardTimer.current);
    guardTimer.current = setTimeout(() => setGuarded(null), CLICK_GUARD_MS);
    fn();
  };
  const allow = (id: string, enabled: boolean) => enabled && guarded !== id;

  const phaseText = PHASE_TEXT[phase];

  return (
    <section
      aria-label="Round controls"
      className={`flex flex-col gap-3 rounded-xl border border-champagne/30 bg-felt-dark p-3 text-white shadow-felt ${className}`}
    >
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        {/* Money: all values are revealed, server-reported virtual credits. */}
        <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
          <Metric
            label="Virtual balance"
            value={formatCredits(balance)}
            sub={
              <span className={`tnum font-mono text-[11px] font-semibold ${netTone(sessionNet)}`}>
                {formatCredits(sessionNet, { sign: true })} session net
              </span>
            }
          />
          <div className="hidden h-8 w-px bg-white/20 sm:block" aria-hidden="true" />
          <Metric label="Current stake" value={formatCredits(currentStake)} tone="text-champagne-light" />
          <Metric
            label="Last round net"
            value={lastNet === null ? '—' : formatCredits(lastNet, { sign: true })}
            tone={lastNet === null ? 'text-white/70' : netTone(lastNet)}
          />
        </div>

        {manual && (
          <ChipSelector values={chipValues} value={chipValue} onChange={onChipChange} disabled={!en.chips} />
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 border-t border-champagne/20 pt-3">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={manual ? 'Manual round' : 'Autonomous play'}>
          {manual ? (
            <>
              <CtrlButton icon={Disc3} label="Spin" tone="gold" enabled={allow('spin', en.spin)} onClick={once('spin', onSpin)} />
              <CtrlButton icon={Undo2} label="Undo" enabled={en.undo} onClick={onUndo} />
              <CtrlButton icon={Eraser} label="Clear" enabled={en.clear} onClick={onClear} />
              <CtrlButton icon={Repeat} label="Repeat last" enabled={en.repeat} onClick={onRepeat} />
            </>
          ) : (
            <>
              <CtrlButton icon={Play} label="Start" tone="primary" enabled={allow('start', en.start)} onClick={once('start', onStart)} />
              <CtrlButton
                icon={Pause}
                label="Pause after round"
                enabled={allow('pause', en.pause)}
                onClick={once('pause', onPause)}
                title="Finish the current round, then pause"
              />
              <CtrlButton icon={Square} label="Stop" tone="danger" enabled={allow('stop', en.stop)} onClick={once('stop', onStop)} />
              <CtrlButton
                icon={SkipForward}
                label="Next round"
                enabled={allow('step', en.step)}
                onClick={once('step', onStep)}
                title="Play exactly one round, then pause"
              />
            </>
          )}
        </div>

        <div className="flex flex-col items-start gap-1 sm:items-end">
          <div
            role="radiogroup"
            aria-label="Animation speed"
            aria-describedby={speedHelpId}
            className="flex items-center rounded-lg bg-black/40 p-0.5"
            onKeyDown={(e) => {
              const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
              if (step === 0) return;
              e.preventDefault();
              const i = Math.max(0, SPEEDS.findIndex((s) => s.value === speed));
              const next = (i + step + SPEEDS.length) % SPEEDS.length;
              onSpeedChange(SPEEDS[next].value);
              e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
            }}
          >
            {SPEEDS.map((s, i) => {
              const checked = s.value === speed;
              const focusable = checked || (i === 0 && !SPEEDS.some((x) => x.value === speed));
              return (
                <button
                  key={s.value}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  aria-label={s.name}
                  tabIndex={focusable ? 0 : -1}
                  onClick={() => onSpeedChange(s.value)}
                  className={[
                    'min-h-10 min-w-12 rounded-md px-2 font-mono text-xs transition-colors sm:min-h-8',
                    'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-champagne-pale',
                    checked ? 'bg-primary font-bold text-white' : 'text-white/70 hover:text-white',
                  ].join(' ')}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
          <p id={speedHelpId} className="m-0 text-[11px] text-white/60">
            Animation only — does not change how often the model is called
          </p>
        </div>
      </div>

      <p role="status" aria-live="polite" className="m-0 font-mono text-[11px] text-champagne-light/90">
        Session: {STATUS_TEXT[status]}
        {phaseText && !TERMINAL_STATUSES.includes(status) ? ` · ${phaseText}` : ''}
        {busy ? ' · sending request…' : ''}
        {animating ? ' · wheel spinning' : ''}
      </p>
    </section>
  );
}

export default ControlBar;
