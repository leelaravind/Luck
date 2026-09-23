/**
 * Static SVG layers of the roulette wheel. Look taken from design-references/stitch_ai_roulette_lab
 * (walnut radial housing, champagne rim, steel ball track, gold turret spokes and finial); the geometry is
 * the full 37-pocket European wheel instead of the reference's 5 decorative wedges.
 *
 * These layers never animate by themselves: RouletteWheel's animator writes `transform` on the rotor and
 * ball groups (and toggles the highlight) through refs. None of the animated attributes are rendered from
 * React props, so a React re-render can never reset them mid-spin.
 * All colours come from the theme tokens in src/web/styles/app.css.
 */
import { memo, type Ref } from 'react';
import { WHEEL_ORDER, colorOf, type PocketColor } from '../../../shared/roulette';
import { POCKET_ANGLE, pocketCenterAngle } from './wheelMath';
import { BALL_SIZE, POCKET_OUTLINE_PATH, WEDGE_PATH, WHEEL_R, polar } from './wheelGeometry';

export const POCKET_FILL: Readonly<Record<PocketColor, string>> = Object.freeze({
  red: 'var(--color-pocket-red)',
  black: 'var(--color-pocket-black)',
  green: 'var(--color-pocket-green)',
});

/** Gradient / filter ids, unique per wheel instance. */
export function wheelDefIds(uid: string) {
  return {
    walnut: `${uid}-walnut`,
    gold: `${uid}-gold`,
    cone: `${uid}-cone`,
    ball: `${uid}-ball`,
    sheen: `${uid}-sheen`,
    shadow: `${uid}-shadow`,
  };
}

const url = (id: string) => `url(#${id})`;

export const WheelDefs = memo(function WheelDefs({ uid }: { uid: string }) {
  const id = wheelDefIds(uid);
  return (
    <defs>
      <radialGradient id={id.walnut} cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor="var(--color-walnut)" />
        <stop offset="65%" stopColor="var(--color-walnut-mid)" />
        <stop offset="100%" stopColor="var(--color-walnut-dark)" />
      </radialGradient>
      {/* Centred (rotation-invariant) so the finial does not appear to wobble while the rotor turns. */}
      <radialGradient id={id.gold} cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor="var(--color-champagne-pale)" />
        <stop offset="55%" stopColor="var(--color-champagne)" />
        <stop offset="100%" stopColor="var(--color-champagne-deep)" />
      </radialGradient>
      <radialGradient id={id.cone} cx="50%" cy="50%" r="50%">
        <stop offset="0%" stopColor="var(--color-rotor)" />
        <stop offset="100%" stopColor="var(--color-rotor-dark)" />
      </radialGradient>
      {/* Ball: white core → hairline → steel, lit from the upper left (the ball group only translates). */}
      <radialGradient id={id.ball} cx="38%" cy="32%" r="72%">
        <stop offset="0%" stopColor="var(--color-card)" />
        <stop offset="45%" stopColor="var(--color-hairline)" />
        <stop offset="100%" stopColor="var(--color-steel)" />
      </radialGradient>
      {/* Fixed light sheen above the rotor: stays put while the rotor turns underneath. */}
      <radialGradient id={id.sheen} cx="32%" cy="22%" r="80%">
        <stop offset="0%" stopColor="var(--color-card)" stopOpacity="0.16" />
        <stop offset="100%" stopColor="var(--color-card)" stopOpacity="0" />
      </radialGradient>
      <filter id={id.shadow} x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="3" />
      </filter>
    </defs>
  );
});

/** Stationary housing: walnut bowl, champagne rim, steel ball track, 8 diamond deflectors. */
export const WheelHousing = memo(function WheelHousing({ uid }: { uid: string }) {
  const id = wheelDefIds(uid);
  const trackMid = (WHEEL_R.trackOuter + WHEEL_R.trackInner) / 2;
  return (
    <g data-layer="housing">
      <circle r={WHEEL_R.housing} cy={4} fill="black" opacity={0.5} filter={url(id.shadow)} />
      <circle r={WHEEL_R.housing} fill={url(id.walnut)} />
      <circle r={WHEEL_R.housing - 1.4} fill="none" stroke="var(--color-walnut)" strokeWidth={1.2} opacity={0.7} />
      <circle r={WHEEL_R.rim} fill="none" stroke="var(--color-champagne)" strokeWidth={2.2} opacity={0.85} />
      <circle r={WHEEL_R.rim - 2.1} fill="none" stroke="var(--color-walnut-dark)" strokeWidth={1.2} />
      {/* Steel ball track */}
      <circle
        r={trackMid}
        fill="none"
        stroke="var(--color-steel)"
        strokeWidth={WHEEL_R.trackOuter - WHEEL_R.trackInner}
        opacity={0.5}
      />
      <circle r={WHEEL_R.trackOuter - 0.4} fill="none" stroke="var(--color-steel)" strokeWidth={0.7} opacity={0.9} />
      <circle r={WHEEL_R.trackInner + 0.4} fill="none" stroke="var(--color-steel)" strokeWidth={0.7} opacity={0.9} />
      <circle r={trackMid + 3} fill="none" stroke="var(--color-card)" strokeWidth={0.6} opacity={0.18} />
      {/* Lower sloped track with the 8 deflectors (alternating radial / tangential diamonds) */}
      <circle
        r={WHEEL_R.deflector}
        fill="none"
        stroke="var(--color-walnut-deep)"
        strokeWidth={WHEEL_R.trackInner - WHEEL_R.rotorOuter}
      />
      {Array.from({ length: 8 }, (_, k) => (
        <path
          key={k}
          data-deflector={k}
          d="M 0 -3.8 L 1.7 0 L 0 3.8 L -1.7 0 Z"
          transform={`rotate(${k * 45 + 22.5}) translate(0 ${-WHEEL_R.deflector})${k % 2 ? ' rotate(90)' : ''}`}
          fill="var(--color-champagne)"
          stroke="var(--color-champagne-deep)"
          strokeWidth={0.4}
        />
      ))}
    </g>
  );
});

interface RotorProps {
  uid: string;
  rotorRef: Ref<SVGGElement>;
  highlightRef: Ref<SVGGElement>;
}

/**
 * Rotor: 37 wedges in WHEEL_ORDER (clockwise from 0 at 12 o'clock in rotor coordinates), champagne frets,
 * cone, turret spokes and finial. The winning-pocket highlight lives inside so it turns with the rotor.
 */
export const WheelRotor = memo(function WheelRotor({ uid, rotorRef, highlightRef }: RotorProps) {
  const id = wheelDefIds(uid);
  const pocketBandR = (WHEEL_R.numberInner + WHEEL_R.pocketInner) / 2;
  return (
    <g ref={rotorRef} data-layer="rotor">
      <circle r={WHEEL_R.rotorOuter + 0.8} fill="var(--color-rotor-dark)" stroke="var(--color-champagne)" strokeWidth={0.9} />
      {WHEEL_ORDER.map((n, i) => (
        <g key={n} data-pocket={n} data-pocket-index={i} transform={`rotate(${pocketCenterAngle(i)})`}>
          <path d={WEDGE_PATH} fill={POCKET_FILL[colorOf(n)]} data-color={colorOf(n)} />
          {/* Upright when the pocket is at 12 o'clock (glyph tops point outward, like a real wheel). */}
          <text
            x={0}
            y={-WHEEL_R.label}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={6}
            fontWeight={700}
            fill="var(--color-ivory)"
            className="font-mono"
          >
            {n}
          </text>
        </g>
      ))}
      {/* Darken the inner pocket band so the number ring reads as a separate band. */}
      <circle
        r={pocketBandR}
        fill="none"
        stroke="black"
        strokeOpacity={0.3}
        strokeWidth={WHEEL_R.numberInner - WHEEL_R.pocketInner}
      />
      {/* Frets between pockets */}
      {WHEEL_ORDER.map((n, i) => (
        <line
          key={n}
          x1={0}
          y1={-WHEEL_R.pocketInner}
          x2={0}
          y2={-WHEEL_R.rotorOuter}
          transform={`rotate(${pocketCenterAngle(i) + POCKET_ANGLE / 2})`}
          stroke="var(--color-champagne)"
          strokeWidth={0.55}
        />
      ))}
      <circle r={WHEEL_R.numberInner} fill="none" stroke="var(--color-champagne)" strokeWidth={0.45} opacity={0.9} />
      <circle r={WHEEL_R.rotorOuter} fill="none" stroke="var(--color-champagne)" strokeWidth={0.6} />
      {/* Cone and turret */}
      <circle r={WHEEL_R.pocketInner} fill={url(id.cone)} stroke="var(--color-champagne)" strokeWidth={0.9} />
      <circle r={WHEEL_R.cone} fill="var(--color-rotor)" stroke="var(--color-champagne-deep)" strokeWidth={0.6} />
      {[0, 45, 90, 135].map((a) => (
        <line
          key={a}
          x1={0}
          y1={-WHEEL_R.spoke}
          x2={0}
          y2={WHEEL_R.spoke}
          transform={`rotate(${a})`}
          stroke="var(--color-champagne)"
          strokeWidth={a % 90 === 0 ? 2.6 : 2}
          strokeLinecap="round"
        />
      ))}
      {Array.from({ length: 8 }, (_, k) => {
        const p = polar(WHEEL_R.spoke, k * 45);
        return <circle key={k} cx={p.x} cy={p.y} r={1.9} fill="var(--color-champagne-light)" />;
      })}
      <circle r={WHEEL_R.finial} fill={url(id.gold)} stroke="var(--color-champagne-light)" strokeWidth={1.3} />
      <circle r={3.8} fill="var(--color-champagne-deep)" />
      {/* Winning-pocket highlight: rotated onto the pocket and shown by the animator after the settle. */}
      <g ref={highlightRef} data-layer="highlight" opacity={0} visibility="hidden">
        <path
          d={POCKET_OUTLINE_PATH}
          fill="none"
          stroke="var(--color-champagne)"
          strokeOpacity={0.4}
          strokeWidth={3.4}
          strokeLinejoin="round"
        />
        <path
          d={POCKET_OUTLINE_PATH}
          fill="var(--color-champagne-pale)"
          fillOpacity={0.22}
          stroke="var(--color-champagne-pale)"
          strokeWidth={1.2}
          strokeLinejoin="round"
        />
      </g>
    </g>
  );
});

/** Stationary light sheen + rotor edge shadow, drawn above the rotor and below the ball. */
export const WheelSheen = memo(function WheelSheen({ uid }: { uid: string }) {
  const id = wheelDefIds(uid);
  return (
    <g data-layer="sheen" pointerEvents="none">
      <circle r={WHEEL_R.rotorOuter + 0.4} fill="none" stroke="black" strokeOpacity={0.35} strokeWidth={1.4} />
      <circle r={WHEEL_R.rotorOuter} fill={url(id.sheen)} />
    </g>
  );
});

/** The ball. Positioned only by the animator (`transform="translate(x y)"`). */
export const WheelBall = memo(function WheelBall({ uid, ballRef }: { uid: string; ballRef: Ref<SVGGElement> }) {
  const id = wheelDefIds(uid);
  return (
    <g ref={ballRef} data-layer="ball" pointerEvents="none">
      <circle cx={0.7} cy={1} r={BALL_SIZE} fill="black" opacity={0.45} />
      <circle r={BALL_SIZE} fill={url(id.ball)} />
    </g>
  );
});
