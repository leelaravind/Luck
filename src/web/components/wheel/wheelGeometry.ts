/**
 * WHEEL GEOMETRY — radii and path helpers for the SVG wheel (pure, no DOM).
 * The SVG is drawn around the origin: viewBox is centred on (0, 0) and the housing radius is ~100 units,
 * so it scales with its container without any JS resize handling.
 */
import { POCKET_ANGLE } from './wheelMath';

/** Centred viewBox with a little room for the housing's drop shadow. */
export const VIEWBOX = '-106 -106 212 212';

/** Radii in SVG user units (outer → inner). */
export const WHEEL_R = Object.freeze({
  /** Walnut bowl (stationary housing). */
  housing: 99,
  /** Polished champagne rim ring. */
  rim: 94.5,
  /** Steel ball track (the ball rolls on it during the orbit). */
  trackOuter: 91,
  trackInner: 79,
  /** Lower sloped track carrying the 8 diamond deflectors. */
  deflector: 74.5,
  /** Outer edge of the rotor (number ring). */
  rotorOuter: 69.5,
  /** Boundary between the number band (outside) and the pocket band (inside). */
  numberInner: 57.5,
  /** Radius of the number labels (centre of the number band). */
  label: 63.4,
  /** Inner edge of the pockets; the cone starts here. */
  pocketInner: 46,
  /** Turret cone disc. */
  cone: 34,
  /** Turret spoke half-length. */
  spoke: 29,
  /** Gold finial. */
  finial: 10.5,
});

/** Visual radius of the ball itself. */
export const BALL_SIZE = 3.1;

/** Ball centre radius while rolling on the track (normalised radius 0). */
export const BALL_TRACK_R = (WHEEL_R.trackOuter + WHEEL_R.trackInner) / 2;
/** Ball centre radius while resting in a pocket (normalised radius 1). */
export const BALL_POCKET_R = (WHEEL_R.numberInner + WHEEL_R.pocketInner) / 2 + 0.3;

/** Absolute angle where the ball waits on the track before the very first spin. */
export const BALL_REST_ANGLE = 32;

/** Map the normalised ball radius from `sampleSpin` (0 track … 1 pocket) to SVG units. */
export function ballRadiusToSvg(normalised: number): number {
  const n = normalised < 0 ? 0 : normalised > 1 ? 1 : normalised;
  return BALL_TRACK_R + (BALL_POCKET_R - BALL_TRACK_R) * n;
}

/** Polar → cartesian with angles clockwise from 12 o'clock (SVG y axis points down). */
export function polar(r: number, deg: number): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180;
  return { x: r * Math.sin(rad), y: -r * Math.cos(rad) };
}

/** Inverse of `polar`: angle in [0, 360) clockwise from 12 o'clock. */
export function angleOfPoint(x: number, y: number): number {
  const deg = (Math.atan2(x, -y) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

const f = (n: number) => Number(n.toFixed(3));

/** Annular sector centred on 12 o'clock spanning ±halfAngle degrees (rotate it into place). */
export function annularSectorPath(rInner: number, rOuter: number, halfAngleDeg: number): string {
  const o1 = polar(rOuter, -halfAngleDeg);
  const o2 = polar(rOuter, halfAngleDeg);
  const i2 = polar(rInner, halfAngleDeg);
  const i1 = polar(rInner, -halfAngleDeg);
  return [
    `M ${f(o1.x)} ${f(o1.y)}`,
    `A ${rOuter} ${rOuter} 0 0 1 ${f(o2.x)} ${f(o2.y)}`,
    `L ${f(i2.x)} ${f(i2.y)}`,
    `A ${rInner} ${rInner} 0 0 0 ${f(i1.x)} ${f(i1.y)}`,
    'Z',
  ].join(' ');
}

/**
 * One pocket wedge (number band + pocket band). A hair wider than a pocket so neighbouring wedges
 * overlap under the frets instead of leaving anti-aliasing seams.
 */
export const WEDGE_PATH = annularSectorPath(WHEEL_R.pocketInner, WHEEL_R.rotorOuter, POCKET_ANGLE / 2 + 0.08);

/** Exact outline of one pocket, used by the winning-pocket highlight. */
export const POCKET_OUTLINE_PATH = annularSectorPath(WHEEL_R.pocketInner, WHEEL_R.rotorOuter, POCKET_ANGLE / 2);
