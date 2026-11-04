import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_ROOT, DeviceManager, HOME, alive, deviceEnv, devicePaths, type LiveBrowser } from "./device.ts";
import { fail } from "./errors.ts";

export type RunResult = { code: number; stdout: string; stderr: string };

const CASKROOT = "/opt/homebrew/Caskroom/terminal-browser";

/** terminal-browser ships its own agent-browser; the Homebrew one is a different version and skips the CDP path. */
export function agentBrowserBin(): string {
  const override = process.env.AGENT_BROWSER_BIN ?? process.env.TERMINAL_BROWSER_AGENT;
  if (override && existsSync(override)) return override;
  if (existsSync(CASKROOT)) {
    const candidates = readdirSync(CASKROOT)
      .filter((name) => existsSync(path.join(CASKROOT, name, "terminal-browser", "agent-browser", "bin", "agent-browser")))
      .sort(compareVersions);
    const newest = candidates.at(-1);
    if (newest) return path.join(CASKROOT, newest, "terminal-browser", "agent-browser", "bin", "agent-browser");
  }
  return "agent-browser";
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const delta = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export function sessionName(deviceId: string): string {
  return `0click-${deviceId}`;
}

export async function spawnCollect(
  command: string,
  args: string[],
  options: { env?: Record<string, string | undefined>; timeoutMs?: number; cwd?: string } = {},
): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const { promise, resolve, reject } = Promise.withResolvers<RunResult>();
  const child = spawn(command, args, {
    env: { ...process.env, ...options.env },
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }, timeoutMs);
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  child.on("error", (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    reject(error);
  });
  child.on("close", (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (signal === "SIGKILL" && timeoutMs > 0) {
      reject(fail("TbTimeout", `${path.basename(command)} ${args.slice(0, 3).join(" ")} timed out after ${timeoutMs}ms`));
      return;
    }
    resolve({ code: code ?? 1, stdout, stderr });
  });
  return promise;
}

/** agent-browser against a live terminal-browser instance, always pinned to its CDP port. */
export async function ab(deviceId: string, live: LiveBrowser, args: string[], timeoutMs = 60_000): Promise<RunResult> {
  const bin = agentBrowserBin();
  const env = { ...deviceEnv(deviceId), TERM: "dumb" };
  const base = ["--session", sessionName(deviceId), "--cdp", String(live.cdpPort), ...args];
  let result = await spawnCollect(bin, base, { env, timeoutMs });
  if (result.code === 0) return result;
  const retriable = /Chrome not found|Auto-launch failed|connect|ECONNREFUSED|not connected|No such session|Target closed/i.test(
    `${result.stdout}\n${result.stderr}`,
  );
  if (!retriable) return result;
  const connect = await spawnCollect(
    bin,
    ["--session", sessionName(deviceId), "connect", String(live.cdpPort), "--json"],
    { env, timeoutMs: 20_000 },
  );
  if (connect.code !== 0) return result;
  return spawnCollect(bin, base, { env, timeoutMs });
}

export async function abJson<T>(deviceId: string, live: LiveBrowser, args: string[], timeoutMs = 60_000): Promise<T> {
  const result = await ab(deviceId, live, [...args, "--json"], timeoutMs);
  if (result.code !== 0) {
    fail("TbFailed", `agent-browser ${args.slice(0, 2).join(" ")} failed: ${trim(result.stderr || result.stdout)}`, {
      stderr: trim(result.stderr),
      stdout: trim(result.stdout),
    });
  }
  return parseEnvelope(result.stdout) as T;
}

export function parseEnvelope(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) fail("TbNonJson", "agent-browser printed nothing");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("TbNonJson", `agent-browser printed non-JSON: ${text.slice(0, 300)}`);
  }
  const envelope = parsed as { success?: boolean; data?: unknown; error?: { message?: string } | null };
  if (envelope && typeof envelope === "object" && "success" in envelope) {
    if (envelope.success === false) {
      fail("TbFailed", envelope.error?.message ?? `agent-browser error: ${text.slice(0, 300)}`);
    }
    return envelope.data;
  }
  return parsed;
}

export function trim(text: string, limit = 600): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Closes the device's browser through its own daemon, then makes sure the process is gone. */
export async function shutdownDevice(
  deviceId: string,
  root = DEFAULT_ROOT,
): Promise<{ stopped: boolean; pid: number | null }> {
  const manager = new DeviceManager(root);
  const live = manager.live(deviceId);
  if (!live) return { stopped: false, pid: null };
  const env = { ...deviceEnv(deviceId, root), TERM: "dumb" };
  await spawnCollect(process.env.TERMINAL_BROWSER_BIN ?? "terminal-browser", ["shutdown"], { env, timeoutMs: 15_000 }).catch(
    () => null,
  );
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (!alive(live.pid)) return { stopped: true, pid: live.pid };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  try {
    process.kill(live.pid, "SIGTERM");
  } catch {
    // already gone
  }
  const finalDeadline = Date.now() + 5_000;
  while (Date.now() < finalDeadline && alive(live.pid)) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { stopped: !alive(live.pid), pid: live.pid };
}

export type PaneStartResult = { blocks: string[]; command: string };

export function ternBin(): string | null {
  const explicit = process.env.TERN_BIN;
  if (explicit && existsSync(explicit)) return explicit;
  const fromEnv = process.env.TERN_EXE;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const candidate of ["/Applications/Tern.app/Contents/MacOS/tern", path.join(os.homedir(), ".local", "bin", "tern")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function paneCommand(deviceId: string, root = DEFAULT_ROOT): string {
  const meta = JSON.parse(readFileSync(devicePaths(deviceId, root).meta, "utf8")) as {
    url?: string;
    socksPort?: number;
  };
  const env = deviceEnv(deviceId, root);
  const exports = Object.entries(env)
    .map(([key, value]) => `${key}=${shQuote(value)}`)
    .join(" ");
  const flags = meta.socksPort ? ` --socks-port=${meta.socksPort}` : "";
  return `exec env ${exports} terminal-browser open ${shQuote(meta.url ?? HOME)}${flags}`;
}

/** Opens the device pane inside the terminal the MCP itself runs in (Tern), else tells the caller what to type. */
export async function openPane(deviceId: string, root = DEFAULT_ROOT): Promise<PaneStartResult | null> {
  const bin = ternBin();
  if (!bin || !process.env.TERN_PANE) return null;
  const script = paneCommand(deviceId, root);
  const result = await spawnCollect(bin, ["split", "@focused", "right", "--json", "--", "/bin/sh", "-c", script], {
    timeoutMs: 25_000,
  });
  if (result.code !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as { block?: number | string };
    return { blocks: parsed.block === undefined ? [] : [String(parsed.block)], command: script };
  } catch {
    return null;
  }
}
