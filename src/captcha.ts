import { evalJson } from "./agent.ts";
import { fail } from "./errors.ts";
import { sleep } from "./sleep.ts";

export type CaptchaKind = "recaptcha" | "hcaptcha" | "turnstile" | "arkose";

export type SiteKey = { kind: CaptchaKind; sitekey: string; pageUrl: string };

export type Transport = (input: string, init?: RequestInit) => Promise<Response>;

const transport: Transport = (input, init) => fetch(input, init);

export function parseSiteKey(html: string, pageUrl: string): SiteKey | null {
  const attr = html.match(/data-sitekey=["']([A-Za-z0-9_-]{8,})["']/);
  const anchor = html.match(/recaptcha\/(?:api2|enterprise)\/anchor[^"']*[?&]k=([A-Za-z0-9_-]{8,})/);
  const hcaptcha = html.match(/hcaptcha\.com\/1\/api\.js\?[^"']*sitekey=([A-Za-z0-9_-]{8,})/);
  const turnstile = html.match(/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js\?[^"']*sitekey=([A-Za-z0-9_-]{8,})/);
  const arkose = html.match(/arkoselabs\.com[^"']*public_key=([A-Za-z0-9_-]{8,})/);
  if (turnstile) return { kind: "turnstile", sitekey: turnstile[1], pageUrl };
  if (hcaptcha) return { kind: "hcaptcha", sitekey: hcaptcha[1], pageUrl };
  if (arkose) return { kind: "arkose", sitekey: arkose[1], pageUrl };
  if (anchor) return { kind: "recaptcha", sitekey: anchor[1], pageUrl };
  if (attr) return { kind: "recaptcha", sitekey: attr[1], pageUrl };
  return null;
}

const SITEKEY_JS = `(() => {
  const out = { html: '', pageUrl: location.href, frames: [] };
  out.html = document.documentElement ? document.documentElement.outerHTML.slice(0, 400000) : '';
  out.frames = Array.from(document.querySelectorAll('iframe[src]')).map((frame) => frame.src);
  return out;
})()`;

export async function extractSiteKey(deviceId: string): Promise<SiteKey | null> {
  const probe = await evalJson<{ html: string; pageUrl: string; frames: string[] }>(deviceId, SITEKEY_JS);
  const direct = parseSiteKey(probe.html ?? "", probe.pageUrl ?? "");
  if (direct) return direct;
  for (const frame of probe.frames ?? []) {
    const fromFrame = parseSiteKey(frame, probe.pageUrl ?? "");
    if (fromFrame) return fromFrame;
  }
  return null;
}

export type ProviderResult = { token: string; provider: string };

type ProviderConfig = { name: string; key: string };

function providerConfig(): ProviderConfig | null {
  const name = (process.env.IG_CAPTCHA_PROVIDER ?? "").trim().toLowerCase();
  const key = (process.env.IG_CAPTCHA_KEY ?? "").trim();
  if (!name || !key) return null;
  return { name, key };
}

function twoCaptchaMethod(kind: CaptchaKind): string {
  switch (kind) {
    case "recaptcha":
      return "userrecaptcha";
    case "hcaptcha":
      return "hcaptcha";
    case "turnstile":
      return "turnstile";
    case "arkose":
      return "funcaptcha";
  }
}

async function twoCaptchaSolve(config: ProviderConfig, target: SiteKey): Promise<ProviderResult> {
  const submit = new URLSearchParams({
    key: config.key,
    method: twoCaptchaMethod(target.kind),
    pageurl: target.pageUrl,
    json: "1",
  });
  if (target.kind === "arkose") submit.set("publickey", target.sitekey);
  else submit.set("googlekey", target.sitekey);
  const created = (await (await transport("https://2captcha.com/in.php", { method: "POST", body: submit })).json()) as {
    status: number;
    request: string | number;
  };
  if (created.status !== 1) fail("CaptchaUnsolvable", `2captcha rejected the task: ${String(created.request)}`);
  const id = String(created.request);
  const deadline = Date.now() + Number(process.env.IG_CAPTCHA_WAIT_MS ?? 180_000);
  while (Date.now() < deadline) {
    await sleep(5_000);
    const pollUrl = new URL("https://2captcha.com/res.php");
    pollUrl.searchParams.set("key", config.key);
    pollUrl.searchParams.set("action", "get");
    pollUrl.searchParams.set("id", id);
    pollUrl.searchParams.set("json", "1");
    const polled = (await (await transport(pollUrl.toString())).json()) as { status: number; request: string };
    if (polled.status === 1) return { token: polled.request, provider: "2captcha" };
    if (!/CAPCHA_NOT_READY/i.test(polled.request)) {
      fail("CaptchaUnsolvable", `2captcha could not solve it: ${polled.request}`);
    }
  }
  fail("CaptchaUnsolvable", "2captcha timed out");
}

const ANTICAPTCHA_TASKS: Record<CaptchaKind, string> = {
  recaptcha: "RecaptchaV2TaskProxyless",
  hcaptcha: "HCaptchaTaskProxyless",
  turnstile: "TurnstileTaskProxyless",
  arkose: "FunCaptchaTaskProxyless",
};

async function antiCaptchaSolve(config: ProviderConfig, target: SiteKey): Promise<ProviderResult> {
  const created = (await (
    await transport("https://api.anti-captcha.com/createTask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientKey: config.key,
        task: {
          type: ANTICAPTCHA_TASKS[target.kind],
          websiteURL: target.pageUrl,
          websiteKey: target.sitekey,
        },
      }),
    })
  ).json()) as { errorId: number; errorDescription?: string; taskId?: number };
  if (created.errorId !== 0 || !created.taskId) {
    fail("CaptchaUnsolvable", `anti-captcha rejected the task: ${created.errorDescription ?? "unknown error"}`);
  }
  const deadline = Date.now() + Number(process.env.IG_CAPTCHA_WAIT_MS ?? 180_000);
  while (Date.now() < deadline) {
    await sleep(5_000);
    const polled = (await (
      await transport("https://api.anti-captcha.com/getTaskResult", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientKey: config.key, taskId: created.taskId }),
      })
    ).json()) as { status: string; solution?: { gRecaptchaResponse?: string; token?: string }; errorDescription?: string };
    if (polled.status === "ready") {
      const token = polled.solution?.gRecaptchaResponse ?? polled.solution?.token ?? "";
      if (!token) fail("CaptchaUnsolvable", "anti-captcha returned no token");
      return { token, provider: "anti-captcha" };
    }
    if (polled.status === "error") fail("CaptchaUnsolvable", polled.errorDescription ?? "anti-captcha failed");
  }
  fail("CaptchaUnsolvable", "anti-captcha timed out");
}

export async function solveWithProvider(target: SiteKey): Promise<ProviderResult> {
  const config = providerConfig();
  if (!config) {
    fail(
      "CaptchaUnsolvable",
      `no captcha provider configured — set IG_CAPTCHA_PROVIDER=2captcha|anticaptcha and IG_CAPTCHA_KEY, or solve ${target.kind} in the device pane`,
      { kind: target.kind, sitekey: target.sitekey },
    );
  }
  if (target.kind === "arkose") {
    fail("CaptchaUnsolvable", "Arkose/FunCaptcha needs an interactive session; solve it in the device pane", {
      kind: target.kind,
      sitekey: target.sitekey,
    });
  }
  return config.name === "anticaptcha" || config.name === "anti-captcha"
    ? antiCaptchaSolve(config, target)
    : twoCaptchaSolve(config, target);
}

const INJECT_JS = (token: string) => `(() => {
  const token = ${JSON.stringify(token)};
  const fields = [
    'textarea[name="g-recaptcha-response"]',
    'textarea#g-recaptcha-response',
    'textarea[name="h-captcha-response"]',
    'input[name="h-captcha-response"]',
    'input[name="cf-turnstile-response"]',
    'textarea[name="cf-turnstile-response"]',
  ];
  const filled = [];
  for (const selector of fields) {
    for (const node of document.querySelectorAll(selector)) {
      node.value = token;
      node.innerHTML = token;
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      filled.push(selector);
    }
  }
  for (const key of Object.keys(window)) {
    if (key.startsWith('__grecaptcha') || key.startsWith('___grecaptcha')) {
      try {
        const callback = window[key]?.callback;
        if (typeof callback === 'function') callback(token);
      } catch {}
    }
  }
  return { filled };
})()`;

export async function injectToken(deviceId: string, token: string): Promise<string[]> {
  const result = await evalJson<{ filled: string[] }>(deviceId, INJECT_JS(token));
  if (!result || result.filled.length === 0) {
    fail("CaptchaUnsolvable", "no captcha response field on the page to inject the token into");
  }
  return result.filled;
}
