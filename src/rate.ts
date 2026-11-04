import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { devicePaths } from "./device.ts";
import { fail } from "./errors.ts";
import { devices } from "./registry.ts";

export type ActionName =
  | "follow"
  | "unfollow"
  | "like"
  | "comment"
  | "post"
  | "dm"
  | "story"
  | "read"
  | "login";

export const DEFAULT_LIMITS: Record<ActionName, number> = {
  follow: 20,
  unfollow: 20,
  like: 60,
  comment: 10,
  post: 5,
  dm: 20,
  story: 10,
  read: 240,
  login: 10,
};

const WINDOW_MS = 60 * 60 * 1000;

export type RateState = Record<string, number[]>;

export class RateLimiter {
  root: string;
  limits: Record<ActionName, number>;

  constructor(root = devices.root, limits: Partial<Record<ActionName, number>> = {}) {
    this.root = root;
    this.limits = { ...DEFAULT_LIMITS };
    for (const [action, fallback] of Object.entries(DEFAULT_LIMITS) as Array<[ActionName, number]>) {
      const override = Number(process.env[`IG_LIMIT_${action.toUpperCase()}`]);
      this.limits[action] = Number.isFinite(override) && override > 0 ? override : fallback;
    }
    Object.assign(this.limits, limits);
  }

  read(deviceId: string): RateState {
    const file = path.join(devicePaths(deviceId, this.root).dir, "actions.json");
    if (!existsSync(file)) return {};
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as RateState;
      const out: RateState = {};
      for (const [action, stamps] of Object.entries(parsed)) {
        if (Array.isArray(stamps)) out[action] = stamps.filter((stamp) => typeof stamp === "number");
      }
      return out;
    } catch {
      return {};
    }
  }

  write(deviceId: string, state: RateState): void {
    const dir = devicePaths(deviceId, this.root).dir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "actions.json"), `${JSON.stringify(state, null, 2)}\n`);
  }

  /** Throws instead of silently sleeping: the caller decides whether to wait. */
  check(deviceId: string, action: ActionName, now = Date.now()): void {
    const limit = this.limits[action];
    const stamps = (this.read(deviceId)[action] ?? []).filter((stamp) => now - stamp < WINDOW_MS);
    if (stamps.length < limit) return;
    const retryAt = new Date(Math.min(...stamps) + WINDOW_MS).toISOString();
    fail("RateLimited", `${action} limit reached for ${deviceId} (${limit}/hour, retry after ${retryAt})`, {
      action,
      limit,
      retryAt,
    });
  }

  commit(deviceId: string, action: ActionName, now = Date.now()): void {
    const state = this.read(deviceId);
    const stamps = (state[action] ?? []).filter((stamp) => now - stamp < WINDOW_MS);
    stamps.push(now);
    state[action] = stamps;
    this.write(deviceId, state);
  }
}

export const rate = new RateLimiter();
