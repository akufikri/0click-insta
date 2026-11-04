import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DeviceManager, deviceEnv, devicePaths } from "../src/device.ts";
import { IgError } from "../src/errors.ts";
import { hasSessionCookie, post, toUrl } from "../src/ig.ts";
import { RateLimiter } from "../src/rate.ts";
import { S, actionArgv } from "../src/selectors.ts";
import { GUIDE_NAMES, GUIDES, TOOL_COVERAGE } from "../src/guidelines.ts";
import { mapFile, renderIndex, renderMap } from "../src/mapdoc.ts";
import { classify, type ProbeFlags } from "../src/challenge.ts";
import { parseSiteKey } from "../src/captcha.ts";
import { normalizedUserAgent } from "../src/stealth.ts";
import { planTrajectory } from "../src/humanmouse.ts";
import { inspectableScreens, renderInspectReport, resolveScreenUrl, screenKeys } from "../src/inspector.ts";
import { paneCommand } from "../src/tb.ts";

const root = path.join(os.tmpdir(), `0click-smoke-${process.pid}`);
rmSync(root, { recursive: true, force: true });

let passed = 0;
const checks: string[] = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    checks.push(`ok   ${name}`);
  } catch (error) {
    checks.push(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    process.stdout.write(`${checks.join("\n")}\n`);
    rmSync(root, { recursive: true, force: true });
    process.exit(1);
  }
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof IgError, `expected IgError, got ${String(error)}`);
    assert.equal(error.code, code);
    return;
  }
  assert.fail(`expected ${code}, but nothing was thrown`);
}

await test("deviceEnv keeps every isolation env var under the device dir", () => {
  const env = deviceEnv("acc-1", root);
  const base = path.join(root, "devices", "acc-1");
  for (const key of ["XDG_STATE_HOME", "TERMINAL_BROWSER_APPDATA", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "AGENT_BROWSER_SOCKET_DIR"] as const) {
    assert.ok(env[key].startsWith(base), `${key} not under ${base}`);
  }
  assert.equal(new Set(Object.values(env)).size, 5, "device dirs must be distinct");
  expectCode(() => deviceEnv("../x", root), "InvalidDeviceId");
});

await test("toUrl maps shortcodes, keeps URLs, rejects junk", () => {
  assert.equal(toUrl("CxYz123"), "https://www.instagram.com/p/CxYz123/");
  assert.equal(toUrl("https://www.instagram.com/reel/AbC/"), "https://www.instagram.com/reel/AbC/");
  expectCode(() => toUrl("bukan url"), "BadTarget");
  expectCode(() => toUrl("https://example.com/p/abc"), "BadTarget");
});

await test("rate limiter blocks the third hit over a limit of two", () => {
  const limiter = new RateLimiter(root, { like: 2 });
  const device = "rate-1";
  mkdirSync(devicePaths(device, root).dir, { recursive: true });
  const now = Date.now();
  limiter.commit(device, "like", now);
  limiter.commit(device, "like", now + 1);
  let retryAt = "";
  try {
    limiter.check(device, "like", now + 2);
  } catch (error) {
    assert.ok(error instanceof IgError);
    assert.equal(error.code, "RateLimited");
    retryAt = String(error.details.retryAt ?? "");
  }
  assert.ok(retryAt.length > 0, "no retryAt in the error");
  assert.ok(Date.parse(retryAt) > now, "retryAt must be in the future");
  limiter.check(device, "like", now + 60 * 60 * 1000 + 10);
});

await test("live() reads terminal-browser's registry and skips dead pids", () => {
  const manager = new DeviceManager(root);
  const id = "live-1";
  manager.create(id);
  const dir = path.join(devicePaths(id, root).data, "terminal-browser-abc12345");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "terminal-browser.db"));
  db.exec(
    "CREATE TABLE instances (key TEXT PRIMARY KEY, pid INTEGER NOT NULL, tty TEXT, socket TEXT NOT NULL, cdp_port INTEGER, url TEXT NOT NULL DEFAULT '', started_at INTEGER NOT NULL)",
  );
  const insert = db.prepare(
    "INSERT INTO instances (key, pid, tty, socket, cdp_port, url, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run("dead-1", 999_999, null, "/tmp/dead.sock", 4111, "https://www.instagram.com/", Date.now());
  insert.run("live-1", process.pid, "/dev/ttys999", "/tmp/live.sock", 49348, "https://www.instagram.com/", Date.now() - 1_000);
  db.close();
  const live = manager.live(id);
  assert.ok(live, "expected a live browser");
  assert.equal(live?.key, "live-1");
  assert.equal(live?.cdpPort, 49348);
  assert.equal(new DeviceManager(root).live("no-such-device"), null);
});

await test("session cookie detection", () => {
  assert.equal(hasSessionCookie([{ name: "sessionid", domain: ".instagram.com", value: "x" }]), true);
  assert.equal(hasSessionCookie([{ name: "csrftoken", domain: ".instagram.com", value: "x" }]), false);
  assert.equal(hasSessionCookie([{ name: "sessionid", domain: ".example.com", value: "x" }]), false);
});

await test("locators translate to agent-browser argv", () => {
  assert.deepEqual(actionArgv({ css: 'input[type="file"]' }, "upload", ["/tmp/a.jpg"]), [
    "upload",
    'input[type="file"]',
    "/tmp/a.jpg",
  ]);
  assert.deepEqual(actionArgv({ find: "text", value: "Next" }, "click"), ["find", "text", "Next", "click"]);
  assert.deepEqual(actionArgv({ find: "label", value: "Password" }, "fill", "secret"), [
    "find",
    "label",
    "Password",
    "fill",
    "secret",
  ]);
});

await test("challenge classification covers cloudflare, captcha, checkpoint and limits", () => {
  const base: ProbeFlags = {
    cloudflare: false,
    turnstile: false,
    recaptcha: false,
    hcaptcha: false,
    arkose: false,
    title: "",
    url: "https://www.instagram.com/",
    text: "",
  };
  assert.equal(classify({ ...base, cloudflare: true }, base.url, "Just a moment..."), "cloudflare");
  assert.equal(classify({ ...base, turnstile: true }, base.url, "Verify you are human"), "turnstile");
  assert.equal(classify({ ...base, hcaptcha: true }, base.url, ""), "hcaptcha");
  assert.equal(classify(base, "https://www.instagram.com/challenge/12345/", ""), "ig-checkpoint");
  assert.equal(classify(base, base.url, "Please wait a few minutes before you try again."), "ig-rate-limit");
  assert.equal(classify(base, base.url, "home feed"), "none");
});

await test("captcha sitekey parsing", () => {
  assert.deepEqual(parseSiteKey('<div class="g-recaptcha" data-sitekey="6Lc-AbCdEf"></div>', "https://x/"), {
    kind: "recaptcha",
    sitekey: "6Lc-AbCdEf",
    pageUrl: "https://x/",
  });
  assert.equal(
    parseSiteKey('src="https://www.google.com/recaptcha/api2/anchor?ar=1&k=6LcZZZZZZZZ"', "https://x/")?.sitekey,
    "6LcZZZZZZZZ",
  );
  assert.equal(
    parseSiteKey('src="https://challenges.cloudflare.com/turnstile/v0/api.js?sitekey=0x4AAA111"', "https://x/")?.kind,
    "turnstile",
  );
  assert.equal(parseSiteKey("<html>no captcha here</html>", "https://x/"), null);
});

await test("user agent loses the Electron and terminal-browser tokens", () => {
  const raw =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) terminal-browser/0.11.1 Chrome/140.0.7339.82 Electron/38.2.0 Safari/537.36";
  const cleaned = normalizedUserAgent(raw);
  assert.ok(!/Electron/i.test(cleaned));
  assert.ok(!/terminal-browser/i.test(cleaned));
  assert.ok(/Chrome\/140/.test(cleaned));
});

await test("post rejects missing media before touching the browser", async () => {
  const manager = new DeviceManager(root);
  manager.create("post-1");
  const error = await post("post-1", [path.join(root, "nope.jpg")], "x", "photo").then(
    () => null,
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof IgError, `expected IgError, got ${String(error)}`);
  assert.equal(error.code, "BadTarget");
});

await test("mapping/ is generated from src/guidelines.ts and its keys exist", () => {
  const root = path.join(import.meta.dirname, "..", "mapping");
  for (const flow of GUIDE_NAMES) {
    const onDisk = readFileSync(path.join(root, mapFile(flow)), "utf8");
    assert.equal(onDisk, renderMap(flow), `${mapFile(flow)} is stale — run npm run maps`);
    const steps = GUIDES[flow];
    assert.ok(steps.length > 0, `${flow} has no steps`);
    for (const step of steps) {
      assert.ok(step.ready.trim().length > 0, `${flow}/${step.step} has no ready check`);
      assert.ok(step.probe.trim().length > 0, `${flow}/${step.step} has no probe`);
      assert.ok(step.controls.length > 0, `${flow}/${step.step} has no controls`);
      for (const control of step.controls) {
        assert.ok(control.find.length > 0, `${flow}: ${control.label} has no find entries`);
        if (control.key) {
          assert.ok(control.key in S, `${flow}: unknown selector key ${control.key}`);
        }
      }
    }
  }
  assert.equal(readFileSync(path.join(root, "README.md"), "utf8"), renderIndex(), "mapping/README.md is stale");
});

await test("every MCP tool has a screen mapping (or is declared no-ui)", () => {
  const source = readFileSync(path.join(import.meta.dirname, "..", "src", "server.ts"), "utf8");
  const tools = [...source.matchAll(/server\.tool\(\s*"([a-z_]+)"/g)].map((match) => match[1]);
  assert.ok(tools.length >= 30, `only found ${tools.length} tools in server.ts`);
  const missing = tools.filter((name) => !(name in TOOL_COVERAGE));
  assert.deepEqual(missing, [], `tools without a mapping entry: ${missing.join(", ")}`);
  const stale = Object.keys(TOOL_COVERAGE).filter((name) => !tools.includes(name));
  assert.deepEqual(stale, [], `mapping entries for tools that no longer exist: ${stale.join(", ")}`);
  const used = new Set<string>();
  for (const [tool, flows] of Object.entries(TOOL_COVERAGE)) {
    if (flows === "no-ui") continue;
    assert.ok(flows.length > 0, `${tool} maps to an empty flow list`);
    for (const flow of flows) {
      assert.ok(flow in GUIDES, `${tool} references unknown flow ${flow}`);
      used.add(flow);
    }
  }
  const orphan = GUIDE_NAMES.filter((flow) => !used.has(flow));
  assert.deepEqual(orphan, [], `flows without any tool: ${orphan.join(", ")}`);
});

await test("cursor trajectory: curved, eased, deterministic, lands exactly on the target", () => {
  const from = { x: 20, y: 560 };
  const to = { x: 27, y: 590 };
  const path = planTrajectory(from, to, { seed: 42, steps: 30 });
  assert.ok(path.length >= 8, `too few steps: ${path.length}`);
  const last = path[path.length - 1];
  assert.equal(last.x, to.x, "the path must land exactly on the target x");
  assert.equal(last.y, to.y, "the path must land exactly on the target y");
  const straight = Math.hypot(to.x - from.x, to.y - from.y);
  const bowed = Math.max(
    ...path.map((point) => {
      const cross = Math.abs((to.x - from.x) * (from.y - point.y) - (from.x - point.x) * (to.y - from.y));
      return cross / straight;
    }),
  );
  assert.ok(bowed > 1, `path is not curved (max deviation ${bowed.toFixed(2)}px)`);
  for (const point of path) {
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y), "non-finite point");
    assert.ok(point.delayMs >= 0 && point.delayMs <= 400, `unreasonable delay ${point.delayMs}`);
  }
  const totalMs = path.reduce((sum, point) => sum + point.delayMs, 0);
  assert.ok(totalMs > 200 && totalMs < 6_000, `implausible travel time ${totalMs}ms`);
  const again = planTrajectory(from, to, { seed: 42, steps: 30 });
  assert.deepEqual(again, path, "same seed must replay the same path");
  const other = planTrajectory(from, to, { seed: 43, steps: 30 });
  assert.notDeepEqual(other.map((p) => p.x), path.map((p) => p.x), "different seeds must move differently");
});

await test("inspector resolves <username> URLs and lists keys per screen", () => {
  assert.equal(resolveScreenUrl("https://www.instagram.com/<username>/", "someone"), "https://www.instagram.com/someone/");
  assert.equal(resolveScreenUrl("https://www.instagram.com/<username>/", null), null, "no handle means no profile screen");
  assert.equal(resolveScreenUrl("https://www.instagram.com/p/<shortcode>/", "someone"), null, "shortcode screens are not sweepable");
  assert.equal(resolveScreenUrl("https://www.instagram.com/", null), "https://www.instagram.com/");
  const anonymous = inspectableScreens(["profile"], null);
  assert.equal(anonymous.length, 0, "profile screen must be skipped without a handle");
  const named = inspectableScreens(["profile"], "someone");
  assert.equal(named.length, 1);
  assert.equal(named[0].url, "https://www.instagram.com/someone/");
  const keys = screenKeys(named[0].step);
  assert.ok(keys.includes("followButton"), keys.join(","));
  assert.equal(new Set(keys).size, keys.length, "screen keys must be unique");
});

await test("inspector report renders ok/latent/dead and a summary", () => {
  const report = {
    device: "smoke",
    startedAt: "2026-11-04T00:00:00.000Z",
    summary: { screens: 1, ready: 1, selectors: 2, broken: 1 },
    screens: [
      {
        flow: "profile" as const,
        step: "profile header",
        url: "https://www.instagram.com/x/",
        verifiedInGuide: "live" as const,
        ready: true,
        notes: [],
        health: [
          { key: "followButton", screen: "profile", status: "ok" as const, ok: true, matched: 'css=header button', tried: 1, candidates: [{ candidate: 'css=header button', kind: "css", total: 1, visible: 1 }] },
          { key: "unfollowConfirm", screen: "profile", status: "latent" as const, ok: false, matched: null, tried: 1, candidates: [{ candidate: "find=text(Unfollow)", kind: "find:text", total: 0, visible: 0 }] },
          { key: "storyAvatar", screen: "profile", status: "dead" as const, ok: false, matched: null, tried: 1, candidates: [{ candidate: 'css=header canvas', kind: "css", total: 0, visible: 0 }] },
        ],
        controls: null,
      },
    ],
  };
  const markdown = renderInspectReport(report);
  assert.match(markdown, /\| profile: profile header \|/);
  assert.match(markdown, /\*\*dead\*\*/);
  assert.match(markdown, /\| `unfollowConfirm` \| latent \|/);
  assert.match(markdown, /0 broken|1 broken|selector keys/i);
});

await test("pane command carries every isolation env var", () => {
  const manager = new DeviceManager(root);
  manager.create("pane-1");
  const command = paneCommand("pane-1", root);
  for (const key of [
    "XDG_STATE_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "TERMINAL_BROWSER_APPDATA",
    "AGENT_BROWSER_SOCKET_DIR",
  ]) {
    assert.ok(command.includes(key), `missing ${key}`);
  }
  assert.ok(command.includes("terminal-browser open"));
  assert.ok(command.includes("https://www.instagram.com"));
});

rmSync(root, { recursive: true, force: true });
process.stdout.write(`${checks.join("\n")}\n${passed}/${checks.length} ok\n`);
