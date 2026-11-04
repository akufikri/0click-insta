import { mkdirSync } from "node:fs";
import path from "node:path";
import { devicePaths } from "./device.ts";
import { fail } from "./errors.ts";
import { devices, requireLive } from "./registry.ts";
import { S, actionArgv, type Loc, type SelectorKey } from "./selectors.ts";
import { ab, abJson, parseEnvelope, trim, type RunResult } from "./tb.ts";
import { sleep } from "./sleep.ts";

export async function act(deviceId: string, argv: string[], timeoutMs = 60_000): Promise<RunResult> {
  const live = requireLive(deviceId);
  devices.touch(deviceId);
  return ab(deviceId, live, argv, timeoutMs);
}

export async function call<T>(deviceId: string, argv: string[], timeoutMs = 60_000): Promise<T> {
  const live = requireLive(deviceId);
  devices.touch(deviceId);
  return abJson<T>(deviceId, live, argv, timeoutMs);
}

export async function evalJson<T>(deviceId: string, expression: string, timeoutMs = 60_000): Promise<T> {
  const data = await call<{ result?: T }>(deviceId, ["eval", expression], timeoutMs);
  if (data && typeof data === "object" && "result" in data) return data.result as T;
  return data as unknown as T;
}

export async function tryEval<T>(deviceId: string, expression: string): Promise<T | null> {
  try {
    return await evalJson<T>(deviceId, expression);
  } catch {
    return null;
  }
}

/** Navigates the pane's own tab; `open` would spawn a second target the human never sees. */
export async function openUrl(deviceId: string, url: string): Promise<void> {
  const result = await act(deviceId, ["goto", url], 90_000);
  if (result.code !== 0) fail("TbFailed", `could not open ${url}: ${trim(result.stderr || result.stdout)}`);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const ready = await tryEval<string>(deviceId, "document.readyState");
    if (ready === "complete" || ready === "interactive") return;
    await sleep(250);
  }
}

export async function reload(deviceId: string): Promise<void> {
  const result = await act(deviceId, ["reload"], 60_000);
  if (result.code !== 0) fail("TbFailed", `reload failed: ${trim(result.stderr || result.stdout)}`);
}

export async function press(deviceId: string, key: string): Promise<void> {
  const result = await act(deviceId, ["press", key], 30_000);
  if (result.code !== 0) fail("TbFailed", `press ${key} failed: ${trim(result.stderr || result.stdout)}`);
}

export async function pathname(deviceId: string): Promise<string> {
  const href = await evalJson<string>(deviceId, "location.pathname");
  return typeof href === "string" ? href : "";
}

export async function url(deviceId: string): Promise<string> {
  const value = await evalJson<string>(deviceId, "location.href");
  return typeof value === "string" ? value : "";
}

const VISIBLE_JS = (css: string) => `(() => {
  const nodes = Array.from(document.querySelectorAll(${JSON.stringify(css)}));
  return nodes.some((node) => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  });
})()`;

/** Runs an action against the first selector candidate that resolves and is actually on screen. */
async function firstCandidate(
  deviceId: string,
  key: SelectorKey,
  action: "click" | "fill" | "type" | "hover" | "upload",
  payload?: string | string[],
): Promise<Loc> {
  const candidates = S[key];
  let lastError = "";
  for (const loc of candidates) {
    if ("css" in loc && typeof loc.css === "string") {
      const visible = await tryEval<boolean>(deviceId, VISIBLE_JS(loc.css));
      if (visible !== true) {
        lastError = `${loc.css} is not visible`;
        continue;
      }
    }
    const argv = actionArgv(loc, action, payload);
    const result = await act(deviceId, argv, action === "upload" ? 180_000 : 45_000);
    if (result.code === 0) return loc;
    lastError = result.stderr || result.stdout;
  }
  fail("SelectorMissing", `no ${key} on screen (tried ${candidates.length} selectors): ${trim(lastError)}`, {
    selectorKey: key,
  });
}

export function click(deviceId: string, key: SelectorKey): Promise<Loc> {
  return firstCandidate(deviceId, key, "click");
}

export function fill(deviceId: string, key: SelectorKey, text: string): Promise<Loc> {
  return firstCandidate(deviceId, key, "fill", text);
}

export function typeInto(deviceId: string, key: SelectorKey, text: string): Promise<Loc> {
  return firstCandidate(deviceId, key, "type", text);
}

export function upload(deviceId: string, key: SelectorKey, files: string[]): Promise<Loc> {
  return firstCandidate(deviceId, key, "upload", files);
}

export async function clickCss(deviceId: string, css: string): Promise<void> {
  const result = await act(deviceId, ["click", css], 30_000);
  if (result.code !== 0) fail("SelectorMissing", `no element for ${css}: ${trim(result.stderr || result.stdout)}`, { css });
}

export async function exists(deviceId: string, css: string): Promise<boolean> {
  const found = await tryEval<boolean>(deviceId, `!!document.querySelector(${JSON.stringify(css)})`);
  return found === true;
}

const TEXT_CLICK = (text: string, scope: string | null) => `(() => {
  const want = ${JSON.stringify(text)}.toLowerCase();
  const norm = (value) => (value || '').replace(/\\s+/g, ' ').trim();
  const root = ${scope ? `document.querySelector(${JSON.stringify(scope)})` : "document"};
  if (!root) return { ok: false, reason: 'no scope' };
  const nodes = Array.from(root.querySelectorAll('button, div[role="button"], a, span, div, li, [role="menuitem"]'));
  const candidates = nodes
    .map((node) => ({ node, text: norm(node.textContent).toLowerCase() }))
    .filter((entry) => entry.node.offsetParent !== null && entry.text.length > 0)
    .filter((entry) => entry.text === want || entry.text.includes(want));
  if (candidates.length === 0) return { ok: false, reason: 'not found' };
  const pick = candidates.sort((a, b) => a.text.length - b.text.length)[0].node;
  pick.scrollIntoView({ block: 'center' });
  pick.click();
  return { ok: true, text: norm(pick.textContent).slice(0, 120) };
})()`;

export async function clickText(deviceId: string, text: string, scope: string | null = null): Promise<string> {
  const result = await evalJson<{ ok: boolean; text?: string; reason?: string }>(deviceId, TEXT_CLICK(text, scope));
  if (!result || result.ok !== true) {
    fail("SelectorMissing", `no clickable ${JSON.stringify(text)}${scope ? ` inside ${scope}` : ""}`, { text, scope });
  }
  return result.text ?? text;
}

export async function textPresent(deviceId: string, needle: string): Promise<boolean> {
  const result = await tryEval<boolean>(
    deviceId,
    `(document.body ? document.body.innerText : '').toLowerCase().includes(${JSON.stringify(needle.toLowerCase())})`,
  );
  return result === true;
}

export async function pageText(deviceId: string, limit = 4000): Promise<string> {
  const text = await tryEval<string>(deviceId, `(document.body ? document.body.innerText : '').slice(0, ${limit})`);
  return typeof text === "string" ? text : "";
}

export async function screenshot(deviceId: string, tool: string): Promise<string | null> {
  const dir = path.join(devicePaths(deviceId, devices.root).artifacts);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${tool}.png`);
  try {
    const result = await act(deviceId, ["screenshot", file], 45_000);
    return result.code === 0 ? file : null;
  } catch {
    return null;
  }
}

export async function waitFor<T>(
  deviceId: string,
  probe: () => Promise<T | null>,
  { timeoutMs = 30_000, intervalMs = 1_000 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!devices.live(deviceId)) return null;
    const value = await probe();
    if (value !== null) return value;
    await sleep(intervalMs);
  }
  return null;
}

export { parseEnvelope };
