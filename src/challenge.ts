import { evalJson, pageText, tryEval, url } from "./agent.ts";
import { sleep } from "./sleep.ts";
import { fail } from "./errors.ts";

export type ChallengeKind =
  | "none"
  | "cloudflare"
  | "turnstile"
  | "recaptcha"
  | "hcaptcha"
  | "arkose"
  | "ig-checkpoint"
  | "ig-rate-limit";

export type ChallengeReport = {
  kind: ChallengeKind;
  url: string;
  title: string;
  markers: string[];
  hint: string;
};

export type ProbeFlags = {
  cloudflare: boolean;
  turnstile: boolean;
  recaptcha: boolean;
  hcaptcha: boolean;
  arkose: boolean;
  title: string;
  url: string;
  text: string;
};

const PROBE_JS = `(() => {
  const text = document.body ? document.body.innerText.slice(0, 4000) : '';
  const has = (selector) => { try { return !!document.querySelector(selector); } catch { return false; } };
  return {
    url: location.href,
    title: document.title,
    text,
    cloudflare: /cdn-cgi\\/challenge-platform|__cf_chl_|cf_clearance/.test(location.href + ' ' + text) ||
      /just a moment|checking your browser|verify you are human|enable javascript and cookies|cf-browser-verification/i.test(text + ' ' + document.title) ||
      has('#challenge-form, #cf-challenge-running, .cf-challenge, #challenge-stage'),
    turnstile: has('iframe[src*="challenges.cloudflare.com"], .cf-turnstile, [data-turnstile-sitekey]'),
    recaptcha: has('iframe[src*="recaptcha"], .g-recaptcha, [data-sitekey]'),
    hcaptcha: has('iframe[src*="hcaptcha"], .h-captcha, [data-hcaptcha-sitekey]'),
    arkose: has('iframe[src*="arkoselabs"], #arkose, [data-arkose]'),
  };
})()`;

export function classify(flags: Pick<ProbeFlags, "cloudflare" | "turnstile" | "recaptcha" | "hcaptcha" | "arkose">, urlValue: string, text: string): ChallengeKind {
  if (/\/auth_platform\/(recaptcha|challenge)|\/challenge\/|checkpoint|suspicious[_ ]login|confirm it'?s you|help us confirm|we detected unusual activity/i.test(`${urlValue} ${text}`)) {
    return /auth_platform\/recaptcha/i.test(urlValue) ? "recaptcha" : "ig-checkpoint";
  }
  if (/try again later|please wait a few minutes|we limit how often|action (is )?blocked|temporarily blocked/i.test(text)) {
    return "ig-rate-limit";
  }
  if (flags.turnstile) return "turnstile";
  if (flags.hcaptcha) return "hcaptcha";
  if (flags.arkose) return "arkose";
  if (flags.recaptcha) return "recaptcha";
  if (flags.cloudflare) return "cloudflare";
  return "none";
}

const HINTS: Record<ChallengeKind, string> = {
  none: "",
  cloudflare: "Cloudflare interstitial: solve it (or let the JS challenge finish) in the device pane; cf_clearance is kept in the device cookie jar",
  turnstile: "Cloudflare Turnstile widget: click it in the device pane, or set IG_CAPTCHA_PROVIDER to solve automatically",
  recaptcha: "Instagram's own reCAPTCHA wall (auth_platform/recaptcha): click the checkbox in the device pane; the MCP keeps polling for sessionid and finishes the login",
  hcaptcha: "hCaptcha: solve in the pane or configure IG_CAPTCHA_PROVIDER/IG_CAPTCHA_KEY",
  arkose: "Arkose/FunCaptcha: only interactive solving in the pane works for Instagram checkpoints",
  "ig-checkpoint": "Instagram checkpoint: finish it in the device pane (confirm identity, email/SMS code, or the selfie check)",
  "ig-rate-limit": "Instagram action limit: stop acting on this device and retry after the cooldown",
};

export async function probe(deviceId: string): Promise<ChallengeReport> {
  const flags = (await tryEval<ProbeFlags>(deviceId, PROBE_JS)) ?? {
    url: await url(deviceId),
    title: "",
    text: "",
    cloudflare: false,
    turnstile: false,
    recaptcha: false,
    hcaptcha: false,
    arkose: false,
  };
  const kind = classify(flags, flags.url, `${flags.title}\n${flags.text}`);
  const markers: string[] = [];
  for (const key of ["cloudflare", "turnstile", "recaptcha", "hcaptcha", "arkose"] as const) {
    if (flags[key]) markers.push(key);
  }
  if (kind === "ig-checkpoint") markers.push("checkpoint");
  if (kind === "ig-rate-limit") markers.push("rate-limit");
  return { kind, url: flags.url, title: flags.title, markers, hint: HINTS[kind] };
}

export function requireClear(report: ChallengeReport, action: string): void {
  if (report.kind === "none") return;
  fail("ChallengeRequired", `${action} blocked by ${report.kind}: ${report.hint}`, {
    kind: report.kind,
    url: report.url,
    markers: report.markers,
    hint: report.hint,
  });
}

/** Waits for the challenge to disappear; interstitials and Turnstile clear themselves once the pane renders them. */
export async function waitClearance(
  deviceId: string,
  timeoutMs = Number(process.env.IG_CLEAR_WAIT_MS ?? 20_000),
  intervalMs = 2_000,
): Promise<ChallengeReport> {
  const deadline = Date.now() + timeoutMs;
  let report = await probe(deviceId);
  while (Date.now() < deadline) {
    if (report.kind === "none") return report;
    await sleep(intervalMs);
    report = await probe(deviceId);
  }
  return report;
}

/** One-line summary used by status and by error payloads. */
export async function challengeSummary(deviceId: string): Promise<{ kind: ChallengeKind; text: string }> {
  const report = await probe(deviceId);
  const text = report.kind === "none" ? "" : (await pageText(deviceId, 300)).slice(0, 300);
  return { kind: report.kind, text };
}

export async function waitForPath(deviceId: string, wanted: RegExp, timeoutMs = 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let current = await url(deviceId);
  while (Date.now() < deadline) {
    if (wanted.test(current)) return current;
    await sleep(1_000);
    current = await url(deviceId);
  }
  return current;
}

export async function pageTitle(deviceId: string): Promise<string> {
  const value = await evalJson<string>(deviceId, "document.title");
  return typeof value === "string" ? value : "";
}
