export type Vec2 = [number, number];

/** A cubic-bezier easing for the segment that starts at a keyframe. */
export interface Bezier {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type Ease = Bezier | 'hold';

export const LINEAR: Bezier = { x1: 0, y1: 0, x2: 1, y2: 1 };

/** Cubic path in absolute coordinates, tangents relative to their vertex (Lottie convention). */
export interface BezierPath {
  v: Vec2[];
  i: Vec2[];
  o: Vec2[];
  c: boolean;
}

export type PathData = BezierPath[];

export interface TransformComponents {
  anchor: Vec2;
  position: Vec2;
  /** degrees */
  rotation: number;
  /** percent */
  scale: Vec2;
  /** degrees, Lottie convention (skewX(φ) ⇔ sk = -φ, sa = 0) */
  skew: number;
  skewAxis: number;
}

export type Value = number | number[] | PathData | TransformComponents;

export interface Keyframe<T extends Value = Value> {
  /** seconds on the composition timeline */
  t: number;
  v: T;
  /** easing from this keyframe to the next */
  ease: Ease;
}

export interface Track<T extends Value = Value> {
  keyframes: Keyframe<T>[];
}

export type Animatable<T extends Value = Value> = { static: T } | { track: Track<T> };

export type WarningSeverity = 'info' | 'warning' | 'error';

export interface ConversionWarning {
  code: string;
  message: string;
  severity: WarningSeverity;
  /** e.g. `rect#morph-core` */
  element?: string;
}

export interface ConvertOptions {
  /** Output frame rate (default 60). */
  fps?: number;
  /** Composition name (default: svg title/id or "svg2lottie"). */
  name?: string;
  /** Cap for the unrolled composition duration in seconds (default 30). */
  maxDuration?: number;
  /** Decimal places kept in the output (default 3). */
  precision?: number;
  /** Emit Lottie Gaussian Blur effects for SVG blur filters (default true). */
  blur?: boolean;
}

export interface ConversionStats {
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  frames: number;
  layers: number;
  animatedProperties: number;
  keyframes: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LottieAnimation = Record<string, any>;

export interface ConversionResult {
  animation: LottieAnimation;
  warnings: ConversionWarning[];
  stats: ConversionStats;
}
