import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { act, call, click, clickCss, clickText, evalJson, fill, openUrl, pageText, press, tryEval, typeInto, upload, url, waitFor } from "./agent.ts";
import { HOME } from "./device.ts";
import { devices } from "./registry.ts";
import { fail } from "./errors.ts";
import { pace } from "./human.ts";
import { requireClear, waitClearance, probe } from "./challenge.ts";
import { captchaState, solveRecaptchaWall } from "./recaptcha.ts";
import { friendshipList, friendshipShowMany } from "./igapi.ts";
import { sleep } from "./sleep.ts";

export type PostKind = "photo" | "carousel" | "reel";

export async function cookies(deviceId: string): Promise<Array<{ name: string; domain: string; value: string }>> {
  const envelope = await call<{ cookies?: Array<{ name: string; domain: string; value: string }> }>(deviceId, ["cookies", "get"]);
  return envelope?.cookies ?? [];
}

export type CookieRow = { name: string; domain: string; value?: string };

export function hasSessionCookie(jar: CookieRow[]): boolean {
  return jar.some(
    (cookie) => cookie.name === "sessionid" && /(^|\.)instagram\.com$/.test(cookie.domain.replace(/^\./, "")),
  );
}

export async function requireSession(deviceId: string): Promise<void> {
  const jar = await cookies(deviceId);
  if (!hasSessionCookie(jar)) {
    fail("NotLoggedIn", `device ${deviceId} has no Instagram sessionid cookie — finish login in its pane, then call status`);
  }
}

const WHOAMI_JS = `(() => {
  const blocked = new Set(['explore','reels','direct','accounts','p','reel','stories','about','legal','developer','api','challenge','emails','session','privacy','terms','help','web','create','your_activity','notifications','popular','topics','directory','invites','download','lite','threads']);
  const avatar = document.querySelector('img[alt$="profile picture" i], img[alt*="profile picture" i]');
  if (avatar) {
    const name = (avatar.getAttribute('alt') || '').replace(/[’']s profile picture$/i, '').replace(/profile picture$/i, '').trim();
    if (/^[A-Za-z0-9._]{1,30}$/.test(name)) return [name];
  }
  const found = [];
  for (const anchor of document.querySelectorAll('a[href]')) {
    const value = anchor.getAttribute('href') || '';
    const match = /^\\/([A-Za-z0-9._]{1,30})\\/?$/.exec(value);
    if (!match) continue;
    const name = match[1];
    if (blocked.has(name.toLowerCase())) continue;
    if (!found.includes(name)) found.push(name);
  }
  const og = document.querySelector('meta[property="og:url"]');
  if (og) {
    const match = /instagram\\.com\\/([A-Za-z0-9._]{1,30})\\/?$/.exec(og.getAttribute('content') || '');
    if (match && !found.includes(match[1])) found.unshift(match[1]);
  }
  return found.slice(0, 8);
})()`;

export type LoginResult = { status: string; handle?: string | null; hint?: string; kind?: string };

/** Polls for the session cookie, clearing Instagram's reCAPTCHA wall on the way. Shared by both login paths. */
async function pollLogin(deviceId: string, timeoutMs: number): Promise<LoginResult> {
  const deadline = Date.now() + timeoutMs;
  let wallCleared = false;
  while (Date.now() < deadline) {
    if (hasSessionCookie(await cookies(deviceId))) return { status: "ok", handle: await whoami(deviceId) };
    const wall = await captchaState(deviceId).catch(() => null);
    if (wall?.present) {
      if (!wallCleared) {
        const solved = await solveRecaptchaWall(deviceId).catch(() => null);
        wallCleared = solved?.cleared === true;
        if (solved && !solved.cleared) {
          return {
            status: "challenge",
            kind: solved.widget === "image" ? "recaptcha-image" : "recaptcha",
            hint: solved.hint ?? "finish the reCAPTCHA in the pane",
          };
        }
        continue;
      }
    } else {
      wallCleared = false;
    }
    const text = await pageText(deviceId, 1500);
    const reason = /the login information you entered is incorrect|password was incorrect|didn't match our records/i.exec(text)?.[0];
    if (reason) {
      const error = matchErrorCode(await url(deviceId));
      fail("BadCredentials", `Instagram rejected the credentials: ${reason}${error ? ` (${error})` : ""}`, { reason });
    }
    const report = await probe(deviceId);
    if (report.kind !== "none" && report.kind !== "recaptcha") {
      return { status: "challenge", kind: report.kind, hint: report.hint };
    }
    await sleep(2_000);
  }
  return { status: "timeout", hint: "login did not finish in time — check the device pane" };
}

function matchErrorCode(href: string): string | null {
  const code = /[?&]e=(\d+)/.exec(href)?.[1];
  return code ? `error code ${code}` : null;
}

export async function whoami(deviceId: string): Promise<string | null> {
  const known = devices.meta(deviceId).handle;
  if (known) return known;
  await openUrl(deviceId, HOME);
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const handles = (await tryEval<string[]>(deviceId, WHOAMI_JS)) ?? [];
    for (const handle of handles) {
      if (handle && !/^(explore|reels|direct|accounts)$/i.test(handle)) {
        devices.save(deviceId, { handle });
        return handle;
      }
    }
    await sleep(800);
  }
  return null;
}

export async function status(deviceId: string): Promise<{ handle: string | null; loggedIn: boolean; challenge: string }> {
  const jar = await cookies(deviceId);
  const loggedIn = hasSessionCookie(jar);
  const challenge = await probe(deviceId);
  const handle = loggedIn ? await whoami(deviceId) : null;
  return { handle, loggedIn, challenge: challenge.kind };
}

export async function loginManual(
  deviceId: string,
  timeoutMs = Number(process.env.IG_LOGIN_WAIT_MS ?? 300_000),
): Promise<LoginResult> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!devices.live(deviceId)) fail("DeviceNotRunning", `device ${deviceId} pane closed while waiting for login`);
    const result = await pollLogin(deviceId, Math.min(30_000, deadline - Date.now()));
    if (result.status !== "timeout") return result;
  }
  fail("NotLoggedIn", `login did not finish in ${Math.round(timeoutMs / 1000)}s — complete it (including 2FA) in the pane of device ${deviceId}`);
}

/**
 * Fills a field the way a person does: focus and clear via JS (Instagram's floating-label
 * wrapper covers the input's centre, so a mouse click is refused), then real keystrokes.
 * React only sees key events here; a programmatic `fill` leaves its state empty.
 */
async function typeField(deviceId: string, css: string, value: string): Promise<void> {
  const focused = await evalJson<boolean>(
    deviceId,
    `(() => {
      const el = document.querySelector(${JSON.stringify(css)});
      if (!el) return false;
      el.focus();
      if (typeof el.select === 'function') el.select();
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`,
  );
  if (focused !== true) fail("SelectorMissing", `no field for ${css} on the login form`);
  const result = await act(deviceId, ["type", css, value], 45_000);
  if (result.code !== 0) fail("SelectorMissing", `could not type into ${css}: ${result.stderr || result.stdout}`);
  const held = await evalJson<string>(deviceId, `(document.querySelector(${JSON.stringify(css)}) || {}).value || ""`);
  if (held !== value) {
    // one retry with keyboard select-all, then report instead of submitting a half-typed form
    await act(deviceId, ["press", "Control+a"]);
    const retry = await act(deviceId, ["type", css, value], 45_000);
    const again = await evalJson<string>(deviceId, `(document.querySelector(${JSON.stringify(css)}) || {}).value || ""`);
    if (retry.code !== 0 || again !== value) {
      fail("SelectorMissing", `typed value does not match the input: ${JSON.stringify(again).slice(0, 60)}`, {
        css,
        expectedLength: value.length,
        actualLength: again.length,
      });
    }
  }
}

export async function loginCreds(
  deviceId: string,
  username: string,
  password: string,
  code?: string,
): Promise<{ status: string; handle?: string | null; hint?: string; kind?: string }> {
  const existing = await cookies(deviceId);
  if (hasSessionCookie(existing)) {
    return { status: "ok", handle: await whoami(deviceId) };
  }
  await openUrl(deviceId, `${HOME}/accounts/login/`);
  await pace();
  // Playwright-style fill does not reach this form's React state; real keystrokes do.
  await typeField(deviceId, 'input[name="email"]', username);
  await typeField(deviceId, 'input[name="pass"]', password);
  await pace();
  const typed = await evalJson<string[]>(
    deviceId,
    `Array.from(document.querySelectorAll('input')).filter((node) => node.type !== 'submit').map((node) => node.value)`,
  );
  if (!typed.includes(username)) {
    fail("SelectorMissing", `the login form did not keep the username (fields hold ${JSON.stringify(typed)})`);
  }
  // This form submits on Enter from a focused field; clicking the "Log in" div was a no-op in every attempt.
  await press(deviceId, "Enter");
  let left = await waitFor(
    deviceId,
    async () => (/\/accounts\/login/.test(await url(deviceId)) ? null : true),
    { timeoutMs: 12_000 },
  );
  if (!left) {
    await clickText(deviceId, "Log in").catch(() => undefined);
    left = await waitFor(
      deviceId,
      async () => (/\/accounts\/login/.test(await url(deviceId)) ? null : true),
      { timeoutMs: 12_000 },
    );
  }
  if (!left) {
    const text = await pageText(deviceId, 1500);
    const report = await probe(deviceId);
    if (report.kind !== "none") return { status: "challenge", hint: report.hint, kind: report.kind };
    const reason = /incorrect[^.]{0,120}|wrong[^.]{0,120}|sorry[^.]{0,120}|try again[^.]{0,120}|blocked[^.]{0,120}/i.exec(text)?.[0];
    fail("SelectorMissing", `the Log in button did not leave the login page${reason ? `: ${reason}` : " and Instagram showed no message"}`, {
      page: text.slice(0, 400),
    });
  }
  await sleep(2_000);
  let current = await url(deviceId);
  const text = await pageText(deviceId, 2500);
  if (code && /challenge|two-factor|security code|confirm/i.test(`${current} ${text}`)) {
    await fill(deviceId, "loginCode", code);
    await click(deviceId, "loginSubmit");
    await sleep(4_000);
    current = await url(deviceId);
  }
  if (/password was incorrect|didn't match our records|login information you entered/i.test(await pageText(deviceId, 2000))) {
    fail("BadCredentials", `Instagram rejected the password for ${username}`);
  }
  return pollLogin(deviceId, Number(process.env.IG_LOGIN_WAIT_MS ?? 120_000));
}

export async function logout(deviceId: string): Promise<void> {
  await openUrl(deviceId, `${HOME}/`);
  await call(deviceId, ["cookies", "clear"]);
}

export function toUrl(target: string): string {
  const value = target.trim();
  if (/^https?:\/\//i.test(value)) {
    if (!/instagram\.com/i.test(value)) fail("BadTarget", `not an Instagram URL: ${value}`);
    return value;
  }
  if (/^[A-Za-z0-9_-]{5,}$/.test(value)) return `${HOME}/p/${value}/`;
  fail("BadTarget", `not a shortcode or Instagram URL: ${value}`);
}

function validateMedia(media: string[], kind: PostKind): void {
  if (media.length === 0) fail("BadTarget", "post needs at least one media file");
  if (kind === "carousel" && (media.length < 2 || media.length > 10)) {
    fail("BadTarget", `carousel needs 2-10 files, got ${media.length}`);
  }
  if (kind !== "carousel" && media.length !== 1) {
    fail("BadTarget", `${kind} needs exactly one file, got ${media.length}`);
  }
  for (const file of media) {
    if (!existsSync(file)) fail("BadTarget", `media file not found: ${file}`);
    if (!statSync(file).isFile()) fail("BadTarget", `media path is not a file: ${file}`);
  }
}

const SHARE_JS = `(() => {
  const dialog = document.querySelector('div[role="dialog"]') || document;
  const anchors = Array.from(dialog.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]'));
  const href = anchors.map((anchor) => anchor.getAttribute('href') || '').find((value) => /\\/(p|reel)\\/[A-Za-z0-9_-]+/.test(value));
  if (!href) return null;
  const shortcode = (href.match(/\\/(p|reel)\\/([A-Za-z0-9_-]+)/) || [])[2] || '';
  return { href, shortcode };
})()`;

export async function post(
  deviceId: string,
  media: string[],
  caption: string,
  kind: PostKind,
): Promise<{ url: string; shortcode: string }> {
  validateMedia(media, kind);
  await requireSession(deviceId);
  await openUrl(deviceId, HOME);
  await pace();
  await click(deviceId, "navCreate");
  const dialogReady = await waitFor(deviceId, async () => ((await tryEval<boolean>(deviceId, `!!document.querySelector('div[role="dialog"]')`)) ? true : null), {
    timeoutMs: 30_000,
  });
  if (!dialogReady) fail("SelectorMissing", "the create dialog never opened");
  if (kind === "reel") await clickText(deviceId, "Reel", 'div[role="dialog"]');
  await upload(deviceId, "fileInput", media.map((file) => path.resolve(file)));
  await pace();
  for (let step = 0; step < 3; step += 1) {
    const captionReady = await tryEval<boolean>(
      deviceId,
      `!!document.querySelector('div[role="dialog"] textarea[aria-label*="caption" i], div[role="dialog"] div[contenteditable="true"]')`,
    );
    if (captionReady) break;
    try {
      await clickText(deviceId, "Next", 'div[role="dialog"]');
    } catch {
      break;
    }
    await sleep(2_000);
  }
  if (caption.trim().length > 0) {
    await fill(deviceId, "captionArea", caption);
    await pace();
  }
  await clickText(deviceId, "Share", 'div[role="dialog"]');
  const shared = await waitFor(
    deviceId,
    async () => ((await tryEval<boolean>(deviceId, `(document.body.innerText || '').includes('Your post has been shared')`)) ? true : null),
    { timeoutMs: 90_000 },
  );
  const link = await tryEval<{ href: string; shortcode: string }>(deviceId, SHARE_JS);
  if (!shared && !link) fail("SelectorMissing", "post was not confirmed by Instagram (no share toast, no post link)");
  await clickText(deviceId, "Done", 'div[role="dialog"]').catch(() => undefined);
  const href = link?.href ?? "";
  return {
    url: href.startsWith("http") ? href : `${HOME}${href}`,
    shortcode: link?.shortcode ?? "",
  };
}

export async function editPost(deviceId: string, target: string, caption: string): Promise<void> {
  await requireSession(deviceId);
  await openUrl(deviceId, toUrl(target));
  await pace();
  await click(deviceId, "moreOptions");
  await clickText(deviceId, "Edit", 'div[role="dialog"], article');
  await pace();
  await fill(deviceId, "captionArea", caption);
  await clickText(deviceId, "Done", 'div[role="dialog"]');
}

export async function deletePost(deviceId: string, target: string): Promise<void> {
  await requireSession(deviceId);
  await openUrl(deviceId, toUrl(target));
  await pace();
  await click(deviceId, "moreOptions");
  await clickText(deviceId, "Delete", 'div[role="dialog"], article');
  await sleep(1_000);
  await clickText(deviceId, "Delete", 'div[role="dialog"]');
}

const STATE_JS = `(() => {
  const header = document.querySelector('header section') || document.querySelector('header') || document.body;
  const text = (header.innerText || '').toLowerCase();
  const buttonText = Array.from(header.querySelectorAll('button, div[role="button"]'))
    .map((node) => (node.innerText || '').trim())
    .filter((value) => value.length > 0 && value.length < 40);
  return { text: text.slice(0, 800), buttons: buttonText.slice(0, 20) };
})()`;

export async function follow(deviceId: string, username: string): Promise<{ changed: boolean }> {
  await requireSession(deviceId);
  await openUrl(deviceId, `${HOME}/${username.replace(/^@/, "")}/`);
  await pace();
  const state = await evalJson<{ text: string; buttons: string[] }>(deviceId, STATE_JS);
  if (/\bfollowing\b|\brequested\b/.test(state.buttons.join(" | ").toLowerCase())) return { changed: false };
  await clickText(deviceId, "Follow", "header");
  return { changed: true };
}

export async function unfollow(deviceId: string, username: string): Promise<{ changed: boolean }> {
  await requireSession(deviceId);
  await openUrl(deviceId, `${HOME}/${username.replace(/^@/, "")}/`);
  await pace();
  const state = await evalJson<{ text: string; buttons: string[] }>(deviceId, STATE_JS);
  if (!/\bfollowing\b|\brequested\b/.test(state.buttons.join(" | ").toLowerCase())) return { changed: false };
  await clickText(deviceId, "Following", "header");
  await sleep(1_000);
  await clickText(deviceId, "Unfollow", 'div[role="dialog"], [role="dialog"]');
  return { changed: true };
}

const LIKE_STATE_JS = `(() => {
  const nodes = Array.from(document.querySelectorAll('article section svg[aria-label], svg[aria-label="Like"], svg[aria-label="Unlike"]'));
  const labels = nodes.map((node) => node.getAttribute('aria-label') || '').filter(Boolean);
  const liked = labels.some((label) => /unlike/i.test(label));
  const present = labels.some((label) => /like/i.test(label));
  return { liked, present, labels };
})()`;

export async function setLike(deviceId: string, target: string, wanted: boolean): Promise<{ changed: boolean; liked: boolean }> {
  await requireSession(deviceId);
  await openUrl(deviceId, toUrl(target));
  await pace();
  const state = await evalJson<{ liked: boolean; present: boolean; labels: string[] }>(deviceId, LIKE_STATE_JS);
  if (state.liked === wanted) return { changed: false, liked: state.liked };
  await click(deviceId, "likeButton");
  const after = await evalJson<{ liked: boolean }>(deviceId, LIKE_STATE_JS);
  if (after.liked !== wanted) fail("SelectorMissing", `like state did not change to ${wanted ? "liked" : "unliked"}`);
  return { changed: true, liked: after.liked };
}

export async function comment(deviceId: string, target: string, text: string): Promise<void> {
  await requireSession(deviceId);
  await openUrl(deviceId, toUrl(target));
  await pace();
  await click(deviceId, "commentArea");
  await typeInto(deviceId, "commentArea", text);
  await pace();
  await clickText(deviceId, "Post", "article");
}

const SAVE_STATE_JS = `(() => {
  const nodes = Array.from(document.querySelectorAll('article svg[aria-label]'));
  const labels = nodes.map((node) => node.getAttribute('aria-label') || '');
  return { saved: labels.some((label) => /^remove$/i.test(label)), labels };
})()`;

export async function setSave(deviceId: string, target: string, wanted: boolean): Promise<{ changed: boolean; saved: boolean }> {
  await requireSession(deviceId);
  await openUrl(deviceId, toUrl(target));
  await pace();
  const state = await evalJson<{ saved: boolean }>(deviceId, SAVE_STATE_JS);
  if (state.saved === wanted) return { changed: false, saved: state.saved };
  await click(deviceId, "saveButton");
  const after = await evalJson<{ saved: boolean }>(deviceId, SAVE_STATE_JS);
  return { changed: true, saved: after.saved };
}

const PROFILE_JS = String.raw`(() => {
  const norm = (value) => (value || '').replace(/\s+/g, ' ').trim();
  const text = norm(document.body ? document.body.innerText : '');
  const pick = (pattern) => {
    const match = pattern.exec(text);
    return match ? match[1] : null;
  };
  const header = document.querySelector('header') || document.body;
  const bioLines = norm(header.innerText).split('\n').map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^(edit profile|view archive|follow|following|message|threads|posts|reels|saved|tagged|new)$/i.test(line));
  const links = [];
  for (const anchor of document.querySelectorAll('main a[href*="/p/"], main a[href*="/reel/"]')) {
    const href = anchor.getAttribute('href') || '';
    if (!links.includes(href)) links.push(href);
  }
  return {
    followers: pick(/([\d.,]+[KM]?)\s+followers?\b/i),
    following: pick(/([\d.,]+[KM]?)\s+following\b/i),
    posts: pick(/([\d.,]+[KM]?)\s+posts?\b/i),
    bio: bioLines.slice(0, 2).join(' ').slice(0, 200),
    links: links.slice(0, 12),
    bioFromDescription: (document.querySelector('meta[property="og:description"]') || {}).content || null,
  };
})()`;

function parseCount(text: string): number | null {
  const cleaned = text.replace(/,/g, "").trim();
  const match = cleaned.match(/([\d.]+)\s*([kmb])?/i);
  if (!match) return null;
  const base = Number.parseFloat(match[1]);
  if (!Number.isFinite(base)) return null;
  const scale = { k: 1_000, m: 1_000_000, b: 1_000_000_000 }[(match[2] ?? "").toLowerCase() as "k" | "m" | "b"];
  return Math.round(base * (scale ?? 1));
}

export type ProfileResult = {
  username: string;
  bio: string;
  posts: number | null;
  followers: number | null;
  following: number | null;
  recent: Array<{ url: string; shortcode: string }>;
};

export async function profile(deviceId: string, username: string): Promise<ProfileResult> {
  await requireSession(deviceId);
  const handle = username.replace(/^@/, "");
  await openUrl(deviceId, `${HOME}/${handle}/`);
  await pace();
  const data = await evalJson<{
    followers: string | null;
    following: string | null;
    posts: string | null;
    bio: string;
    links: string[];
    bioFromDescription: string | null;
  }>(deviceId, PROFILE_JS);
  return {
    username: handle,
    bio: data.bio || (data.bioFromDescription ?? ""),
    posts: data.posts ? parseCount(data.posts) : null,
    followers: data.followers ? parseCount(data.followers) : null,
    following: data.following ? parseCount(data.following) : null,
    recent: data.links.map((href) => ({
      url: href.startsWith("http") ? href : `${HOME}${href}`,
      shortcode: (href.match(/\/(p|reel)\/([A-Za-z0-9_-]+)/) || [])[2] ?? "",
    })),
  };
}

const LINKS_JS = (selector: string, limit: number) => `(() => {
  const out = [];
  for (const anchor of document.querySelectorAll(${JSON.stringify(selector)})) {
    const href = anchor.getAttribute('href') || '';
    if (!href || out.includes(href)) continue;
    out.push(href);
    if (out.length >= ${limit}) break;
  }
  return out;
})()`;

function toPostUrl(href: string): { url: string; shortcode: string } {
  return {
    url: href.startsWith("http") ? href : `${HOME}${href}`,
    shortcode: (href.match(/\/(p|reel)\/([A-Za-z0-9_-]+)/) || [])[2] ?? "",
  };
}

export async function feed(deviceId: string, limit = 12): Promise<{ items: Array<{ url: string; shortcode: string }> }> {
  await requireSession(deviceId);
  await openUrl(deviceId, HOME);
  await sleep(2_000);
  const links = await evalJson<string[]>(deviceId, LINKS_JS('main a[href*="/p/"], main a[href*="/reel/"]', limit));
  return { items: links.map(toPostUrl) };
}

const THREADS_JS = `(() => {
  const rows = [];
  for (const anchor of document.querySelectorAll('a[href^="/direct/t/"], a[href*="/direct/t/"]')) {
    const container = anchor.closest('div[role="listitem"], li, div') || anchor;
    const text = (container.innerText || '').split('\\n').map((line) => line.trim()).filter(Boolean);
    rows.push({
      href: anchor.getAttribute('href') || '',
      name: text[0] || '',
      preview: text.slice(1).join(' ').slice(0, 160),
    });
  }
  const seen = new Set();
  return rows.filter((row) => (seen.has(row.href) ? false : (seen.add(row.href), true)));
})()`;

export async function dmList(deviceId: string, limit = 10): Promise<{ threads: Array<{ href: string; name: string; preview: string }> }> {
  await requireSession(deviceId);
  await openUrl(deviceId, `${HOME}/direct/inbox/`);
  await sleep(3_000);
  const rows = await tryEval<Array<{ href: string; name: string; preview: string }>>(deviceId, THREADS_JS);
  return { threads: (rows ?? []).slice(0, limit) };
}

export async function dmSend(deviceId: string, username: string, text: string): Promise<void> {
  await requireSession(deviceId);
  await openUrl(deviceId, `${HOME}/direct/inbox/`);
  await sleep(2_500);
  try {
    await click(deviceId, "dmNewMessage");
  } catch {
    await openUrl(deviceId, `${HOME}/direct/new/`);
  }
  await sleep(2_000);
  await fill(deviceId, "dmSearch", username.replace(/^@/, ""));
  await sleep(2_000);
  const target = username.replace(/^@/, "");
  await clickText(deviceId, target, 'div[role="dialog"]');
  await sleep(2_000);
  await click(deviceId, "dmComposer");
  await typeInto(deviceId, "dmComposer", text);
  await pace();
  await press(deviceId, "Enter");
  await sleep(2_000);
  const sent = await tryEval<boolean>(deviceId, `(document.body.innerText || '').includes(${JSON.stringify(text.slice(0, 40))})`);
  if (!sent) fail("SelectorMissing", "message did not appear in the thread after Enter");
}

export async function storyView(deviceId: string, username: string): Promise<void> {
  await requireSession(deviceId);
  await openUrl(deviceId, `${HOME}/${username.replace(/^@/, "")}/`);
  await pace();
  const hasStory = await tryEval<boolean>(
    deviceId,
    `!!document.querySelector('header canvas, header img[alt*="profile picture" i]')`,
  );
  if (!hasStory) fail("SelectorMissing", `@${username} has no visible story ring`);
  await click(deviceId, "storyAvatar");
  await sleep(2_500);
  const storyOpen = await tryEval<boolean>(
    deviceId,
    `!!document.querySelector('div[role="dialog"] section, div[role="dialog"] [aria-label*="story" i], section [role="progressbar"]')`,
  );
  if (!storyOpen) fail("SelectorMissing", `story of @${username} did not open`);
}

export async function storyUpload(deviceId: string, media: string[]): Promise<{ url: string }> {
  validateMedia(media, "photo");
  await requireSession(deviceId);
  await openUrl(deviceId, HOME);
  await pace();
  await click(deviceId, "navCreate");
  const storyTab = await waitFor(
    deviceId,
    async () =>
      (await tryEval<boolean>(
        deviceId,
        `Array.from(document.querySelectorAll('div[role="dialog"] *')).some((node) => (node.innerText || '').trim() === 'Story')`,
      ))
        ? true
        : null,
    { timeoutMs: 15_000 },
  );
  if (!storyTab) {
    fail("Unsupported", "story upload is not exposed on Instagram desktop web for this account — use the mobile app", {
      device: deviceId,
    });
  }
  await clickText(deviceId, "Story", 'div[role="dialog"]');
  await upload(deviceId, "fileInput", media.map((file) => path.resolve(file)));
  const shared = await waitFor(
    deviceId,
    async () => ((await tryEval<boolean>(deviceId, `(document.body.innerText || '').includes('shared')`)) ? true : null),
    { timeoutMs: 90_000 },
  );
  if (!shared) fail("SelectorMissing", "story upload was not confirmed by Instagram");
  return { url: `${HOME}/stories/` };
}

const NOTIFICATIONS_JS = `(() => {
  const dialog = document.querySelector('div[role="dialog"]') || document.body;
  return (dialog.innerText || '').split('\\n').map((line) => line.trim()).filter(Boolean);
})()`;

export async function notifications(deviceId: string, limit = 20): Promise<{ items: string[] }> {
  await requireSession(deviceId);
  await openUrl(deviceId, HOME);
  await pace();
  try {
    await click(deviceId, "navNotifications");
  } catch {
    await openUrl(deviceId, `${HOME}/notifications/`);
  }
  await sleep(2_500);
  const lines = (await tryEval<string[]>(deviceId, NOTIFICATIONS_JS)) ?? [];
  return { items: lines.slice(0, limit) };
}

export async function ensureCleared(deviceId: string, action: string): Promise<void> {
  const report = await probe(deviceId);
  if (report.kind === "none") return;
  const settled = await waitClearance(deviceId);
  requireClear(settled, action);
}

export const SIGNUP_URL = `${HOME}/accounts/emailsignup/`;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export type RegisterInput = {
  contact: string;
  password: string;
  fullName: string;
  username: string;
  birthday: string;
  submit: boolean;
};

/** React owns these inputs: a plain value assignment is ignored, so the native setter is used. */
const FILL_BY_CONTEXT_JS = (context: string, value: string) => `(() => {
  const wanted = ${JSON.stringify(context.toLowerCase())};
  const norm = (node) => ((node || '').replace(/\\s+/g, ' ').trim().toLowerCase());
  const inputs = Array.from(document.querySelectorAll('input')).filter((node) => node.type !== 'hidden');
  const probe = (node) => {
    const around = norm(node.parentElement && node.parentElement.parentElement && node.parentElement.parentElement.innerText);
    const aria = norm(node.getAttribute('aria-label'));
    const placeholder = norm(node.placeholder);
    return around.includes(wanted) || aria.includes(wanted) || placeholder.includes(wanted);
  };
  const target = inputs.find(probe);
  if (!target) return { ok: false, values: inputs.map((node) => norm(node.parentElement && node.parentElement.parentElement && node.parentElement.parentElement.innerText).slice(0, 40)) };
  const proto = target.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
  target.focus();
  if (setter) setter.call(target, ${JSON.stringify(value)}); else target.value = ${JSON.stringify(value)};
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, value: target.value };
})()`;

const SIGNUP_STATE_JS = `(() => {
  const inputs = Array.from(document.querySelectorAll('input')).filter((node) => node.type !== 'hidden');
  const combos = Array.from(document.querySelectorAll('[role="combobox"]'));
  return {
    url: location.href,
    title: document.title,
    inputs: inputs.map((node) => ({
      type: node.type,
      value: node.value,
      context: ((node.parentElement && node.parentElement.parentElement && node.parentElement.parentElement.innerText) || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
    })),
    combos: combos.map((node) => ({
      label: node.getAttribute('aria-label'),
      text: (node.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
    })),
    text: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, 1200),
  };
})()`;

export type SignupState = {
  url: string;
  title: string;
  inputs: Array<{ type: string; value: string; context: string }>;
  combos: Array<{ label: string | null; text: string }>;
  text: string;
};

export async function signupState(deviceId: string): Promise<SignupState> {
  return evalJson<SignupState>(deviceId, SIGNUP_STATE_JS);
}

async function fillByContext(deviceId: string, context: string, value: string): Promise<string> {
  const result = await evalJson<{ ok: boolean; value?: string; values?: string[] }>(
    deviceId,
    FILL_BY_CONTEXT_JS(context, value),
  );
  if (!result || result.ok !== true) {
    fail("SelectorMissing", `no signup field labelled ${JSON.stringify(context)}`, {
      contexts: result?.values ?? [],
    });
  }
  return result.value ?? value;
}

async function pickBirthday(deviceId: string, birthday: string): Promise<{ month: string; day: number; year: number }> {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(birthday.trim());
  if (!match) fail("BadTarget", `birthday must be YYYY-MM-DD, got ${birthday}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > new Date().getFullYear()) {
    fail("BadTarget", `birthday out of range: ${birthday}`);
  }
  await click(deviceId, "signupMonth");
  await clickText(deviceId, MONTHS[month - 1]);
  await sleep(400);
  await click(deviceId, "signupDay");
  await clickText(deviceId, String(day));
  await sleep(400);
  await click(deviceId, "signupYear");
  await clickText(deviceId, String(year));
  await sleep(400);
  return { month: MONTHS[month - 1], day, year };
}

export type RegisterOutcome = {
  status: "filled" | "awaiting_code" | "challenge" | "rejected" | "ok" | "unknown";
  handle?: string | null;
  message?: string;
  challenge?: string;
  state?: SignupState;
};

/** Fills Meta's web signup. Submitting is opt-in so a dry run can verify the form without creating an account. */
export async function register(deviceId: string, input: RegisterInput): Promise<RegisterOutcome> {
  await openUrl(deviceId, SIGNUP_URL);
  await pace();
  const state = await signupState(deviceId);
  if (!state.inputs.some((entry) => entry.type === "password")) {
    const report = await probe(deviceId);
    if (report.kind !== "none") return { status: "challenge", challenge: report.kind, message: report.hint, state };
    fail("SelectorMissing", "the signup form did not render (no password field)", { url: state.url });
  }
  await fillByContext(deviceId, "mobile number or email", input.contact);
  await fillByContext(deviceId, "password", input.password);
  await pace();
  await fillByContext(deviceId, "full name", input.fullName);
  await pickBirthday(deviceId, input.birthday);
  await fillByContext(deviceId, "username", input.username);
  const filled = await signupState(deviceId);
  if (!input.submit) return { status: "filled", state: filled };

  await pace();
  await click(deviceId, "signupSubmit");
  await sleep(3_000);
  const deadline = Date.now() + Number(process.env.IG_SIGNUP_WAIT_MS ?? 90_000);
  while (Date.now() < deadline) {
    const jar = await cookies(deviceId);
    if (hasSessionCookie(jar)) return { status: "ok", handle: await whoami(deviceId) };
    const report = await probe(deviceId);
    if (report.kind !== "none") {
      return { status: "challenge", challenge: report.kind, message: report.hint, state: await signupState(deviceId) };
    }
    const current = await signupState(deviceId);
    if (/enter the confirmation code|confirm your email|enter the code we sent|check your email/i.test(current.text)) {
      return { status: "awaiting_code", message: "code sent to the contact you entered", state: current };
    }
    if (/isn't available|already (in use|registered|taken)|too many|something went wrong|we couldn't create|please try again later/i.test(current.text)) {
      return { status: "rejected", message: current.text.slice(0, 300), state: current };
    }
    await sleep(2_000);
  }
  return { status: "unknown", message: "signup did not settle in time", state: await signupState(deviceId) };
}

/** Fills the confirmation code Instagram mailed/texted and finishes the signup. */
export async function registerVerify(deviceId: string, code: string): Promise<RegisterOutcome> {
  const jar = await cookies(deviceId);
  if (hasSessionCookie(jar)) return { status: "ok", handle: await whoami(deviceId) };
  const filled = await fillByContext(deviceId, "code", code);
  if (!filled) fail("SelectorMissing", "no confirmation-code field on screen");
  await pace();
  await click(deviceId, "signupConfirm");
  const deadline = Date.now() + Number(process.env.IG_SIGNUP_WAIT_MS ?? 90_000);
  while (Date.now() < deadline) {
    const cookiesNow = await cookies(deviceId);
    if (hasSessionCookie(cookiesNow)) return { status: "ok", handle: await whoami(deviceId) };
    const report = await probe(deviceId);
    if (report.kind !== "none") {
      return { status: "challenge", challenge: report.kind, message: report.hint, state: await signupState(deviceId) };
    }
    const current = await signupState(deviceId);
    if (/wrong code|invalid code|code is incorrect|didn't match/i.test(current.text)) {
      return { status: "rejected", message: current.text.slice(0, 300), state: current };
    }
    await sleep(2_000);
  }
  return { status: "unknown", message: "confirmation did not settle in time", state: await signupState(deviceId) };
}

export type ListUser = { username: string; displayName: string };
export type ListResult = {
  users: ListUser[];
  complete: boolean;
  scrolls: number;
  opened: boolean;
  searched?: boolean;
  mode?: "api" | "ui";
  elapsedMs?: number;
  status?: string;
};

const LIST_JS = `(() => {
  const norm = (value) => (value || '').replace(/\\s+/g, ' ').trim();
  const dialog = document.querySelector('div[role="dialog"]');
  if (!dialog) return { open: false, users: [], atBottom: true };
  const users = [];
  const buttons = [...dialog.querySelectorAll('div[role="button"], button')].filter((node) =>
    /^(following|follow|requested)$/i.test(norm(node.innerText)),
  );
  for (const button of buttons) {
    let row = button;
    let anchor = null;
    for (let depth = 0; depth < 7 && row; depth += 1) {
      const candidate = [...row.querySelectorAll('a[href]')].find((node) =>
        /^\\/[A-Za-z0-9._]+\\/$/.test(node.getAttribute('href') || ''),
      );
      if (candidate) { anchor = candidate; break; }
      row = row.parentElement;
    }
    if (!anchor) continue;
    const username = (anchor.getAttribute('href') || '').replace(/\\//g, '');
    const lines = ((row || anchor).innerText || '').split('\\n').map((line) => line.trim()).filter(Boolean);
    const displayName = lines.find((line) => line !== username && !/^(following|follow|requested|follows you)$/i.test(line)) || '';
    if (!users.some((entry) => entry.username === username)) users.push({ username, displayName: displayName.slice(0, 60) });
  }
  const scroller = [...dialog.querySelectorAll('div')].find((node) => node.scrollHeight > node.clientHeight + 40) || null;
  return {
    open: true,
    users,
    atBottom: scroller ? scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 60 : true,
  };
})()`;

const SCROLL_JS = `(() => {
  const dialog = document.querySelector('div[role="dialog"]');
  if (!dialog) return { ok: false, reason: 'no dialog', top: 0, height: 0, client: 0 };
  const candidates = [...dialog.querySelectorAll('div')].filter((node) => {
    if (node.scrollHeight <= node.clientHeight + 20) return false;
    const style = getComputedStyle(node);
    return style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflow === 'auto';
  });
  const scroller = candidates.sort((a, b) => b.scrollHeight - a.scrollHeight)[0] ||
    [...dialog.querySelectorAll('div')].find((node) => node.scrollHeight > node.clientHeight + 40);
  if (!scroller) return { ok: false, reason: 'no scroller', top: 0, height: 0, client: 0 };
  // step instead of jumping: Instagram appends rows when the tail is rendered, not when scrolled instantly
  scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.scrollTop + Math.max(200, scroller.clientHeight * 0.85));
  scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
  return { ok: true, top: scroller.scrollTop, height: scroller.scrollHeight, client: scroller.clientHeight };
})()`;

const CLOSE_DIALOG_JS = `(() => {
  const dialogs = [...document.querySelectorAll('div[role="dialog"]')];
  const top = dialogs[dialogs.length - 1];
  if (!top) return false;
  const close = top.querySelector('svg[aria-label="Close"], [aria-label="Close"]');
  if (close) { (close.closest('[role="button"]') || close).dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; }
  return false;
})()`;

export async function openListDialog(deviceId: string, username: string, kind: "following" | "followers"): Promise<boolean> {
  await openUrl(deviceId, `${HOME}/${username.replace(/^@/, "")}/`);
  const deadline = Date.now() + 15_000;
  let clicked = false;
  while (Date.now() < deadline && !clicked) {
    clicked = await evalJson<boolean>(
      deviceId,
      String.raw`(() => {
        const norm = (value) => (value || '').replace(/\s+/g, ' ').trim();
        const pattern = /^[\d.,KM]+\s+${kind}$/i;
        const node = [...document.querySelectorAll('a, div[role="button"], span')].find((candidate) => pattern.test(norm(candidate.innerText)));
        if (!node) return false;
        node.click();
        return true;
      })()`,
    ).catch(() => false);
    if (process.env.IG_DEBUG) process.stdout.write(`openListDialog click=${clicked} at ${Date.now() % 100000}\n`);
    if (!clicked) await sleep(700);
  }
  if (!clicked) return false;
  const dialogDeadline = Date.now() + 12_000;
  while (Date.now() < dialogDeadline) {
    const ready = await evalJson<boolean>(
      deviceId,
      `(() => {
        const dialog = document.querySelector('div[role="dialog"]');
        if (!dialog) return false;
        if (dialog.querySelector('input[aria-label="Search input"], input[placeholder*="Search" i]')) return true;
        return dialog.querySelectorAll('a[href]').length > 0;
      })()`,
    ).catch(() => false);
    if (process.env.IG_DEBUG) process.stdout.write(`openListDialog ready=${ready}\n`);
    if (ready) return true;
    await sleep(600);
  }
  return false;
}

/** Reads a followers/following dialog for any account, scrolling until the list stops growing. */
const SEARCH_INPUT = 'div[role="dialog"] input[aria-label="Search input"]';

/** Types into the list's own search box with real key events; Instagram filters rows as you type. */
async function searchList(deviceId: string, term: string): Promise<boolean> {
  const focused = await evalJson<boolean>(
    deviceId,
    `(() => {
      const dialog = document.querySelector('div[role="dialog"]');
      const input = dialog && dialog.querySelector('input[aria-label="Search input"], input[placeholder*="Search" i]');
      if (!input) return false;
      input.focus();
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`,
  );
  if (!focused) return false;
  const typed = await act(deviceId, ["type", SEARCH_INPUT, term], 30_000);
  await sleep(1_400);
  return typed.code === 0;
}

export type ListOptions = { search?: string; maxScrolls?: number; mode?: "api" | "ui" };

export async function listRelations(
  deviceId: string,
  username: string,
  kind: "following" | "followers",
  options: ListOptions = {},
): Promise<ListResult> {
  await requireSession(deviceId);
  if ((options.mode ?? "api") === "api" && !options.search) {
    const api = await friendshipList(deviceId, kind, { maxPages: options.maxScrolls ?? 200 });
    if (api.users.length > 0) {
      return {
        users: api.users.map((user) => ({ username: user.username, displayName: user.fullName })),
        complete: api.complete,
        scrolls: api.pages,
        opened: true,
        mode: "api",
        elapsedMs: api.elapsedMs,
        status: api.status,
      };
    }
  }
  const opened = await openListDialog(deviceId, username, kind);
  if (!opened) return { users: [], complete: false, scrolls: 0, opened: false };
  if (options.search) {
    const searched = await searchList(deviceId, options.search);
    const filtered = await evalJson<{ open: boolean; users: ListUser[]; atBottom: boolean }>(deviceId, LIST_JS);
    await evalJson(deviceId, CLOSE_DIALOG_JS).catch(() => undefined);
    return {
      users: filtered.users,
      complete: filtered.atBottom,
      scrolls: 0,
      opened: true,
      searched: searched && filtered.users.length > 0,
    };
  }
  const maxScrolls = options.maxScrolls ?? 20;
  const seen = new Map<string, ListUser>();
  let scrolls = 0;
  let idleRounds = 0;
  const maxRounds = maxScrolls;
  for (let round = 0; round < maxRounds; round += 1) {
    const state = await evalJson<{ open: boolean; users: ListUser[]; atBottom: boolean }>(deviceId, LIST_JS);
    if (!state.open) break;
    const before = seen.size;
    for (const user of state.users) if (!seen.has(user.username)) seen.set(user.username, user);
    const grew = seen.size > before;
    const scrolled = await evalJson<{ ok: boolean; top: number; height: number; client: number }>(deviceId, SCROLL_JS);
    if (!scrolled.ok) break;
    scrolls += 1;
    await sleep(1_600);
    const next = await evalJson<{ users: ListUser[]; atBottom: boolean }>(deviceId, LIST_JS);
    for (const user of next.users) if (!seen.has(user.username)) seen.set(user.username, user);
    const atEnd = scrolled.top + scrolled.client >= scrolled.height - 80;
    if (!grew && atEnd) idleRounds += 1;
    else if (!grew && next.atBottom) idleRounds += 1;
    else idleRounds = 0;
    if (idleRounds >= 3) break;
  }
  const final = await evalJson<{ open: boolean; atBottom: boolean }>(deviceId, LIST_JS);
  await evalJson(deviceId, CLOSE_DIALOG_JS).catch(() => undefined);
  const reachEnd = Boolean(final.atBottom) || idleRounds >= 3;
  return { users: [...seen.values()], complete: reachEnd, scrolls, opened: true, mode: "ui" };
}

/** Clicks "Following" on the row of one handle inside the following dialog, then confirms. */
export async function unfollowFromList(deviceId: string, handle: string): Promise<boolean> {
  const wanted = JSON.stringify(`/${handle}/`);
  const clicked = await evalJson<boolean>(
    deviceId,
    `(() => {
      const norm = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const dialog = document.querySelector('div[role="dialog"]');
      if (!dialog) return false;
      const wanted = ${wanted};
      const buttons = [...dialog.querySelectorAll('div[role="button"], button')].filter((node) =>
        /^(following|requested)$/i.test(norm(node.innerText)),
      );
      for (const button of buttons) {
        let row = button;
        for (let depth = 0; depth < 7 && row; depth += 1) {
          const inside = [...row.querySelectorAll('a[href]')].some((node) => (node.getAttribute('href') || '') === wanted);
          if (inside) { button.click(); return true; }
          row = row.parentElement;
        }
      }
      return false;
    })()`,
  );
  if (!clicked) return false;
  await sleep(900);
  // The confirm lives in the topmost dialog; the list dialog itself never says "Unfollow".
  const confirmed = await evalJson<boolean>(
    deviceId,
    String.raw`(() => {
      const norm = (value) => (value || '').replace(/\s+/g, ' ').trim();
      const dialogs = [...document.querySelectorAll('div[role="dialog"]')];
      const ordered = dialogs.slice().reverse();
      for (const dialog of ordered) {
        const button = [...dialog.querySelectorAll('div[role="button"], button')].find((node) => norm(node.innerText) === 'Unfollow');
        if (button) { button.click(); return true; }
      }
      return false;
    })()`,
  );
  await sleep(1_000);
  void confirmed;
  return true;
}

export type BulkPlanRow = {
  username: string;
  displayName: string;
  mutual: boolean;
  action: "unfollow" | "skip-mutual" | "skip-limit" | "skip-protected";
};

export type BulkUnfollowResult = {
  dryRun: boolean;
  protectedMutuals?: string[];
  mode?: "api" | "ui";
  elapsedMs?: number;
  followingCount: number;
  followersCount: number;
  followingComplete: boolean;
  followersComplete: boolean;
  candidates: BulkPlanRow[];
  unfollowed: string[];
  failed: string[];
  hint?: string;
};

/**
 * Unfollows only accounts that do not follow back: following minus followers.
 * Dry run unless confirm is true, and it never trusts a partial list silently —
 * both lists report `complete` and an incomplete list caps the plan at what was seen.
 */
export async function unfollowNotFollowingBack(
  deviceId: string,
  options: { username?: string; confirm?: boolean; limit?: number; maxScrolls?: number; mode?: "api" | "ui" },
): Promise<BulkUnfollowResult> {
  await requireSession(deviceId);
  const handle = options.username ?? (await whoami(deviceId));
  if (!handle) fail("SelectorMissing", "could not work out the account handle for the bulk unfollow");
  const limit = Math.min(Math.max(options.limit ?? 10, 1), 400);
  const maxScrolls = Math.min(Math.max(options.maxScrolls ?? 20, 2), 400);

  const mode = options.mode ?? "api";
  const page = { maxScrolls, mode };
  const following = await listRelations(deviceId, handle, "following", page);
  const followers = await listRelations(deviceId, handle, "followers", page);
  const followerSet = new Set(followers.users.map((user) => user.username.toLowerCase()));
  const apiFollowing = mode === "api" ? await friendshipList(deviceId, "following", { maxPages: maxScrolls }) : null;
  const idByUsername = new Map((apiFollowing?.users ?? []).map((user) => [user.username.toLowerCase(), user.id]));

  const plan: BulkPlanRow[] = following.users.map((user) => ({
    username: user.username,
    displayName: user.displayName,
    mutual: followerSet.has(user.username.toLowerCase()),
    action: followerSet.has(user.username.toLowerCase()) ? "skip-mutual" : "unfollow",
  }));

  // Guard: confirm followed_by per account before anything is unfollowed. The list endpoints
  // miss accounts, and a missed follower would otherwise be unfollowed by mistake.
  const guardWindow = Math.min(Math.max(limit * 3, limit), 120);
  const candidateRows = plan.filter((row) => row.action === "unfollow").slice(0, guardWindow);
  const idOf = (rowName: string) => idByUsername.get(rowName.toLowerCase()) ?? "";
  const guarded: BulkPlanRow[] = [];
  if (mode === "api") {
    const checks = await friendshipShowMany(
      deviceId,
      candidateRows.map((row) => idOf(row.username)).filter((id) => id.length > 0),
    );
    const guardByUsername = new Map<string, boolean | null>();
    for (const check of checks) {
      const name = (apiFollowing?.users ?? []).find((user) => user.id === check.userId)?.username;
      if (name) guardByUsername.set(name.toLowerCase(), check.followedBy);
    }
    for (const row of candidateRows) {
      const followedBy = guardByUsername.get(row.username.toLowerCase());
      if (followedBy === true) {
        guarded.push({ ...row, mutual: true, action: "skip-protected" });
        continue;
      }
      if (followedBy !== false) {
        // unknown = do not touch: refusing to unfollow is cheaper than unfollowing a mutual
        guarded.push({ ...row, action: "skip-protected" });
        continue;
      }
      guarded.push(row);
    }
  } else {
    guarded.push(...candidateRows);
  }
  const targets = guarded.filter((row) => row.action === "unfollow").slice(0, limit);
  const protectedRows = guarded.filter((row) => row.action === "skip-protected");
  const dryRun = options.confirm !== true;
  const result: BulkUnfollowResult = {
    dryRun,
    protectedMutuals: protectedRows.map((row) => row.username),
    followingCount: following.users.length,
    followersCount: followers.users.length,
    followingComplete: following.complete,
    followersComplete: followers.complete,
    candidates: targets,
    unfollowed: [],
    failed: [],
  };
  if (!following.complete || !followers.complete) {
    result.hint = `lists were not fully loaded (following complete=${following.complete}, followers complete=${followers.complete}) — raise maxScrolls before trusting a bulk run`;
  }
  if (dryRun) return result;

  // The REST destroy endpoint answers with the app shell (HTML), so the dialog stays the only writer.
  const fast = await unfollowManyFast(deviceId, targets.map((row) => row.username));
  result.unfollowed = fast.unfollowed;
  result.failed = fast.failed;
  result.mode = "ui";
  result.elapsedMs = fast.elapsedMs;
  return result;
}

export type SelectRow = { username: string; found: boolean; button: string | null };

const ROW_JS = (handle: string): string => {
  const wanted = JSON.stringify(`/${handle.toLowerCase()}/`);
  return `(() => {
  const norm = (value) => (value || '').replace(/\\s+/g, ' ').trim();
  const dialog = document.querySelector('div[role="dialog"]');
  if (!dialog) return { found: false, button: null };
  const wanted = ${wanted};
  const anchor = [...dialog.querySelectorAll('a[href]')].find((node) => (node.getAttribute('href') || '').toLowerCase() === wanted);
  if (!anchor) return { found: false, button: null };
  const buttons = [...dialog.querySelectorAll('div[role="button"], button')].filter((node) =>
    /^(following|requested|follow)$/i.test(norm(node.innerText)),
  );
  for (const button of buttons) {
    let row = button;
    for (let depth = 0; depth < 7 && row; depth += 1) {
      const inside = [...row.querySelectorAll('a[href]')].some((node) => (node.getAttribute('href') || '').toLowerCase() === wanted);
      if (inside) return { found: true, button: norm(button.innerText) };
      row = row.parentElement;
    }
  }
  return { found: true, button: null };
})()`;
};

/** Which of these handles are currently in the following list, and what their row button says. */
export async function inspectSelected(deviceId: string, usernames: string[]): Promise<SelectRow[]> {
  await requireSession(deviceId);
  const handle = await whoami(deviceId);
  if (!handle) fail("SelectorMissing", "handle unknown on this device");
  const opened = await openListDialog(deviceId, handle, "following");
  if (!opened) fail("SelectorMissing", "the following dialog did not open");
  const rows: SelectRow[] = [];
  for (const username of usernames) {
    const searched = await searchList(deviceId, username);
    const detail = await evalJson<{ found: boolean; button: string | null }>(deviceId, ROW_JS(username));
    rows.push({ username, found: searched && detail.found, button: detail.button });
  }
  await evalJson(deviceId, CLOSE_DIALOG_JS).catch(() => undefined);
  return rows;
}

export type SelectedUnfollowResult = {
  dryRun: boolean;
  rows: SelectRow[];
  unfollowed: string[];
  failed: string[];
  hint?: string;
};

/** Unfollows exactly the handles you name: search the following list, press the row button, confirm. */
export async function unfollowSelected(
  deviceId: string,
  usernames: string[],
  options: { confirm?: boolean } = {},
): Promise<SelectedUnfollowResult> {
  const handles = usernames.map((name) => name.replace(/^@/, "").trim()).filter(Boolean);
  if (handles.length === 0) fail("BadTarget", "unfollow_selected needs at least one username");
  const dryRun = options.confirm !== true;
  // A confirmed run goes straight to work: pre-checking 100 handles would double the searches.
  const rows = dryRun ? await inspectSelected(deviceId, handles) : handles.map((username) => ({ username, found: true, button: null }));
  const result: SelectedUnfollowResult = { dryRun, rows, unfollowed: [], failed: [] };
  if (dryRun) {
    result.hint = "dry run: pass confirm:true to unfollow the rows marked found";
    return result;
  }
  const fast = await unfollowManyFast(deviceId, rows.map((row) => row.username));
  result.unfollowed = fast.unfollowed;
  result.failed = fast.failed;
  return result;
}

/**
 * One round-trip unfollow: filter the list with the search box, press the row button,
 * confirm, and verify the row is gone — all inside a single page evaluation.
 * Saves ~3s per handle versus separate evals.
 */
const UNFOLLOW_FAST_JS = (handle: string) => {
  const wanted = JSON.stringify(`/${handle.toLowerCase()}/`);
  return String.raw`(async () => {
  const norm = (value) => (value || '').replace(/\s+/g, ' ').trim();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const dialog = document.querySelector('div[role="dialog"]');
  if (!dialog) return { ok: false, reason: 'no-dialog' };
  const input = dialog.querySelector('input[aria-label="Search input"], input[placeholder*="Search" i]');
  if (!input) return { ok: false, reason: 'no-search' };
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  input.focus();
  setter.call(input, ${JSON.stringify(handle)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  const wanted = ${wanted};
  const rowDeadline = Date.now() + 3500;
  let anchor = null;
  while (Date.now() < rowDeadline) {
    anchor = [...dialog.querySelectorAll('a[href]')].find((node) => (node.getAttribute('href') || '').toLowerCase() === wanted);
    if (anchor) break;
    await sleep(200);
  }
  if (!anchor) return { ok: false, reason: 'row-not-found' };
  // walk up from the buttons, not from the anchor: the row container is an ancestor of both
  const rowButtons = [...dialog.querySelectorAll('div[role="button"], button')].filter((node) =>
    /^(following|requested)$/i.test(norm(node.innerText)),
  );
  let button = null;
  for (const candidate of rowButtons) {
    let row = candidate;
    for (let depth = 0; depth < 7 && row && !button; depth += 1) {
      const inside = [...row.querySelectorAll('a[href]')].some((node) => (node.getAttribute('href') || '').toLowerCase() === wanted);
      if (inside) button = candidate;
      row = row.parentElement;
    }
    if (button) break;
  }
  if (!button) return { ok: false, reason: 'no-row-button' };
  button.click();
  const confirmDeadline = Date.now() + 4000;
  let confirmed = false;
  while (Date.now() < confirmDeadline && !confirmed) {
    await sleep(250);
    const dialogs = [...document.querySelectorAll('div[role="dialog"]')];
    for (const candidate of dialogs.slice().reverse()) {
      const confirm = [...candidate.querySelectorAll('div[role="button"], button')].find((node) => norm(node.innerText) === 'Unfollow');
      if (confirm) { confirm.click(); confirmed = true; break; }
    }
  }
  const settleDeadline = Date.now() + 3000;
  while (Date.now() < settleDeadline) {
    const candidateDialog = document.querySelector('div[role="dialog"]');
    const probeButtons = candidateDialog ? [...candidateDialog.querySelectorAll('div[role="button"], button')] : [];
    const still = probeButtons.some((node) => {
      if (!/^(following|requested)$/i.test(norm(node.innerText))) return false;
      let row = node;
      for (let depth = 0; depth < 7 && row; depth += 1) {
        if ([...row.querySelectorAll('a[href]')].some((link) => (link.getAttribute('href') || '').toLowerCase() === wanted)) return true;
        row = row.parentElement;
      }
      return false;
    });
    if (!still) break;
    await sleep(250);
  }
  const afterDialog = document.querySelector('div[role="dialog"]');
  let afterButton = null;
  if (afterDialog) {
    const remaining = [...afterDialog.querySelectorAll('div[role="button"], button')].filter((node) =>
      /^(following|requested|follow)$/i.test(norm(node.innerText)),
    );
    for (const candidate of remaining) {
      let row = candidate;
      for (let depth = 0; depth < 7 && row; depth += 1) {
        const inside = [...row.querySelectorAll('a[href]')].some((node) => (node.getAttribute('href') || '').toLowerCase() === wanted);
        if (inside) { afterButton = norm(candidate.innerText); break; }
        row = row.parentElement;
      }
      if (afterButton) break;
    }
  }
  const gone = !afterButton || !/^(following|requested)$/i.test(afterButton);
  return { ok: gone, buttonAfter: afterButton, reason: gone ? undefined : 'still-following' };
})()`;
};

export type FastUnfollowRow = { username: string; ok: boolean; reason?: string };

/** Batch unfollow that keeps the following dialog open and pays one eval per handle. */
export async function unfollowManyFast(
  deviceId: string,
  handles: string[],
  options: { paceMs?: number; onProgress?: (done: number, result: FastUnfollowRow) => void } = {},
): Promise<{ rows: FastUnfollowRow[]; unfollowed: string[]; failed: string[]; elapsedMs: number }> {
  await requireSession(deviceId);
  const handle = await whoami(deviceId);
  if (!handle) fail("SelectorMissing", "handle unknown on this device");
  const started = Date.now();
  const opened = await openListDialog(deviceId, handle, "following");
  if (!opened) fail("SelectorMissing", "the following dialog did not open");
  const paceMs = options.paceMs ?? Number(process.env.IG_UNFOLLOW_PACE_MS ?? 350);
  const rows: FastUnfollowRow[] = [];
  for (const target of handles) {
    const result = await evalJson<{ ok: boolean; reason?: string; buttonAfter?: string | null }>(
      deviceId,
      UNFOLLOW_FAST_JS(target),
      60_000,
    ).catch(() => ({ ok: false, reason: "eval-error", buttonAfter: null }));
    const row: FastUnfollowRow = { username: target, ok: result.ok === true, reason: result.reason };
    rows.push(row);
    options.onProgress?.(rows.length, row);
    if (!row.ok) {
      // one slower retry through the proven path before giving up on this handle
      const retry = await unfollowFromList(deviceId, target).catch(() => false);
      if (retry) {
        row.ok = true;
        row.reason = undefined;
      }
    }
    await sleep(paceMs);
  }
  await evalJson(deviceId, CLOSE_DIALOG_JS).catch(() => undefined);
  return {
    rows,
    unfollowed: rows.filter((row) => row.ok).map((row) => row.username),
    failed: rows.filter((row) => !row.ok).map((row) => row.username),
    elapsedMs: Date.now() - started,
  };
}
