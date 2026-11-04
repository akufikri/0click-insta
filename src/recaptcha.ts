import { CdpConnection, cdpTargets, type CdpTarget } from "./stealth.ts";
import { requireLive } from "./registry.ts";
import { sleep } from "./sleep.ts";
import { fail } from "./errors.ts";
import { planTrajectory, type CursorStep, type Point } from "./humanmouse.ts";

export type CaptchaFrames = {
  page: CdpTarget | null;
  wrapper: CdpTarget | null;
  anchor: CdpTarget | null;
  bframe: CdpTarget | null;
  sitekey: string | null;
};

export function enterpriseSitekey(urls: string[]): string | null {
  for (const url of urls) {
    const match = /recaptcha\/(?:enterprise\/)?(?:anchor|bframe)[^?]*\?[^#]*\bk=([A-Za-z0-9_-]{20,})/.exec(url);
    if (match) return match[1];
  }
  return null;
}

/** Instagram hosts reCAPTCHA Enterprise in out-of-process frames: the widget is not in the page DOM. */
export async function captchaFrames(port: number): Promise<CaptchaFrames> {
  const targets = await cdpTargets(port);
  const page = targets.find((target) => target.type === "page") ?? null;
  const wrapper = targets.find((target) => /fbsbx\.com\/captcha\/recaptcha\/iframe/.test(target.url)) ?? null;
  const anchor = targets.find((target) => /recaptcha\/(?:enterprise\/)?anchor/.test(target.url)) ?? null;
  const bframe = targets.find((target) => /recaptcha\/(?:enterprise\/)?bframe/.test(target.url)) ?? null;
  return {
    page,
    wrapper,
    anchor,
    bframe,
    sitekey: enterpriseSitekey(targets.map((target) => target.url)),
  };
}

export type CaptchaState = {
  present: boolean;
  widget: "checkbox" | "image" | "invisible" | "none";
  checked: boolean | null;
  sitekey: string | null;
  url: string;
};

/** Reads the widget state from inside the anchor frame; that frame is the only place the checkbox exists. */
export async function captchaState(deviceId: string): Promise<CaptchaState> {
  const live = requireLive(deviceId);
  const frames = await captchaFrames(live.cdpPort);
  const pageUrl = frames.page?.url ?? "";
  if (!frames.anchor?.webSocketDebuggerUrl) {
    return { present: false, widget: "none", checked: null, sitekey: frames.sitekey, url: pageUrl };
  }
  let connection: CdpConnection | null = null;
  try {
    connection = await CdpConnection.connect(frames.anchor.webSocketDebuggerUrl);
    const result = await connection.send<{ result?: { value?: { checked: string | null; hasImage: boolean } } }>(
      "Runtime.evaluate",
      {
        returnByValue: true,
        expression: `(() => {
          const box = document.querySelector('#recaptcha-anchor');
          return { checked: box ? box.getAttribute('aria-checked') : null, hasImage: !!document.querySelector('#rc-imageselect, .rc-imageselect-payload') };
        })()`,
      },
    );
    const value = result.result?.value ?? { checked: null, hasImage: false };
    return {
      present: true,
      widget: value.hasImage ? "image" : "checkbox",
      checked: value.checked === "true",
      sitekey: frames.sitekey,
      url: pageUrl,
    };
  } catch {
    return { present: true, widget: "invisible", checked: null, sitekey: frames.sitekey, url: pageUrl };
  } finally {
    connection?.close();
  }
}

/** Reads the checkbox box and the widget viewport from inside the anchor frame. */
async function anchorGeometry(deviceId: string): Promise<{ box: Point & { w: number; h: number }; viewport: { w: number; h: number } } | null> {
  const live = requireLive(deviceId);
  const frames = await captchaFrames(live.cdpPort);
  if (!frames.anchor?.webSocketDebuggerUrl) return null;
  const connection = await CdpConnection.connect(frames.anchor.webSocketDebuggerUrl);
  try {
    const result = await connection.send<{
      result?: { value?: { box: { x: number; y: number; w: number; h: number }; viewport: { w: number; h: number } } | null };
    }>("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const node = document.querySelector('#recaptcha-anchor') || document.querySelector('[role="checkbox"]');
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return {
          box: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
          viewport: { w: window.innerWidth, h: window.innerHeight },
        };
      })()`,
    });
    return result.result?.value ?? null;
  } finally {
    connection.close();
  }
}

/**
 * Human-shaped click: CSR-S is a corner of the widget, the cursor travels a bowed, eased path
 * with micro-pauses and an overshoot, then presses. This is the behavioural signal reCAPTCHA
 * Enterprise scores; a single teleport-then-click looks nothing like a person.
 */
export async function clickCaptchaCheckbox(
  deviceId: string,
  options: { seed?: number; path?: CursorStep[] } = {},
): Promise<{ clicked: boolean; x: number; y: number; steps: number; pathMs: number; from: Point | null }> {
  const live = requireLive(deviceId);
  const frames = await captchaFrames(live.cdpPort);
  if (!frames.anchor?.webSocketDebuggerUrl) return { clicked: false, x: 0, y: 0, steps: 0, pathMs: 0, from: null };
  const geometry = await anchorGeometry(deviceId);
  if (!geometry) return { clicked: false, x: 0, y: 0, steps: 0, pathMs: 0, from: null };

  const target = { x: geometry.box.x + geometry.box.w / 2, y: geometry.box.y + geometry.box.h / 2 };
  const corner = Math.random() < 0.5 ? -1 : 1;
  const start = {
    x: Math.max(6, Math.min(geometry.viewport.w - 6, corner > 0 ? 16 + Math.random() * 30 : geometry.viewport.w - 30 - Math.random() * 30)),
    y: Math.max(6, geometry.viewport.h - 18 - Math.random() * 26),
  };
  const path = options.path ?? planTrajectory(start, target, { seed: options.seed });

  const connection = await CdpConnection.connect(frames.anchor.webSocketDebuggerUrl);
  const pathMs = path.reduce((total, step) => total + step.delayMs, 0);
  try {
    let last: CursorStep = { x: start.x, y: start.y, delayMs: 0 };
    for (const step of path) {
      await connection.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: step.x,
        y: step.y,
        button: "none",
        timestamp: Date.now() / 1000,
      });
      last = step;
      await sleep(step.delayMs);
    }
    // settle, press, hold, release, then let the hand drift off the widget
    await sleep(120 + Math.random() * 220);
    await connection.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: last.x,
      y: last.y,
      button: "left",
      clickCount: 1,
      timestamp: Date.now() / 1000,
    });
    await sleep(70 + Math.random() * 80);
    await connection.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: last.x,
      y: last.y,
      button: "left",
      clickCount: 1,
      timestamp: Date.now() / 1000,
    });
    await sleep(90 + Math.random() * 120);
    await connection.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: last.x + (Math.random() - 0.5) * 14,
      y: last.y + 10 + Math.random() * 20,
      button: "none",
      timestamp: Date.now() / 1000,
    });
    return { clicked: true, x: target.x, y: target.y, steps: path.length, pathMs, from: start };
  } finally {
    connection.close();
  }
}

export type WallResult = {
  cleared: boolean;
  widget: string;
  rounds: number;
  sitekey: string | null;
  url: string;
  hint?: string;
};

/**
 * Full automation for Instagram's reCAPTCHA Enterprise wall: click the checkbox in the
 * out-of-process frame, wait for the wall to leave, repeat. An image challenge stops here
 * unless a captcha provider is configured.
 */
export async function solveRecaptchaWall(
  deviceId: string,
  { timeoutMs = Number(process.env.IG_CHALLENGE_WAIT_MS ?? 120_000), rounds = 3 } = {},
): Promise<WallResult> {
  const deadline = Date.now() + timeoutMs;
  let widget = "checkbox";
  let sitekey: string | null = null;
  let attempt = 0;
  while (Date.now() < deadline && attempt < rounds) {
    const state = await captchaState(deviceId);
    sitekey = state.sitekey ?? sitekey;
    if (!state.present) return { cleared: true, widget, rounds: attempt, sitekey, url: state.url };
    widget = state.widget;
    if (state.widget === "image") {
      return {
        cleared: false,
        widget,
        rounds: attempt,
        sitekey,
        url: state.url,
        hint: "reCAPTCHA moved to an image challenge: only a human (or an image solver) can clear it",
      };
    }
    const click = await clickCaptchaCheckbox(deviceId);
    attempt += 1;
    if (!click.clicked) {
      await sleep(1_500);
      continue;
    }
    const settle = Date.now() + 12_000;
    while (Date.now() < settle) {
      await sleep(1_000);
      const after = await captchaState(deviceId);
      if (!after.present) return { cleared: true, widget, rounds: attempt, sitekey, url: after.url };
      if (after.widget === "image") {
        widget = "image";
        return {
          cleared: false,
          widget,
          rounds: attempt,
          sitekey,
          url: after.url,
          hint: "the checkbox opened an image challenge",
        };
      }
    }
  }
  const final = await captchaState(deviceId);
  if (!final.present) return { cleared: true, widget, rounds: attempt, sitekey, url: final.url };
  fail("ChallengeRequired", `reCAPTCHA wall still up after ${attempt} click(s) (${final.widget})`, {
    widget: final.widget,
    sitekey: final.sitekey,
    url: final.url,
  });
}
