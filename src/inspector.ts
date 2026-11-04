import { DOM_MAP_JS, summarizeDom, type DomMap } from "./introspect.ts";
import { GUIDES, GUIDE_NAMES, type GuideName, type GuideStep } from "./guidelines.ts";
import { S, type Loc } from "./selectors.ts";
import { act, evalJson, openUrl } from "./agent.ts";
import { devices, requireLive } from "./registry.ts";
import { sleep } from "./sleep.ts";

export type CandidateResult = { candidate: string; kind: string; total: number; visible: number };
export type SelectorHealth = {
  key: string;
  screen: string;
  /** ok = resolves now, latent = only after another click, dead = nothing matches. */
  status: "ok" | "latent" | "dead";
  ok: boolean;
  matched: string | null;
  tried: number;
  candidates: CandidateResult[];
};

export type ScreenReport = {
  flow: GuideName;
  step: string;
  url: string;
  verifiedInGuide: string;
  ready: boolean;
  notes: string[];
  health: SelectorHealth[];
  controls: ReturnType<typeof summarizeDom> | null;
};

const PROBE_JS = (candidates: Array<Record<string, string>>) => `(() => {
  const norm = (value) => (value || '').replace(/\\s+/g, ' ').trim();
  const shown = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  return ${JSON.stringify(candidates)}.map((candidate) => {
    try {
      if (candidate.css) {
        const nodes = Array.from(document.querySelectorAll(candidate.css));
        return { kind: 'css', total: nodes.length, visible: nodes.filter(shown).length };
      }
      const value = (candidate.value || '').toLowerCase();
      const kind = candidate.find;
      let nodes = [];
      if (kind === 'text') {
        nodes = Array.from(document.querySelectorAll('button, a, div, span, li, [role="button"], [role="menuitem"]')).filter(
          (el) => shown(el) && norm(el.innerText).toLowerCase() === value,
        );
      } else if (kind === 'role') {
        nodes = Array.from(document.querySelectorAll('[role]')).filter((el) => shown(el) && norm(el.getAttribute('role')).toLowerCase() === value);
      } else if (kind === 'label') {
        nodes = Array.from(document.querySelectorAll('[aria-label]')).filter((el) => shown(el) && norm(el.getAttribute('aria-label')).toLowerCase() === value);
      } else if (kind === 'placeholder') {
        nodes = Array.from(document.querySelectorAll('[placeholder]')).filter((el) => shown(el) && norm(el.getAttribute('placeholder')).toLowerCase().includes(value));
      } else if (kind === 'alt') {
        nodes = Array.from(document.querySelectorAll('[alt]')).filter((el) => shown(el) && norm(el.getAttribute('alt')).toLowerCase().includes(value));
      }
      return { kind: 'find:' + kind, total: nodes.length, visible: nodes.length };
    } catch (error) {
      return { kind: 'error', total: 0, visible: 0, error: String(error) };
    }
  });
})()`;

function describeCandidate(loc: Loc): { arg: Record<string, string>; label: string } {
  if ("css" in loc) return { arg: { css: loc.css }, label: `css=${loc.css}` };
  return { arg: { find: loc.find, value: loc.value }, label: `find=${loc.find}(${loc.value})` };
}

/** Every selector key a screen depends on, taken from the guide so docs and code cannot drift. */
export function screenKeys(step: GuideStep): string[] {
  const keys: string[] = [];
  for (const control of step.controls) {
    if (control.key && !keys.includes(control.key)) keys.push(control.key);
  }
  return keys;
}

export type InspectableScreen = { flow: GuideName; step: GuideStep; url: string };

/** Resolves `<username>` in a guide URL so the same map works for any account. */
export function resolveScreenUrl(url: string, username: string | null): string | null {
  if (!url.includes("<")) return url;
  if (url.includes("<shortcode>")) return null;
  if (!username) return null;
  return url.replaceAll("<username>", username);
}

/** Which guide screens can be visited on this device (needs the handle for profile-shaped URLs). */
export function inspectableScreens(flows?: GuideName[], username: string | null = null): InspectableScreen[] {
  const wanted = flows && flows.length > 0 ? flows : GUIDE_NAMES;
  const out: InspectableScreen[] = [];
  for (const flow of wanted) {
    for (const step of GUIDES[flow]) {
      if (!step.url) continue;
      const url = resolveScreenUrl(step.url, username);
      if (url) out.push({ flow, step, url });
    }
  }
  return out;
}

export async function auditSelectors(
  deviceId: string,
  screen: string,
  keys: string[],
  latentKeys: Set<string> = new Set(),
): Promise<SelectorHealth[]> {
  const results: SelectorHealth[] = [];
  for (const key of keys) {
    const candidates = S[key as keyof typeof S] as Loc[] | undefined;
    if (!candidates || candidates.length === 0) {
      results.push({ key, screen, status: "dead", ok: false, matched: null, tried: 0, candidates: [] });
      continue;
    }
    const described = candidates.map(describeCandidate);
    const probe = await evalJson<CandidateResult[]>(
      deviceId,
      PROBE_JS(described.map((entry) => entry.arg)),
    ).catch(() => [] as CandidateResult[]);
    let matched: string | null = null;
    const merged: CandidateResult[] = described.map((entry, index) => {
      const result = probe[index] ?? { kind: "unknown", total: 0, visible: 0 };
      if (matched === null && result.visible > 0) matched = entry.label;
      return { candidate: entry.label, kind: result.kind, total: result.total, visible: result.visible };
    });
    const fileInputPresent = merged.some((candidate) => candidate.total > 0);
    const isFileKey = merged.some((candidate) => candidate.candidate.startsWith("css=input[type=\"file\""));
    const status: SelectorHealth["status"] =
      matched !== null || (isFileKey && fileInputPresent) ? "ok" : latentKeys.has(key) ? "latent" : "dead";
    results.push({ key, screen, status, ok: status === "ok", matched, tried: candidates.length, candidates: merged });
  }
  return results;
}

export type InspectOptions = {
  device: string;
  flows?: GuideName[];
  /** Navigate between screens; false audits only the current page. */
  navigate?: boolean;
  waitMs?: number;
  /** Overrides the device's saved handle for `<username>` URLs. */
  username?: string;
};

export async function inspectScreens(options: InspectOptions): Promise<{
  device: string;
  startedAt: string;
  screens: ScreenReport[];
  summary: { screens: number; ready: number; selectors: number; broken: number };
}> {
  const device = options.device;
  requireLive(device);
  const waitMs = options.waitMs ?? 3_000;
  const handle = options.username ?? devices.meta(device).handle ?? null;
  const screens = inspectableScreens(options.flows, handle);
  const reports: ScreenReport[] = [];

  for (const screen of screens) {
    const notes: string[] = [];
    let ready = false;
    if (options.navigate !== false) {
      try {
        await openUrl(device, screen.url);
        await sleep(waitMs);
        await prepareScreen(device, screen.flow);
        const landed = await evalJson<string>(device, "location.pathname").catch(() => "");
        const wanted = new URL(screen.url).pathname;
        if (landed && !landed.startsWith(wanted.replace(/\/$/, "")) && wanted !== "/") {
          notes.push(`redirected to ${landed} (Instagram moved us: already logged in, or the screen is gated)`);
        }
        ready = (await evalJson<boolean>(device, screen.step.ready).catch(() => false)) === true;
      } catch (error) {
        notes.push(`navigation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      ready = (await evalJson<boolean>(device, screen.step.ready).catch(() => false)) === true;
    }
    if (options.navigate !== false && !ready) notes.push("ready check false after navigation");
    const keys = screenKeys(screen.step);
    const latentKeys = new Set(
      screen.step.controls.filter((control) => control.key && control.when === "after-click").map((control) => control.key as string),
    );
    const health = ready ? await auditSelectors(device, `${screen.flow}:${screen.step.step}`, keys, latentKeys) : [];
    if (!ready) notes.push("selectors not audited because the screen never became ready");
    const emptyState = ready ? await evalJson<boolean>(
      device,
      `/(no (messages|conversations|notifications)|send a message to start a chat|start a chat)/i.test(document.body ? document.body.innerText : '')`,
    ).catch(() => false) : false;
    if (emptyState) notes.push("account shows an empty state here: a dead key may mean no data, not a broken selector");
    if (screen.flow === "create-post") {
      await act(device, ["press", "Escape"]).catch(() => undefined);
      await sleep(800);
    }
    const map = ready ? await evalJson<DomMap>(device, DOM_MAP_JS).catch(() => null) : null;
    reports.push({
      flow: screen.flow,
      step: screen.step.step,
      url: screen.url,
      verifiedInGuide: screen.step.verified,
      ready,
      notes,
      health,
      controls: map ? summarizeDom(map) : null,
    });
  }

  const selectors = reports.reduce((total, report) => total + report.health.length, 0);
  const broken = reports.reduce((total, report) => total + report.health.filter((entry) => entry.status === "dead").length, 0);
  return {
    device,
    startedAt: new Date().toISOString(),
    screens: reports,
    summary: {
      screens: reports.length,
      ready: reports.filter((report) => report.ready).length,
      selectors,
      broken,
    },
  };
}

/** Markdown report, written by `npm run inspect` and readable by any later agent. */
export function renderInspectReport(report: Awaited<ReturnType<typeof inspectScreens>>): string {
  const lines: string[] = [];
  lines.push(`# inspector report — ${report.device}`);
  lines.push("");
  lines.push(`Run at ${report.startedAt} · ${report.summary.screens} screens, ${report.summary.ready} ready, ${report.summary.selectors} selector keys audited, ${report.summary.broken} broken.`);
  lines.push("");
  lines.push("Reusable on any logged-in device: `npm run inspect -- --device <id>`. Every row below is what the live page actually answered, not what the guide hopes.");
  lines.push("");
  lines.push("| screen | url | ready | keys | dead | latent (only after a click) |");
  lines.push("|---|---|---|---|---|---|");
  for (const screen of report.screens) {
    const broken = screen.health.filter((entry) => entry.status === "dead").map((entry) => entry.key);
    const latent = screen.health.filter((entry) => entry.status === "latent").map((entry) => entry.key);
    lines.push(
      `| ${screen.flow}: ${screen.step} | \`${screen.url}\` | ${screen.ready ? "yes" : "no"} | ${screen.health.length} | ${broken.length > 0 ? broken.map((key) => `\`${key}\``).join(" ") : "—"} | ${latent.length > 0 ? latent.map((key) => `\`${key}\``).join(" ") : "—"} |`,
    );
  }
  lines.push("");
  for (const screen of report.screens) {
    lines.push(`## ${screen.flow} — ${screen.step}`);
    lines.push("");
    lines.push(`- url: \`${screen.url}\``);
    lines.push(`- guide status: ${screen.verifiedInGuide}`);
    lines.push(`- ready on live page: ${screen.ready ? "yes" : "no"}`);
    if (screen.notes.length > 0) lines.push(`- notes: ${screen.notes.join("; ")}`);
    lines.push("");
    if (screen.health.length > 0) {
      lines.push("| selector key | live | matched by | best candidate counts |");
      lines.push("|---|---|---|---|");
      for (const entry of screen.health) {
        const counts = entry.candidates
          .map((candidate) => `${candidate.visible}/${candidate.total} ${candidate.candidate}`)
          .join("; ");
        const badge = entry.status === "ok" ? "ok" : entry.status === "latent" ? "latent" : "**dead**";
        lines.push(`| \`${entry.key}\` | ${badge} | ${entry.matched ? `\`${entry.matched}\`` : "—"} | ${counts || "no candidates"} |`);
      }
      lines.push("");
    }
    if (screen.controls) {
      lines.push("live controls:");
      lines.push("");
      lines.push("| tag | label | text | href |");
      lines.push("|---|---|---|---|");
      for (const control of screen.controls.buttons.slice(0, 12)) {
        lines.push(`| ${control.tag} | ${control.aria ?? control.name ?? control.placeholder ?? "—"} | ${control.text || "—"} | ${control.href ?? "—"} |`);
      }
      for (const control of screen.controls.inputs.slice(0, 8)) {
        lines.push(`| ${control.tag} | ${control.aria ?? control.name ?? control.placeholder ?? "—"} | ${control.type ?? "—"} | — |`);
      }
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Selector keys used by any screen — handy for a "what does this project depend on" view. */
export function allScreenKeys(): Record<GuideName, string[]> {
  const out = {} as Record<GuideName, string[]>;
  for (const flow of GUIDE_NAMES) {
    const keys = new Set<string>();
    for (const step of GUIDES[flow]) for (const key of screenKeys(step)) keys.add(key);
    out[flow] = [...keys];
  }
  return out;
}

/** Opens the screen's dialog when the guide says one is needed (only side-effect-free prep). */
export async function prepareScreen(deviceId: string, flow: GuideName): Promise<void> {
  if (flow !== "create-post") return;
  if (!devices.live(deviceId)) return;
  // the svg is not clickable on its own: click the button that owns it, then wait for the dialog
  await evalJson<boolean>(
    deviceId,
    `(() => {
      const icon = document.querySelector('svg[aria-label="New post"]');
      const target = icon && (icon.closest('[role="button"], a, div[tabindex]') || icon.parentElement);
      if (!target) return false;
      target.click();
      return true;
    })()`,
  ).catch(() => false);
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const open = await evalJson<boolean>(deviceId, `!!document.querySelector('div[role="dialog"]')`).catch(() => false);
    if (open) return;
    await sleep(500);
  }
}
