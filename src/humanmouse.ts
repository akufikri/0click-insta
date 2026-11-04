export type Point = { x: number; y: number };
export type CursorStep = Point & { delayMs: number };

export type TrajectoryOptions = {
  seed?: number;
  steps?: number;
  /** How far the curve bows away from the straight line, as a fraction of the distance. */
  curvature?: number;
  /** Pixel noise added to the curve so two runs never share a shape. */
  jitter?: number;
  /** Extra pixels travelled past the target before it is corrected. */
  overshoot?: number;
};

/** Small deterministic PRNG so a trajectory can be replayed and tested. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

/** Smoothstep: slow start, fast middle, slow landing — the shape of a hand moving a mouse. */
function ease(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped * clamped * (3 - 2 * clamped);
}

function cubic(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

/**
 * Builds a human-shaped path from CSR-S (cursor start) to the click target:
 * a bowed cubic Bézier with per-run jitter, eased timing, one or two micro-pauses,
 * a small overshoot and a final correction onto the exact point.
 */
export function planTrajectory(from: Point, to: Point, options: TrajectoryOptions = {}): CursorStep[] {
  const random = mulberry32(options.seed ?? Math.floor(Math.random() * 2 ** 31));
  const span = distance(from, to);
  const steps = Math.max(8, options.steps ?? Math.round(Math.min(64, 14 + span / 12)));
  const curvature = options.curvature ?? 0.18;
  const jitter = options.jitter ?? 1.6;
  const overshoot = options.overshoot ?? Math.min(9, Math.max(2, span * 0.02));

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const norm = span || 1;
  const perpX = -dy / norm;
  const perpY = dx / norm;
  const bow = (random() * 0.6 + 0.7) * curvature * span * (random() < 0.5 ? -1 : 1);

  const overshootAt = { x: to.x + (dx / norm) * overshoot, y: to.y + (dy / norm) * overshoot };
  const p1 = { x: from.x + dx * 0.28 + perpX * bow, y: from.y + dy * 0.28 + perpY * bow };
  const p2 = { x: from.x + dx * 0.72 + perpX * bow * 0.55, y: from.y + dy * 0.72 + perpY * bow * 0.55 };

  const pauseAt = new Set([Math.floor(steps * (0.25 + random() * 0.2)), Math.floor(steps * (0.62 + random() * 0.2))]);
  const path: CursorStep[] = [];

  for (let i = 0; i <= steps; i += 1) {
    const t = ease(i / steps);
    const point = cubic(from, p1, p2, overshootAt, t);
    const wobble = i === 0 || i === steps ? 0 : (random() - 0.5) * jitter * 2;
    const drift = i === 0 || i === steps ? 0 : (random() - 0.5) * jitter;
    const base = 6 + random() * 11;
    const delayMs = Math.round(pauseAt.has(i) ? base + 55 + random() * 110 : base);
    path.push({
      x: Number((point.x + perpX * wobble + drift).toFixed(2)),
      y: Number((point.y + perpY * wobble - drift).toFixed(2)),
      delayMs,
    });
  }

  // land exactly on the target: people correct the last few pixels
  path.push({ x: from.x, y: from.y, delayMs: 0 });
  path.splice(1, 1);
  path[path.length - 1] = { x: to.x, y: to.y, delayMs: 70 + Math.round(random() * 90) };
  return path;
}

/** Starting cursor position somewhere around the widget, not on top of the target. */
export function planApproach(from: Point, to: Point, options: TrajectoryOptions = {}): CursorStep[] {
  return planTrajectory(from, to, options);
}
