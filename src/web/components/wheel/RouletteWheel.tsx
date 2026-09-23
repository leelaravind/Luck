/**
 * RouletteWheel — animated European wheel (props contract: RouletteWheelProps in ../../contracts).
 *
 * Presentation only. The server has already drawn and persisted `spin.winningNumber`; this component
 * animates the ball into that pocket and calls `onSettled(roundId)` exactly once when it rests. It never
 * chooses a number and never computes payouts.
 *
 * Layers (bottom → top): stationary housing · rotor (wedges, frets, cone, turret, finial, highlight) ·
 * stationary sheen · ball. Per-frame motion is written through refs by WheelAnimator, so React only
 * re-renders on coarse status changes (spin start / settle) for the accessible label.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { RouletteWheelProps as RouletteWheelContract } from '../../contracts';
import { colorOf } from '../../../shared/roulette';
import { VIEWBOX } from './wheelGeometry';
import { WheelAnimator, type WheelStatus } from './wheelAnimator';
import { WheelBall, WheelDefs, WheelHousing, WheelRotor, WheelSheen } from './WheelParts';

/** Props contract lives in src/web/contracts.ts; declared here too so the component validator can see it. */
export interface RouletteWheelProps extends Readonly<RouletteWheelContract> {}

/** Accessible description of the wheel for a given status. */
export function wheelAriaLabel(status: WheelStatus): string {
  switch (status.kind) {
    case 'spinning':
      return 'Roulette wheel. Spinning';
    case 'settled':
      return `Roulette wheel. Last result: ${status.number} ${colorOf(status.number)}`;
    case 'error':
      return 'Roulette wheel. Result unavailable';
    default:
      return 'Roulette wheel. No result yet';
  }
}

export function RouletteWheel({ spin, speed, reducedMotion, onSettled, className }: RouletteWheelProps) {
  // useId() may contain characters that are awkward inside url(#…); keep it to [A-Za-z0-9_-].
  const uid = `luck-wheel-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  const rootRef = useRef<SVGSVGElement>(null);
  const rotorRef = useRef<SVGGElement>(null);
  const ballRef = useRef<SVGGElement>(null);
  const highlightRef = useRef<SVGGElement>(null);
  const animatorRef = useRef<WheelAnimator | null>(null);
  const [status, setStatus] = useState<WheelStatus>({ kind: 'idle' });

  // Latest props for callbacks that must not restart anything when they change identity.
  const onSettledRef = useRef(onSettled);
  const speedRef = useRef(speed);
  const reducedRef = useRef(reducedMotion);
  useLayoutEffect(() => {
    onSettledRef.current = onSettled;
    speedRef.current = speed;
    reducedRef.current = reducedMotion;
  });

  /** roundIds already reported via onSettled — survives animator re-creation (e.g. StrictMode remount). */
  const settledIds = useRef(new Set<string>());

  useLayoutEffect(() => {
    const root = rootRef.current;
    const rotor = rotorRef.current;
    const ball = ballRef.current;
    const highlight = highlightRef.current;
    if (!root || !rotor || !ball || !highlight) return;
    const animator = new WheelAnimator(
      { root, rotor, ball, highlight },
      {
        onStatus: setStatus,
        onSettled: (roundId) => {
          if (settledIds.current.has(roundId)) return;
          settledIds.current.add(roundId);
          onSettledRef.current(roundId);
        },
      },
      { reducedMotion: reducedRef.current },
    );
    animatorRef.current = animator;
    return () => {
      animator.destroy();
      if (animatorRef.current === animator) animatorRef.current = null;
    };
  }, []);

  // Declared before the spin effect so a simultaneous change applies reduced motion first.
  useEffect(() => {
    animatorRef.current?.setReducedMotion(reducedMotion);
  }, [reducedMotion]);

  const roundId = spin?.roundId ?? null;
  const winningNumber = spin?.winningNumber ?? null;
  useEffect(() => {
    if (roundId === null || winningNumber === null) return;
    animatorRef.current?.spin(roundId, winningNumber, speedRef.current);
  }, [roundId, winningNumber]);

  return (
    <svg
      ref={rootRef}
      viewBox={VIEWBOX}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={wheelAriaLabel(status)}
      className={['block aspect-square h-auto w-full select-none', className].filter(Boolean).join(' ')}
    >
      <WheelDefs uid={uid} />
      <WheelHousing uid={uid} />
      <WheelRotor uid={uid} rotorRef={rotorRef} highlightRef={highlightRef} />
      <WheelSheen uid={uid} />
      <WheelBall uid={uid} ballRef={ballRef} />
    </svg>
  );
}

export default RouletteWheel;
