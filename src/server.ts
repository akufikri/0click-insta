import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { HOME, devicePaths, type DeviceMeta, type LiveBrowser } from "./device.ts";
import { asIgError, fail } from "./errors.ts";
import { devices, requireLive } from "./registry.ts";
import { rate, type ActionName } from "./rate.ts";
import { pace } from "./human.ts";
import { challengeSummary, probe, waitClearance } from "./challenge.ts";
import { extractSiteKey, injectToken, solveWithProvider } from "./captcha.ts";
import { captchaState, clickCaptchaCheckbox, solveRecaptchaWall } from "./recaptcha.ts";
import { friendshipList, friendshipShowMany } from "./igapi.ts";
import { applyStealth, ensureStealth, releaseStealth, stealthState } from "./stealth.ts";
import { openPane, paneCommand, shutdownDevice } from "./tb.ts";
import { evalJson, openUrl, reload, screenshot, tryEval, url } from "./agent.ts";
import { sleep } from "./sleep.ts";
import * as ig from "./ig.ts";
import { GUIDE_NAMES, GUIDES, REPAIR_RECIPE, type GuideName } from "./guidelines.ts";
import { DOM_MAP_JS, summarizeDom, type DomMap } from "./introspect.ts";
import { inspectScreens, allScreenKeys, type ScreenReport } from "./inspector.ts";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (payload: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ ok: true, ...payload }) }],
});

const isError = (payload: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ ok: false, ...payload }) }],
  isError: true,
});

function trimArtifacts(deviceId: string): void {
  const dir = devicePaths(deviceId, devices.root).artifacts;
  try {
    const files = readdirSync(dir)
      .filter((name) => name.endsWith(".png"))
      .map((name) => ({ name, mtime: statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    for (const stale of files.slice(8)) rmSync(path.join(dir, stale.name), { force: true });
  } catch {
    // no artifacts yet
  }
}

async function failure(error: unknown, deviceId: string, tool: string): Promise<ToolResult> {
  const igError = asIgError(error);
  const payload: Record<string, unknown> = { error: igError.code, message: igError.message, ...igError.details };
  if (["SelectorMissing", "ChallengeRequired", "TbFailed", "TbTimeout"].includes(igError.code)) {
    try {
      const report = await probe(deviceId);
      if (report.kind !== "none") payload.challenge = report;
    } catch {
      // browser may be gone; the original error is the useful one
    }
    const file = await screenshot(deviceId, tool).catch(() => null);
    if (file) {
      payload.screenshot = file;
      trimArtifacts(deviceId);
    }
  }
  return isError(payload);
}

/** Every action: live browser, challenge gate, rate gate, pacing, serialisation, then the flow. */
async function run(
  deviceId: string,
  action: ActionName,
  tool: string,
  flow: () => Promise<Record<string, unknown>>,
): Promise<ToolResult> {
  try {
    devices.meta(deviceId);
    requireLive(deviceId);
    await ig.ensureCleared(deviceId, tool);
    rate.check(deviceId, action);
    const paced = await pace();
    const result = await devices.exclusive(deviceId, flow);
    rate.commit(deviceId, action);
    return ok({ device: deviceId, pacedMs: paced, ...result });
  } catch (error) {
    return failure(error, deviceId, tool);
  }
}

const server = new McpServer({ name: "0click-instagram", version: "0.1.0" });
const DEVICE = z.string().describe("device id (one Instagram account per device)");

server.tool("device_list", "List devices with their live browser key, handle and pane state", {}, async () => {
  const items = devices.list().map((meta: DeviceMeta) => {
    const live = devices.live(meta.id);
    return {
      ...meta,
      running: Boolean(live),
      browserKey: live?.key ?? null,
      cdpPort: live?.cdpPort ?? null,
    };
  });
  return ok({ devices: items });
});

server.tool(
  "device_create",
  "Create an isolated device: own terminal-browser daemon, own cookie jar, own profile dir",
  {
    id: DEVICE,
    url: z.string().optional().describe(`start page, default ${HOME}`),
    socksPort: z.number().int().positive().optional().describe("local SOCKS proxy port for this device's egress"),
  },
  async ({ id, url, socksPort }) => {
    try {
      const meta = devices.create(id, url ?? HOME, socksPort);
      return ok({ device: meta, command: paneCommand(id, devices.root) });
    } catch (error) {
      return failure(error, id, "device_create");
    }
  },
);

server.tool(
  "device_delete",
  "Delete a device directory (cookies, profile, history). Needs confirm:true",
  { id: DEVICE, confirm: z.boolean() },
  async ({ id, confirm }) => {
    try {
      devices.meta(id);
      if (confirm !== true) fail("ConfirmRequired", `device_delete ${id} needs confirm:true — it deletes cookies and profile`);
      releaseStealth(id);
      const stopped = await shutdownDevice(id, devices.root);
      devices.remove(id, true);
      return ok({ device: id, deleted: true, stoppedBrowser: stopped });
    } catch (error) {
      return failure(error, id, "device_delete");
    }
  },
);

server.tool(
  "device_stop",
  "Close the device's browser (pane and cookies stay, session survives)",
  { device: DEVICE },
  async ({ device }) => {
    try {
      devices.meta(device);
      releaseStealth(device);
      const result = await shutdownDevice(device, devices.root);
      return ok({ device, ...result });
    } catch (error) {
      return failure(error, device, "device_stop");
    }
  },
);

server.tool(
  "device_start",
  "Open the device browser in a terminal pane (spawns a Tern split when running inside Tern) and apply the anti-detection profile",
  { device: DEVICE },
  async ({ device }) => {
    try {
      devices.meta(device);
      const existing = devices.live(device);
      if (existing) {
        const stealth = await ensureStealth(device);
        return ok({ device, browserKey: existing.key, cdpPort: existing.cdpPort, reused: true, stealth });
      }
      const started = await openPane(device, devices.root);
      if (!started) {
        return ok({ device, needsManualStart: true, command: paneCommand(device, devices.root) });
      }
      const deadline = Date.now() + 30_000;
      let live: LiveBrowser | null = null;
      while (Date.now() < deadline) {
        live = devices.live(device);
        if (live) break;
        await sleep(500);
      }
      if (!live) {
        return ok({
          device,
          needsManualStart: true,
          command: paneCommand(device, devices.root),
          blocks: started.blocks,
          note: "pane opened but terminal-browser has not registered yet",
        });
      }
      const stealth = await ensureStealth(device);
      const deadlineUrl = Date.now() + 20_000;
      let pageUrl = await url(device).catch(() => "");
      while (Date.now() < deadlineUrl && !/^https?:/i.test(pageUrl)) {
        await sleep(500);
        pageUrl = await url(device).catch(() => "");
      }
      return ok({ device, browserKey: live.key, cdpPort: live.cdpPort, blocks: started.blocks, stealth, url: pageUrl });
    } catch (error) {
      return failure(error, device, "device_start");
    }
  },
);

server.tool(
  "pane_command",
  "The exact shell command that starts this device's browser pane (run it in a terminal that terminal-browser supports)",
  { device: DEVICE },
  async ({ device }) => {
    try {
      devices.meta(device);
      return ok({ device, command: paneCommand(device, devices.root) });
    } catch (error) {
      return failure(error, device, "pane_command");
    }
  },
);

server.tool(
  "login",
  "Log in. Without username/password it waits for you to finish login (and 2FA/challenge) in the device pane",
  {
    device: DEVICE,
    username: z.string().optional(),
    password: z.string().optional(),
    code: z.string().optional().describe("2FA / security code, when Instagram asks for one"),
  },
  async ({ device, username, password, code }) => {
    try {
      devices.meta(device);
      requireLive(device);
      const result =
        username && password ? await ig.loginCreds(device, username, password, code) : await ig.loginManual(device);
      if (result.status === "ok") devices.save(device, { handle: result.handle ?? undefined });
      return ok({ device, ...result });
    } catch (error) {
      return failure(error, device, "login");
    }
  },
);

server.tool("logout", "Clear this device's Instagram cookies", { device: DEVICE }, async ({ device }) => {
  try {
    devices.meta(device);
    requireLive(device);
    await ig.logout(device);
    devices.save(device, { handle: undefined });
    return ok({ device, loggedOut: true });
  } catch (error) {
    return failure(error, device, "logout");
  }
});

server.tool("status", "Session, handle, page and live challenge state for a device", { device: DEVICE }, async ({ device }) => {
  try {
    devices.meta(device);
    const live = devices.live(device);
    if (!live) return ok({ device, running: false, loggedIn: false, handle: null, challenge: "none" });
    const state = await ig.status(device);
    return ok({ device, running: true, browserKey: live.key, cdpPort: live.cdpPort, url: await url(device), ...state });
  } catch (error) {
    return failure(error, device, "status");
  }
});

server.tool(
  "post",
  "Publish a photo, carousel or reel from local files",
  {
    device: DEVICE,
    media: z.array(z.string()).describe("absolute paths; 1 file for photo/reel, 2-10 for carousel"),
    caption: z.string().optional(),
    kind: z.enum(["photo", "carousel", "reel"]),
  },
  async ({ device, media, caption, kind }) =>
    run(device, "post", "post", async () => {
      const result = await ig.post(device, media, caption ?? "", kind);
      return { ...result, kind };
    }),
);

server.tool(
  "edit_post",
  "Rewrite the caption of an existing post",
  { device: DEVICE, target: z.string().describe("shortcode or post URL"), caption: z.string() },
  async ({ device, target, caption }) =>
    run(device, "post", "edit_post", async () => {
      await ig.editPost(device, target, caption);
      return { target, caption };
    }),
);

server.tool(
  "delete_post",
  "Delete one of this account's posts",
  { device: DEVICE, target: z.string() },
  async ({ device, target }) =>
    run(device, "post", "delete_post", async () => {
      await ig.deletePost(device, target);
      return { target, deleted: true };
    }),
);

server.tool(
  "follow",
  "Follow a username (idempotent)",
  { device: DEVICE, username: z.string() },
  async ({ device, username }) =>
    run(device, "follow", "follow", async () => {
      const result = await ig.follow(device, username);
      return { username, ...result };
    }),
);

server.tool(
  "following_list",
  "Read the accounts this device follows: scroll the dialog, or filter it with search",
  {
    device: DEVICE,
    username: z.string().optional().describe("account to inspect, default: this device's handle"),
    maxScrolls: z.number().int().min(1).max(120).optional(),
    search: z.string().optional().describe("type this into the dialog's search box and return the filtered rows"),
  },
  async ({ device, username, maxScrolls, search }) =>
    run(device, "read", "following_list", async () => {
      const handle = username ?? (await ig.whoami(device));
      if (!handle) fail("SelectorMissing", "handle unknown: pass username");
      const list = await ig.listRelations(device, handle, "following", { maxScrolls: maxScrolls ?? 20, search });
      return { username: handle, ...list, count: list.users.length };
    }),
);

server.tool(
  "followers_list",
  "Read the accounts following this device: scroll the dialog, or filter it with search",
  {
    device: DEVICE,
    username: z.string().optional(),
    maxScrolls: z.number().int().min(1).max(120).optional(),
    search: z.string().optional(),
  },
  async ({ device, username, maxScrolls, search }) =>
    run(device, "read", "followers_list", async () => {
      const handle = username ?? (await ig.whoami(device));
      if (!handle) fail("SelectorMissing", "handle unknown: pass username");
      const list = await ig.listRelations(device, handle, "followers", { maxScrolls: maxScrolls ?? 20, search });
      return { username: handle, ...list, count: list.users.length };
    }),
);

server.tool(
  "follow_status",
  "Authoritative per-account check: does this handle follow you back (followed_by) and do you follow it",
  {
    device: DEVICE,
    usernames: z.array(z.string()).min(1).max(100),
  },
  async ({ device, usernames }) => {
    try {
      devices.meta(device);
      requireLive(device);
      const following = await friendshipList(device, "following");
      const wanted = new Set(usernames.map((name) => name.replace(/^@/, "").toLowerCase()));
      const ids = following.users.filter((user) => wanted.has(user.username.toLowerCase()));
      const missing = usernames.filter((name) => !ids.some((user) => user.username.toLowerCase() === name.replace(/^@/, "").toLowerCase()));
      const checks = await friendshipShowMany(device, ids.map((user) => user.id));
      return ok({
        device,
        checks: checks.map((check) => ({
          username: ids.find((user) => user.id === check.userId)?.username ?? check.userId,
          followsYou: check.followedBy,
          youFollow: check.following,
          status: check.status,
        })),
        notInFollowing: missing,
      });
    } catch (error) {
      return failure(error, device, "follow_status");
    }
  },
);

server.tool(
  "unfollow_selected",
  "Unfollow exactly the handles you name: searches the following list, presses the row button, confirms. Dry run unless confirm:true",
  {
    device: DEVICE,
    usernames: z.array(z.string()).min(1).max(50),
    confirm: z.boolean().optional().describe("true actually unfollows"),
  },
  async ({ device, usernames, confirm }) =>
    run(device, "unfollow", "unfollow_selected", async () => {
      const result = await ig.unfollowSelected(device, usernames, { confirm: confirm === true });
      return { ...result };
    }),
);

server.tool(
  "unfollow_bulk",
  "Unfollow only the accounts that do NOT follow back. Dry run unless confirm:true; limit caps the batch",
  {
    device: DEVICE,
    confirm: z.boolean().optional().describe("true actually unfollows; false returns the plan"),
    limit: z.number().int().min(1).max(400).optional().describe("how many to unfollow in this call; batch it"),
    maxScrolls: z.number().int().min(2).max(400).optional().describe("page budget per list (API) or scroll budget (UI)"),
    username: z.string().optional(),
    mode: z.enum(["api", "ui"]).optional().describe("api = friendship endpoint (seconds), ui = scrape the dialog (minutes)"),
  },
  async ({ device, confirm, limit, maxScrolls, username, mode }) =>
    run(device, "unfollow", "unfollow_bulk", async () => {
      const result = await ig.unfollowNotFollowingBack(device, {
        confirm: confirm === true,
        limit: limit ?? 10,
        maxScrolls: maxScrolls ?? 200,
        username,
        mode: mode ?? "api",
      });
      return { ...result, confirmRequired: !result.dryRun ? undefined : "pass confirm:true to execute this plan" };
    }),
);

server.tool(
  "unfollow",
  "Unfollow a username (idempotent)",
  { device: DEVICE, username: z.string() },
  async ({ device, username }) =>
    run(device, "unfollow", "unfollow", async () => {
      const result = await ig.unfollow(device, username);
      return { username, ...result };
    }),
);

server.tool(
  "like",
  "Like a post (idempotent)",
  { device: DEVICE, target: z.string() },
  async ({ device, target }) =>
    run(device, "like", "like", async () => {
      const result = await ig.setLike(device, target, true);
      return { target, ...result };
    }),
);

server.tool(
  "unlike",
  "Remove a like (idempotent)",
  { device: DEVICE, target: z.string() },
  async ({ device, target }) =>
    run(device, "like", "unlike", async () => {
      const result = await ig.setLike(device, target, false);
      return { target, ...result };
    }),
);

server.tool(
  "comment",
  "Comment on a post",
  { device: DEVICE, target: z.string(), text: z.string() },
  async ({ device, target, text }) =>
    run(device, "comment", "comment", async () => {
      await ig.comment(device, target, text);
      return { target, text };
    }),
);

server.tool(
  "save",
  "Save (bookmark) a post (idempotent)",
  { device: DEVICE, target: z.string() },
  async ({ device, target }) =>
    run(device, "read", "save", async () => {
      const result = await ig.setSave(device, target, true);
      return { target, ...result };
    }),
);

server.tool(
  "unsave",
  "Remove a saved post (idempotent)",
  { device: DEVICE, target: z.string() },
  async ({ device, target }) =>
    run(device, "read", "unsave", async () => {
      const result = await ig.setSave(device, target, false);
      return { target, ...result };
    }),
);

server.tool(
  "profile",
  "Read a profile: bio, counts, recent post links",
  { device: DEVICE, username: z.string() },
  async ({ device, username }) =>
    run(device, "read", "profile", async () => {
      const result = await ig.profile(device, username);
      return { ...result };
    }),
);

server.tool(
  "feed",
  "Read post links from the home feed",
  { device: DEVICE, limit: z.number().int().min(1).max(50).optional() },
  async ({ device, limit }) =>
    run(device, "read", "feed", async () => {
      const result = await ig.feed(device, limit ?? 12);
      return { items: result.items, count: result.items.length };
    }),
);

server.tool(
  "dm_list",
  "List direct-message threads",
  { device: DEVICE, limit: z.number().int().min(1).max(50).optional() },
  async ({ device, limit }) =>
    run(device, "read", "dm_list", async () => {
      const result = await ig.dmList(device, limit ?? 10);
      return { threads: result.threads, count: result.threads.length };
    }),
);

server.tool(
  "dm_send",
  "Send a direct message to a username",
  { device: DEVICE, username: z.string(), text: z.string() },
  async ({ device, username, text }) =>
    run(device, "dm", "dm_send", async () => {
      await ig.dmSend(device, username, text);
      return { username, text, sent: true };
    }),
);

server.tool(
  "story_view",
  "Open a user's story in the device pane",
  { device: DEVICE, username: z.string() },
  async ({ device, username }) =>
    run(device, "story", "story_view", async () => {
      await ig.storyView(device, username);
      return { username, opened: true };
    }),
);

server.tool(
  "story_upload",
  "Upload a story when Instagram desktop exposes it (otherwise Unsupported, never a fake success)",
  { device: DEVICE, media: z.array(z.string()) },
  async ({ device, media }) =>
    run(device, "story", "story_upload", async () => {
      const result = await ig.storyUpload(device, media);
      return { ...result, media };
    }),
);

server.tool(
  "notifications",
  "Read the notifications panel",
  { device: DEVICE, limit: z.number().int().min(1).max(100).optional() },
  async ({ device, limit }) =>
    run(device, "read", "notifications", async () => {
      const result = await ig.notifications(device, limit ?? 20);
      return { items: result.items, count: result.items.length };
    }),
);

server.tool(
  "eval_page",
  "Run JavaScript in the device page (use it to repair selectors)",
  {
    device: DEVICE,
    expr: z.string(),
    url: z.string().optional().describe("navigate here first"),
  },
  async ({ device, expr, url: target }) => {
    try {
      devices.meta(device);
      requireLive(device);
      if (target) await openUrl(device, target);
      const result = await evalJson<unknown>(device, expr);
      return ok({ device, result });
    } catch (error) {
      return failure(error, device, "eval_page");
    }
  },
);

server.tool("page_reload", "Reload the device page", { device: DEVICE }, async ({ device }) => {
  try {
    devices.meta(device);
    requireLive(device);
    await reload(device);
    return ok({ device, url: await url(device) });
  } catch (error) {
    return failure(error, device, "page_reload");
  }
});

server.tool(
  "challenge_status",
  "Detect Cloudflare / captcha / Instagram checkpoint on the device page",
  { device: DEVICE },
  async ({ device }) => {
    try {
      devices.meta(device);
      requireLive(device);
      const report = await probe(device);
      const sitekey = report.kind === "none" ? null : await extractSiteKey(device).catch(() => null);
      return ok({ device, ...report, sitekey });
    } catch (error) {
      return failure(error, device, "challenge_status");
    }
  },
);

server.tool(
  "challenge_solve",
  "Clear a wall: wait out Cloudflare/Turnstile, or solve recaptcha/hcaptcha through IG_CAPTCHA_PROVIDER",
  {
    device: DEVICE,
    waitMs: z.number().int().min(0).max(900_000).optional(),
    provider: z.boolean().optional().describe("use the captcha provider instead of only waiting"),
  },
  async ({ device, waitMs, provider }) => {
    try {
      devices.meta(device);
      requireLive(device);
      const before = await probe(device);
      if (before.kind === "none") return ok({ device, kind: "none", cleared: true });
      const wall = await captchaState(device).catch(() => null);
      if (wall?.present || before.kind === "recaptcha") {
        const solved = await solveRecaptchaWall(device, { timeoutMs: waitMs ?? Number(process.env.IG_CHALLENGE_WAIT_MS ?? 120_000) });
        const still = await probe(device);
        if (solved.cleared) return ok({ device, kind: before.kind, strategy: "oopif-checkbox-click", ...solved, remaining: still.kind });
        return ok({ device, kind: before.kind, strategy: "oopif-checkbox-click", ...solved, remaining: still.kind });
      }
      if (provider && ["recaptcha", "hcaptcha", "turnstile"].includes(before.kind)) {
        const sitekey = await extractSiteKey(device);
        if (!sitekey) fail("CaptchaUnsolvable", "could not find the captcha sitekey on the page");
        const solved = await solveWithProvider(sitekey);
        const fields = await injectToken(device, solved.token);
        const after = await waitClearance(device, waitMs ?? 60_000);
        return ok({ device, kind: before.kind, provider: solved.provider, fields, cleared: after.kind === "none", remaining: after.kind });
      }
      const after = await waitClearance(device, waitMs ?? Number(process.env.IG_CHALLENGE_WAIT_MS ?? 180_000));
      return ok({ device, kind: before.kind, cleared: after.kind === "none", remaining: after.kind, hint: after.hint });
    } catch (error) {
      return failure(error, device, "challenge_solve");
    }
  },
);

server.tool(
  "stealth_apply",
  "Reinstall the anti-detection profile (webdriver flag, UA, plugins, WebGL, locale) on every page target",
  { device: DEVICE },
  async ({ device }) => {
    try {
      devices.meta(device);
      requireLive(device);
      const report = await applyStealth(device);
      const state = report.applied.length > 0 ? await stealthState(device) : null;
      return ok({ ...report, state });
    } catch (error) {
      return failure(error, device, "stealth_apply");
    }
  },
);

server.tool(
  "proxy_set",
  "Route this device's browser through a local SOCKS proxy (takes effect on the next device_start)",
  { device: DEVICE, socksPort: z.number().int().positive().nullable() },
  async ({ device, socksPort }) => {
    try {
      devices.meta(device);
      const meta = devices.save(device, socksPort === null ? { socksPort: undefined } : { socksPort });
      return ok({ device, socksPort: meta.socksPort ?? null, appliesOn: "next device_start", command: paneCommand(device, devices.root) });
    } catch (error) {
      return failure(error, device, "proxy_set");
    }
  },
);

server.tool(
  "register",
  "Create an Instagram account through the web signup form (dry run unless submit:true)",
  {
    device: DEVICE,
    contact: z.string().describe("email or phone number Instagram should verify"),
    password: z.string(),
    fullName: z.string(),
    username: z.string(),
    birthday: z.string().describe("YYYY-MM-DD"),
    submit: z.boolean().optional().describe("false = fill only, never press Submit"),
  },
  async ({ device, contact, password, fullName, username, birthday, submit }) => {
    try {
      devices.meta(device);
      requireLive(device);
      await ig.ensureCleared(device, "register");
      const outcome = await ig.register(device, { contact, password, fullName, username, birthday, submit: submit === true });
      return ok({ device, ...outcome });
    } catch (error) {
      return failure(error, device, "register");
    }
  },
);

server.tool(
  "register_verify",
  "Finish a signup with the confirmation code Instagram sent",
  { device: DEVICE, code: z.string() },
  async ({ device, code }) => {
    try {
      devices.meta(device);
      requireLive(device);
      const outcome = await ig.registerVerify(device, code);
      return ok({ device, ...outcome });
    } catch (error) {
      return failure(error, device, "register_verify");
    }
  },
);

server.tool(
  "ui_guide",
  "Selector map for every Instagram screen: static guide (verified or not) plus the live controls on the device's current page",
  {
    device: DEVICE.optional(),
    flow: z.enum(GUIDE_NAMES as [GuideName, ...GuideName[]]).optional(),
  },
  async ({ device, flow }) => {
    const guides: Record<string, unknown> = {};
    for (const name of flow ? [flow] : GUIDE_NAMES) guides[name] = GUIDES[name];
    const payload: Record<string, unknown> = { guides, recipe: REPAIR_RECIPE };
    if (!device) return ok(payload);
    try {
      devices.meta(device);
      requireLive(device);
      const map = await evalJson<DomMap>(device, DOM_MAP_JS);
      return ok({ ...payload, live: summarizeDom(map) });
    } catch (error) {
      return failure(error, device, "ui_guide");
    }
  },
);

server.tool(
  "captcha_state",
  "reCAPTCHA Enterprise widget state of the device page (checkbox, image challenge, sitekey), read from Instagram's out-of-process frames",
  { device: DEVICE },
  async ({ device }) => {
    try {
      devices.meta(device);
      requireLive(device);
      const state = await captchaState(device);
      return ok({ device, ...state });
    } catch (error) {
      return failure(error, device, "captcha_state");
    }
  },
);

server.tool(
  "inspect_screens",
  "Walk every mapped screen on any logged-in device and report which selectors are still alive (reusable across accounts)",
  {
    device: DEVICE,
    flows: z.array(z.string()).optional().describe("limit to these flow names"),
    navigate: z.boolean().optional().describe("false = audit only the page currently open"),
  },
  async ({ device, flows, navigate }) => {
    try {
      devices.meta(device);
      requireLive(device);
      const report = await inspectScreens({
        device,
        flows: flows as Parameters<typeof inspectScreens>[0]["flows"],
        navigate: navigate !== false,
      });
      return ok({
        device: report.device,
        startedAt: report.startedAt,
        summary: report.summary,
        screens: report.screens.map((screen: ScreenReport) => ({
          flow: screen.flow,
          step: screen.step,
          url: screen.url,
          ready: screen.ready,
          broken: screen.health.filter((entry) => !entry.ok).map((entry) => entry.key),
          ok: screen.health.filter((entry) => entry.ok).map((entry) => entry.key),
          notes: screen.notes,
        })),
        selectorMap: allScreenKeys(),
      });
    } catch (error) {
      return failure(error, device, "inspect_screens");
    }
  },
);

server.tool(
  "captcha_click",
  "Move a human-shaped cursor path (CSR-S → curve → target) inside the reCAPTCHA frame and click the checkbox",
  { device: DEVICE },
  async ({ device }) => {
    try {
      devices.meta(device);
      requireLive(device);
      const before = await captchaState(device);
      const click = await clickCaptchaCheckbox(device);
      const after = await captchaState(device);
      return ok({ device, before, click, after });
    } catch (error) {
      return failure(error, device, "captcha_click");
    }
  },
);

server.tool(
  "challenge_probe_text",
  "Raw text of the current page (debug helper for challenges)",
  { device: DEVICE },
  async ({ device }) => {
    try {
      devices.meta(device);
      requireLive(device);
      const summary = await challengeSummary(device);
      const text = await tryEval<string>(device, "(document.body ? document.body.innerText : '').slice(0, 1500)");
      return ok({ device, kind: summary.kind, text: text ?? "" });
    } catch (error) {
      return failure(error, device, "challenge_probe_text");
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const stop = () => {
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((error: unknown) => {
  process.stderr.write(`0click-instagram failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
