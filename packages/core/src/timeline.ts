import type { AnimKeyframe, PropAnimation, PropState } from './document.js';
import { evalEase, reverseEase, splitEase, type TimingFunction } from './easing.js';
import type { Animatable, Ease, Keyframe, Track, Value } from './types.js';
import { LINEAR } from './types.js';
import type { WarningCollector } from './warnings.js';

export type Interp<T> = (a: T, b: T, t: number) => T;

export interface TimelineContext {
  /** composition duration in seconds */
  duration: number;
  fps: number;
  warnings: WarningCollector;
}

export interface TrackOptions<T extends Value> {
  /** Parse a keyframe value. `prev` is the previously parsed value of the same animation (for unwrapping). */
  parse: (s: string, prev: T | undefined) => T | null;
  base: T;
  interp: Interp<T>;
  equals?: (a: T, b: T) => boolean;
  /** When false for a pair of adjacent values, the segment becomes a hold (e.g. incompatible path morphs). */
  compatible?: (a: T, b: T) => boolean;
  label: string;
  property: string;
}


export const lerpNumber: Interp<number> = (a, b, t) => a + (b - a) * t;
export const lerpArray: Interp<number[]> = (a, b, t) => a.map((v, k) => v + ((b[k] ?? v) - v) * t);

export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Composition duration: LCM of looping periods (capped) or the end of the longest finite animation. */
export function computeDuration(anims: PropAnimation[], fps: number, maxDuration: number, warnings: WarningCollector): number {
  const periods: number[] = [];
  let finiteEnd = 0;
  for (const a of anims) {
    if (!Number.isFinite(a.iterations)) {
      const alt = a.direction === 'alternate' || a.direction === 'alternate-reverse';
      periods.push(Math.max(1, Math.round(a.duration * (alt ? 2 : 1) * fps)));
    } else finiteEnd = Math.max(finiteEnd, a.delay + a.duration * a.iterations);
  }
  let loopFrames = 0;
  if (periods.length) {
    const gcd = (x: number, y: number): number => (y ? gcd(y, x % y) : x);
    const lcm = periods.reduce((acc, p) => (acc * p) / gcd(acc, p));
    if (lcm / fps > maxDuration) {
      loopFrames = Math.max(...periods);
      warnings.add(
        'loop-mismatch',
        `Looping animations have incompatible durations (common loop ${(lcm / fps).toFixed(2)}s exceeds ${maxDuration}s); using ${(loopFrames / fps).toFixed(2)}s, so shorter loops will not line up at the seam`,
      );
    } else loopFrames = lcm;
  }
  const seconds = Math.max(loopFrames / fps, finiteEnd);
  if (seconds <= 0) return 1;
  return Math.min(Math.round(seconds * fps) / fps || 1 / fps, Math.max(maxDuration, loopFrames / fps));
}

interface LocalFrame<T> {
  offset: number;
  v: T;
  ease: Ease;
}

function expandTiming<T extends Value>(frames: { offset: number; v: T; timing: TimingFunction | 'hold' }[], interp: Interp<T>): LocalFrame<T>[] {
  const out: LocalFrame<T>[] = [];
  for (let k = 0; k < frames.length; k++) {
    const f = frames[k];
    const next = frames[k + 1];
    const timing = f.timing;
    if (!next || timing === 'hold') {
      out.push({ offset: f.offset, v: f.v, ease: timing === 'hold' ? 'hold' : LINEAR });
      continue;
    }
    const span = next.offset - f.offset;
    if (timing.kind === 'bezier') out.push({ offset: f.offset, v: f.v, ease: timing.bezier });
    else if (timing.kind === 'steps') {
      const n = timing.count;
      for (let s = 0; s < n; s++) {
        const level =
          timing.position === 'end' ? s / n : timing.position === 'start' ? (s + 1) / n : timing.position === 'none' ? (n > 1 ? s / (n - 1) : 0) : (s + 1) / (n + 1);
        out.push({ offset: f.offset + (span * s) / n, v: interp(f.v, next.v, level), ease: 'hold' });
      }
    } else {
      const pts = timing.points;
      for (let s = 0; s < pts.length - 1; s++) {
        out.push({ offset: f.offset + span * pts[s].input, v: interp(f.v, next.v, pts[s].output), ease: LINEAR });
      }
    }
  }
  return out;
}

function reversedFrames<T>(frames: LocalFrame<T>[]): LocalFrame<T>[] {
  const out: LocalFrame<T>[] = [];
  for (let k = frames.length - 1; k >= 0; k--) {
    const prevSeg = frames[k - 1];
    out.push({ offset: 1 - frames[k].offset, v: frames[k].v, ease: prevSeg ? reverseEase(prevSeg.ease) : LINEAR });
  }
  return out;
}

function isReversed(dir: PropAnimation['direction'], i: number): boolean {
  const odd = ((i % 2) + 2) % 2 === 1;
  switch (dir) {
    case 'reverse':
      return true;
    case 'alternate':
      return odd;
    case 'alternate-reverse':
      return !odd;
    default:
      return false;
  }
}

/**
 * Lottie cannot hold two values at one instant, so a jump (e.g. a loop restarting) is encoded as a hold
 * keyframe `eps` before the new value. `eps` is a small fraction of a frame so no rendered frame changes.
 */
function pushFrame<T extends Value>(out: Keyframe<T>[], kf: Keyframe<T>, equals: (a: T, b: T) => boolean, eps: number): void {
  const last = out[out.length - 1];
  if (last && Math.abs(last.t - kf.t) < 1e-6) {
    if (equals(last.v, kf.v)) {
      last.ease = kf.ease;
      return;
    }
    last.t = kf.t - eps;
    last.ease = 'hold';
    const beforeLast = out[out.length - 2];
    if (beforeLast && beforeLast.t >= last.t) out.splice(out.length - 2, 1);
  }
  out.push(kf);
}

/** Unroll one animation into keyframes on the composition timeline. Returns null if it cannot be parsed. */
export function unrollAnimation<T extends Value>(anim: PropAnimation, opts: TrackOptions<T>, ctx: TimelineContext): Keyframe<T>[] | null {
  const equals = opts.equals ?? deepEqual;
  let prev: T | undefined;
  const parsed: { offset: number; v: T; timing: AnimKeyframe['timing'] }[] = [];
  for (const kf of anim.keyframes) {
    const v = kf.value.trim() === '' ? opts.base : opts.parse(kf.value, prev);
    if (v === null) {
      ctx.warnings.add('unparseable-value', `Could not parse ${opts.property} value "${kf.value}" in ${anim.label}; animation ignored`, opts.label);
      return null;
    }
    prev = v;
    parsed.push({ offset: Math.min(1, Math.max(0, kf.offset)), v, timing: kf.timing });
  }
  parsed.sort((a, b) => a.offset - b.offset);
  if (!parsed.length) return null;
  if (anim.implicitEnds) {
    if (parsed[0].offset > 0) parsed.unshift({ offset: 0, v: opts.base, timing: parsed[0].timing });
    if (parsed[parsed.length - 1].offset < 1) parsed.push({ offset: 1, v: opts.base, timing: parsed[parsed.length - 1].timing });
  } else if (parsed[parsed.length - 1].offset < 1) {
    parsed.push({ offset: 1, v: parsed[parsed.length - 1].v, timing: 'hold' });
  }
  let local = expandTiming(parsed, opts.interp);
  if (opts.compatible) {
    local = local.map((f, k) => (local[k + 1] && !opts.compatible!(f.v, local[k + 1].v) ? { ...f, ease: 'hold' } : f));
  }
  const reversed = reversedFrames(local);

  const D = ctx.duration;
  const dur = anim.duration;
  const eps = 0.05 / ctx.fps;
  const out: Keyframe<T>[] = [];
  const infinite = !Number.isFinite(anim.iterations);
  let first = 0;
  if (infinite && anim.delay > 0) first = -Math.ceil(anim.delay / dur - 1e-9);
  if (infinite && anim.delay < 0) first = -Math.ceil(-anim.delay / dur);
  if (!infinite && anim.delay < 0) first = Math.floor(-anim.delay / dur);
  if (!infinite && anim.delay > 0) {
    const initial = isReversed(anim.direction, 0) ? reversed : local;
    out.push({ t: 0, v: anim.fillBackwards ? initial[0].v : opts.base, ease: 'hold' });
  }
  const lastIndex = infinite ? Infinity : Math.ceil(anim.iterations) - 1;
  for (let i = first; i <= lastIndex; i++) {
    const start = anim.delay + i * dur;
    if (start >= D - 1e-9 && out.length && out[out.length - 1].t >= D - 1e-9) break;
    if (start > D + dur) break;
    const frames = isReversed(anim.direction, i) ? reversed : local;
    const fraction = !infinite && i === lastIndex ? anim.iterations - i : 1;
    for (let k = 0; k < frames.length; k++) {
      const f = frames[k];
      if (f.offset > fraction + 1e-9) {
        const p = frames[k - 1];
        const x = (fraction - p.offset) / (f.offset - p.offset);
        const split = splitEase(p.ease, x);
        const prevOut = out[out.length - 1];
        prevOut.ease = split.left;
        pushFrame(out, { t: start + fraction * dur, v: p.ease === 'hold' ? p.v : opts.interp(p.v, f.v, split.y), ease: 'hold' }, equals, eps);
        break;
      }
      pushFrame(out, { t: start + f.offset * dur, v: f.v, ease: f.ease }, equals, eps);
    }
  }
  if (!infinite) {
    const end = anim.delay + anim.iterations * dur;
    out[out.length - 1].ease = 'hold';
    if (!anim.fillForwards) pushFrame(out, { t: end, v: opts.base, ease: 'hold' }, equals, eps);
  }
  return clipToTimeline(out, opts.interp, D);
}

function clipToTimeline<T extends Value>(frames: Keyframe<T>[], interp: Interp<T>, D: number): Keyframe<T>[] {
  while (frames.length > 1 && frames[1].t <= 0) frames.shift();
  if (frames.length > 1 && frames[0].t < 0) {
    const [a, b] = frames;
    const x = (0 - a.t) / (b.t - a.t);
    if (a.ease === 'hold') frames[0] = { t: 0, v: a.v, ease: 'hold' };
    else {
      const split = splitEase(a.ease, x);
      frames[0] = { t: 0, v: interp(a.v, b.v, split.y), ease: split.right };
    }
  } else if (frames.length && frames[0].t < 0) frames[0].t = 0;
  const endIdx = frames.findIndex((f) => f.t >= D - 1e-9);
  if (endIdx >= 0) frames.length = endIdx + 1;
  return frames;
}

/** Build a static-or-animated value for a property from its computed state. */
export function buildAnimatable<T extends Value>(state: PropState | undefined, opts: TrackOptions<T>, ctx: TimelineContext): Animatable<T> {
  const anims = state?.anims ?? [];
  if (!anims.length) return { static: opts.base };
  if (anims.length > 1) {
    const css = anims.filter((a) => a.source === 'css');
    ctx.warnings.add(
      'multiple-animations',
      `${anims.length} animations target ${opts.property}; only the last${css.length ? ' CSS' : ''} one is converted`,
      opts.label,
    );
  }
  const css = anims.filter((a) => a.source === 'css');
  const anim = css.length ? css[css.length - 1] : anims[anims.length - 1];
  return fromKeyframes(unrollAnimation(anim, opts, ctx), opts);
}

export function fromKeyframes<T extends Value>(frames: Keyframe<T>[] | null, opts: { base: T; equals?: (a: T, b: T) => boolean }): Animatable<T> {
  if (!frames || !frames.length) return { static: opts.base };
  const equals = opts.equals ?? deepEqual;
  if (frames.every((f) => equals(f.v, frames[0].v))) return { static: frames[0].v };
  return { track: { keyframes: frames } };
}

export function isAnimated<T extends Value>(a: Animatable<T>): a is { track: Track<T> } {
  return 'track' in a;
}

export function valueAt<T extends Value>(a: Animatable<T>, t: number, interp: Interp<T>): T {
  if (!isAnimated(a)) return a.static;
  const kfs = a.track.keyframes;
  if (t <= kfs[0].t) return kfs[0].v;
  for (let k = 0; k < kfs.length - 1; k++) {
    const p = kfs[k];
    const n = kfs[k + 1];
    if (t < n.t) return interp(p.v, n.v, evalEase(p.ease, (t - p.t) / (n.t - p.t)));
  }
  return kfs[kfs.length - 1].v;
}

export function mapAnimatable<T extends Value, U extends Value>(a: Animatable<T>, fn: (v: T) => U): Animatable<U> {
  if (!isAnimated(a)) return { static: fn(a.static) };
  return { track: { keyframes: a.track.keyframes.map((k) => ({ t: k.t, v: fn(k.v), ease: k.ease })) } };
}

export interface CombineInput {
  value: Animatable;
  interp: Interp<Value>;
}

function sameTiming(a: Track, b: Track): boolean {
  return (
    a.keyframes.length === b.keyframes.length &&
    a.keyframes.every((k, i) => Math.abs(k.t - b.keyframes[i].t) < 1e-6 && deepEqual(k.ease, b.keyframes[i].ease))
  );
}

/**
 * Derive one animatable from several (e.g. Lottie rect position from x/y/width/height). Exact when at most
 * one input is animated or all share keyframe timing; otherwise sampled once per frame.
 */
export function combine<U extends Value>(inputs: CombineInput[], fn: (vals: Value[]) => U, ctx: TimelineContext, label: string): Animatable<U> {
  const animated = inputs.filter((i) => isAnimated(i.value));
  if (!animated.length) return { static: fn(inputs.map((i) => (i.value as { static: Value }).static)) };
  const lead = (animated[0].value as { track: Track }).track;
  if (animated.every((i) => sameTiming((i.value as { track: Track }).track, lead))) {
    return {
      track: {
        keyframes: lead.keyframes.map((k, idx) => ({
          t: k.t,
          ease: k.ease,
          v: fn(inputs.map((i) => (isAnimated(i.value) ? i.value.track.keyframes[idx].v : i.value.static))),
        })),
      },
    };
  }
  ctx.warnings.info('sampled', `Properties with different keyframe timing were combined by sampling every frame`, label);
  const times = new Set<number>();
  let minT = Infinity;
  let maxT = -Infinity;
  for (const i of animated) {
    for (const k of (i.value as { track: Track }).track.keyframes) {
      times.add(k.t);
      minT = Math.min(minT, k.t);
      maxT = Math.max(maxT, k.t);
    }
  }
  for (let f = Math.ceil(minT * ctx.fps); f / ctx.fps < maxT; f++) times.add(f / ctx.fps);
  const sorted = [...times].sort((a, b) => a - b);
  return {
    track: {
      keyframes: sorted.map((t) => ({ t, ease: LINEAR, v: fn(inputs.map((i) => valueAt(i.value, t, i.interp))) })),
    },
  };
}
