import { sleep } from "./sleep.ts";

const MIN_MS = Number(process.env.IG_PACE_MIN_MS ?? 800);
const MAX_MS = Number(process.env.IG_PACE_MAX_MS ?? 2500);

function between(min: number, max: number): number {
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  return Math.round(low + Math.random() * (high - low));
}

/** Human-ish gap before every UI action; the only pacing agent-browser can give us on `type`. */
export async function pace(): Promise<number> {
  const ms = between(MIN_MS, MAX_MS);
  if (ms > 0) await sleep(ms);
  return ms;
}

export async function pause(min = 1200, max = 3600): Promise<number> {
  const ms = between(min, max);
  await sleep(ms);
  return ms;
}
