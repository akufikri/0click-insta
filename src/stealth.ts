import { requireLive } from "./registry.ts";
import { evalJson, url } from "./agent.ts";
import { fail } from "./errors.ts";
import { sleep } from "./sleep.ts";

export type CdpTarget = {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
};

export async function cdpTargets(port: number): Promise<CdpTarget[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: controller.signal });
    if (!response.ok) fail("TbFailed", `CDP /json/list returned ${response.status}`);
    return (await response.json()) as CdpTarget[];
  } finally {
    clearTimeout(timer);
  }
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/** Minimal CDP client: one websocket per target, request/response by id. */
export class CdpConnection {
  socket: WebSocket;
  pending = new Map<number, Pending>();
  nextId = 1;
  closed = false;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event: MessageEvent) => {
      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "CDP error"));
      else pending.resolve(message.result ?? {});
    });
    socket.addEventListener("close", () => {
      this.closed = true;
      for (const pending of this.pending.values()) pending.reject(new Error("CDP socket closed"));
      this.pending.clear();
    });
  }

  static async connect(wsUrl: string, timeoutMs = 5_000): Promise<CdpConnection> {
    const { promise, resolve, reject } = Promise.withResolvers<CdpConnection>();
    const socket = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        // already closing
      }
      reject(new Error(`CDP connect timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(new CdpConnection(socket));
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("CDP websocket error"));
    });
    return promise;
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<T> {
    const id = this.nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    this.pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value as T);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // already closed
    }
  }
}

/** Patches the fingerprint checks read before any page script runs. */
export const STEALTH_JS = `(() => {
  const define = (target, key, value) => {
    try { Object.defineProperty(target, key, { get: () => value, configurable: true }); } catch {}
  };
  define(Navigator.prototype, 'webdriver', undefined);
  define(Navigator.prototype, 'languages', ['en-US', 'en']);
  define(Navigator.prototype, 'hardwareConcurrency', 8);
  define(Navigator.prototype, 'deviceMemory', 8);
  if (!window.chrome) {
    Object.defineProperty(window, 'chrome', {
      value: { runtime: {}, app: { isInstalled: false }, csi: () => ({}), loadTimes: () => ({}) },
      configurable: true,
    });
  }
  const plugins = [
    { name: 'PDF Viewer', filename: 'internal-pdf-viewer' },
    { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer' },
    { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer' },
  ];
  define(Navigator.prototype, 'plugins', plugins);
  const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
  if (originalQuery) {
    window.navigator.permissions.query = (parameters) =>
      parameters && parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission, onchange: null })
        : originalQuery.call(window.navigator.permissions, parameters);
  }
  const gl = WebGLRenderingContext.prototype;
  const getParameter = gl.getParameter;
  gl.getParameter = function (parameter) {
    if (parameter === 37445) return 'Apple Inc.';
    if (parameter === 37446) return 'Apple M3';
    return getParameter.call(this, parameter);
  };
  define(window, 'outerWidth', window.outerWidth || 1440);
  define(window, 'outerHeight', window.outerHeight || 900);
})();`;

export function normalizedUserAgent(raw: string): string {
  return raw
    .replace(/\s*Electron\/[\d.]+/i, "")
    .replace(/\s*terminal-browser\/[\d.]+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export type StealthReport = {
  device: string;
  userAgent: string;
  targets: number;
  applied: string[];
  failed: Array<{ url: string; error: string }>;
};

type Held = { port: number; conns: Map<string, CdpConnection>; scripts: Set<string> };
const held = new Map<string, Held>();

function heldFor(deviceId: string, port: number): Held {
  const existing = held.get(deviceId);
  if (existing && existing.port === port) return existing;
  if (existing) releaseStealth(deviceId);
  const created: Held = { port, conns: new Map(), scripts: new Set() };
  held.set(deviceId, created);
  return created;
}

export function releaseStealth(deviceId: string): void {
  const existing = held.get(deviceId);
  if (!existing) return;
  for (const connection of existing.conns.values()) connection.close();
  held.delete(deviceId);
}

/**
 * Installs the stealth script, UA, locale and headers on every real page target.
 * CDP overrides die with their websocket, so the connections stay open for the device lifetime.
 */
export async function applyStealth(deviceId: string): Promise<StealthReport> {
  const live = requireLive(deviceId);
  const raw = await evalJson<string>(deviceId, "navigator.userAgent");
  const userAgent = normalizedUserAgent(typeof raw === "string" ? raw : "");
  const all = await cdpTargets(live.cdpPort);
  const targets = all.filter((target) => target.type === "page" && /^https?:/i.test(target.url) && target.webSocketDebuggerUrl);
  const store = heldFor(deviceId, live.cdpPort);
  const report: StealthReport = { device: deviceId, userAgent, targets: targets.length, applied: [], failed: [] };
  const seen = new Set(targets.map((target) => target.id));
  for (const [id, connection] of store.conns) {
    if (seen.has(id) && !connection.closed) continue;
    connection.close();
    store.conns.delete(id);
    store.scripts.delete(id);
  }
  for (const target of targets) {
    try {
      let connection = store.conns.get(target.id);
      if (!connection || connection.closed) {
        connection = await CdpConnection.connect(target.webSocketDebuggerUrl as string);
        store.conns.set(target.id, connection);
      }
      await connection.send("Page.enable");
      if (!store.scripts.has(target.id)) {
        await connection.send("Page.addScriptToEvaluateOnNewDocument", { source: STEALTH_JS, runImmediately: true });
        store.scripts.add(target.id);
      }
      await connection.send("Emulation.setUserAgentOverride", {
        userAgent,
        acceptLanguage: "en-US,en",
        platform: "MacIntel",
      });
      await connection.send("Emulation.setLocaleOverride", { locale: "en-US" });
      await connection.send("Emulation.setTimezoneOverride", { timezoneId: process.env.IG_TZ ?? "Asia/Kuala_Lumpur" });
      await connection.send("Network.enable");
      await connection.send("Network.setExtraHTTPHeaders", {
        headers: { "Accept-Language": "en-US,en;q=0.9" },
      });
      report.applied.push(target.url);
    } catch (error) {
      report.failed.push({ url: target.url, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
}

/** Waits for a real page to exist, then applies the profile; the pane starts on about:blank. */
export async function ensureStealth(deviceId: string, attempts = 20): Promise<StealthReport> {
  let report: StealthReport = { device: deviceId, userAgent: "", targets: 0, applied: [], failed: [] };
  for (let i = 0; i < attempts; i += 1) {
    const live = requireLive(deviceId);
    const targets = (await cdpTargets(live.cdpPort)).filter(
      (target) => target.type === "page" && /^https?:/i.test(target.url),
    );
    if (targets.length > 0) {
      report = await applyStealth(deviceId);
      if (report.applied.length > 0) return report;
    }
    await sleep(500);
  }
  return report;
}

export async function stealthState(deviceId: string): Promise<{ webdriver: unknown; userAgent: string; plugins: number; location: string }> {
  const webdriver = await evalJson<unknown>(deviceId, "navigator.webdriver ?? null");
  const userAgent = await evalJson<string>(deviceId, "navigator.userAgent");
  const plugins = await evalJson<number>(deviceId, "navigator.plugins.length");
  return { webdriver, userAgent, plugins, location: await url(deviceId) };
}
