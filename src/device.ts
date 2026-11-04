import { readFileSync, mkdirSync, rmSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fail } from "./errors.ts";

export type DeviceMeta = {
  id: string;
  createdAt: string;
  lastUsed: string | null;
  url: string;
  browserKey?: string;
  handle?: string;
  socksPort?: number;
};

export type LiveBrowser = {
  key: string;
  pid: number;
  cdpPort: number;
  tty: string | null;
  url: string;
  startedAt: number;
};

export const HOME = "https://www.instagram.com";
export const DEFAULT_ROOT = process.env.IG_PROFILE_ROOT
  ? path.resolve(process.env.IG_PROFILE_ROOT)
  : path.join(os.homedir(), ".0click", "instagram");

const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

export function assertDeviceId(id: string): string {
  if (!ID_RE.test(id)) fail("InvalidDeviceId", `invalid device id ${JSON.stringify(id)} (allowed: A-Z a-z 0-9 _ -, 1-32 chars)`);
  return id;
}

export function deviceDir(id: string, root = DEFAULT_ROOT): string {
  return path.join(root, "devices", assertDeviceId(id));
}

export function devicePaths(id: string, root = DEFAULT_ROOT) {
  const dir = deviceDir(id, root);
  return {
    dir,
    meta: path.join(dir, "meta.json"),
    appdata: path.join(dir, "appdata"),
    state: path.join(dir, "state"),
    data: path.join(dir, "data"),
    run: path.join(dir, "run"),
    agent: path.join(dir, "agent"),
    actions: path.join(dir, "actions.json"),
    artifacts: path.join(dir, "artifacts"),
  };
}

/** Everything terminal-browser and agent-browser read, so one device owns one daemon, one cookie jar, one session namespace. */
export function deviceEnv(id: string, root = DEFAULT_ROOT): Record<string, string> {
  const p = devicePaths(id, root);
  return {
    XDG_STATE_HOME: p.state,
    XDG_DATA_HOME: p.data,
    XDG_RUNTIME_DIR: p.run,
    TERMINAL_BROWSER_APPDATA: p.appdata,
    AGENT_BROWSER_SOCKET_DIR: p.agent,
  };
}

export class DeviceManager {
  root: string;
  locks = new Map<string, Promise<unknown>>();

  constructor(root = DEFAULT_ROOT) {
    this.root = root;
  }

  list(): DeviceMeta[] {
    const base = path.join(this.root, "devices");
    if (!existsSync(base)) return [];
    const out: DeviceMeta[] = [];
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        out.push(this.meta(entry.name));
      } catch {
        // half-written device dirs are not devices
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  create(id: string, url = HOME, socksPort?: number): DeviceMeta {
    assertDeviceId(id);
    const p = devicePaths(id, this.root);
    if (existsSync(p.meta)) fail("DeviceExists", `device ${id} already exists`);
    for (const dir of [p.dir, p.appdata, p.state, p.data, p.run, p.agent, p.artifacts]) mkdirSync(dir, { recursive: true });
    const meta: DeviceMeta = { id, createdAt: new Date().toISOString(), lastUsed: null, url };
    if (socksPort) meta.socksPort = socksPort;
    writeFileSync(p.meta, `${JSON.stringify(meta, null, 2)}\n`);
    return meta;
  }

  remove(id: string, confirm: boolean): void {
    const p = devicePaths(id, this.root);
    if (!existsSync(p.dir)) fail("InvalidDeviceId", `device ${id} does not exist`);
    if (confirm !== true) fail("ConfirmRequired", `device_delete ${id} needs confirm:true — it deletes cookies and profile`);
    rmSync(p.dir, { recursive: true, force: true });
    this.locks.delete(id);
  }

  meta(id: string): DeviceMeta {
    const p = devicePaths(id, this.root);
    try {
      return JSON.parse(readFileSync(p.meta, "utf8")) as DeviceMeta;
    } catch {
      fail("InvalidDeviceId", `device ${id} does not exist (create it with device_create)`);
    }
  }

  save(id: string, patch: Partial<DeviceMeta>): DeviceMeta {
    const meta = { ...this.meta(id), ...patch, id };
    writeFileSync(devicePaths(id, this.root).meta, `${JSON.stringify(meta, null, 2)}\n`);
    return meta;
  }

  touch(id: string): void {
    try {
      this.save(id, { lastUsed: new Date().toISOString() });
    } catch {
      // a device removed mid-flight does not need a timestamp
    }
  }

  /** Serialise actions per device; different devices run in parallel. */
  async exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.locks.set(
      id,
      next.catch(() => undefined),
    );
    return next;
  }

  registryDb(id: string): string | null {
    const data = devicePaths(id, this.root).data;
    if (!existsSync(data)) return null;
    for (const entry of readdirSync(data, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("terminal-browser")) continue;
      const db = path.join(data, entry.name, "terminal-browser.db");
      if (existsSync(db)) return db;
    }
    return null;
  }

  /** Live browser of this device, straight from terminal-browser's own registry. */
  live(id: string): LiveBrowser | null {
    const db = this.registryDb(id);
    if (!db) return null;
    let rows: Array<Record<string, unknown>> = [];
    try {
      const conn = new DatabaseSync(db, { readOnly: true });
      try {
        conn.exec("PRAGMA busy_timeout = 2000");
        rows = conn.prepare("SELECT key, pid, tty, cdp_port, url, started_at FROM instances ORDER BY started_at DESC").all() as Array<Record<string, unknown>>;
      } finally {
        conn.close();
      }
    } catch {
      return null;
    }
    for (const row of rows) {
      const pid = Number(row.pid);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      if (!alive(pid)) continue;
      const cdpPort = Number(row.cdp_port);
      if (!Number.isInteger(cdpPort) || cdpPort <= 0) continue;
      return {
        key: String(row.key),
        pid,
        cdpPort,
        tty: row.tty === null || row.tty === undefined ? null : String(row.tty),
        url: String(row.url ?? ""),
        startedAt: Number(row.started_at ?? 0),
      };
    }
    return null;
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
