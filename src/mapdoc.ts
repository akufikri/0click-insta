import { GUIDES, REPAIR_RECIPE, type GuideControl, type GuideName, type GuideStep } from "./guidelines.ts";
import { DOM_MAP_JS } from "./introspect.ts";

const SLUG: Record<GuideName, string> = {
  home: "home",
  "edit-caption": "edit-caption",
  login: "login",
  signup: "signup",
  "signup-code": "signup-code",
  challenge: "challenge",
  "create-post": "create-post",
  "post-modal": "post-modal",
  profile: "profile",
  "following-list": "following-list",
  feed: "feed",
  dm: "dm",
  notifications: "notifications",
  story: "story",
};

export function mapFile(flow: GuideName): string {
  return `${SLUG[flow]}-map.md`;
}

function badge(step: GuideStep): string {
  return step.verified === "live" ? `verified live${step.verifiedAt ? ` (${step.verifiedAt})` : ""}` : "unverified — probe before trusting";
}

function controlRow(control: GuideControl): string {
  const find = control.find.map((entry) => `\`${entry.replace(/\|/g, "\\|")}\``).join("<br>");
  const note = (control.note ?? "").replace(/\|/g, "\\|");
  return `| ${control.key ? `\`${control.key}\`` : "—"} | ${control.kind} | ${control.label.replace(/\|/g, "\\|")} | ${find} | ${note || "—"} |`;
}

function stepSection(step: GuideStep, index: number): string {
  const lines: string[] = [];
  lines.push(`## Step ${index + 1} — ${step.step}`);
  lines.push("");
  lines.push(`Status: **${badge(step)}**`);
  lines.push("");
  if (step.url) {
    lines.push(`URL: \`${step.url}\``);
    lines.push("");
  }
  if (step.notes) {
    lines.push(`Note: ${step.notes}`);
    lines.push("");
  }
  lines.push("Ready check — true when this screen is on display:");
  lines.push("");
  lines.push("```js");
  lines.push(step.ready);
  lines.push("```");
  lines.push("");
  lines.push("## Controls");
  lines.push("");
  lines.push("| selector key | kind | label a human sees | find (best first) | note |");
  lines.push("|---|---|---|---|---|");
  for (const control of step.controls) lines.push(controlRow(control));
  lines.push("");
  return lines.join("\n");
}

export function renderMap(flow: GuideName): string {
  const steps = GUIDES[flow];
  const verified = steps.some((step) => step.verified === "live");
  const out: string[] = [];
  out.push(`# ${flow} — selector map`);
  out.push("");
  out.push(
    `Screen map for the \`${flow}\` flow: ${steps.length} step${steps.length === 1 ? "" : "s"}, ${verified ? "at least one verified against the live page" : "none verified against the live page yet"}.`,
  );
  out.push("");
  out.push("Generated from `src/guidelines.ts` by `npm run maps` — edit the guide, never this file.");
  out.push("");
  out.push("## How to use this map");
  out.push("");
  out.push("1. Read the step whose ready check is true for the screen you are on.");
  out.push("2. Pick the control by its **label** and the **find** column. Class names change; labels are stable.");
  out.push("3. When the map is stale: run the probe below, compare, then fix `src/selectors.ts` (candidates, best first) and keep the key name.");
  out.push("4. Prove the fix with the smallest possible action before running a real tool.");
  out.push("");
  out.push("## Probe the live screen");
  out.push("");
  out.push("```");
  out.push(`ui_guide {"device":"<device>","flow":"${flow}"}`);
  out.push("```");
  out.push("");
  out.push("Raw DOM map (paste into `eval_page`):");
  out.push("");
  out.push("```js");
  out.push(DOM_MAP_JS);
  out.push("```");
  out.push("");
  for (const [index, step] of steps.entries()) out.push(stepSection(step, index).trimEnd());
  out.push("");
  out.push("## Repair procedure");
  out.push("");
  for (const line of REPAIR_RECIPE) out.push(`- ${line}`);
  out.push("");
  return `${out.join("\n")}\n`;
}

export function renderIndex(): string {
  const rows = (Object.keys(GUIDES) as GuideName[]).map((flow) => {
    const steps = GUIDES[flow];
    const live = steps.some((step) => step.verified === "live");
    return `| [${mapFile(flow)}](./${mapFile(flow)}) | ${flow} | ${steps.length} | ${live ? "yes" : "no"} |`;
  });
  return `# mapping/

Selector maps for every Instagram screen this server drives. One file per flow, generated from \`src/guidelines.ts\`.

| file | flow | steps | verified live |
|---|---|---|---|
${rows.join("\n")}

Regenerate after editing the guide:

\`\`\`bash
npm run maps
\`\`\`

## Run the inspector on any account

\`\`\`bash
npm run inspect -- --device <id>                  # every mapped screen
npm run inspect -- --device <id> --flows profile,dm
npm run inspect -- --device <id> --username someone_else
\`\`\`

Each run writes \`mapping/inspect/<timestamp>-<device>.md\`: per screen, whether the ready check fired, every selector key with **ok** or **dead**, which candidate matched, and the live controls it saw. Exit code 2 means something is dead. The same sweep is available to an agent as the MCP tool \`inspect_screens\`, so a new account (or a new Instagram deploy) is re-mapped with one call instead of guesswork.

The generated files are checked by \`npm test\`: if a map and the guide disagree, the test fails, so the docs cannot rot.

## Rules

- A **label** (aria-label, placeholder, nearby heading text) is the anchor. Class names and DOM depth are not.
- A **ready check** must be a JS expression that is true exactly when the step is on screen; it is what \`ui_guide\` and the flows both use.
- \`verified: "live"\` means a human-or-agent run on the real page on the date shown. Anything else is a starting guess and must be probed before use.
- Keys in the tables (\`loginUser\`, \`captionArea\`, …) are the names in \`src/selectors.ts\`. Never rename a key to paper over a DOM change: add a candidate instead.

## Add a flow

1. Write its steps in \`src/guidelines.ts\` (\`step\`, \`url?\`, \`ready\`, \`probe\`, \`controls\`, \`verified\`).
2. \`npm run maps\`.
3. Implement the flow in \`src/ig.ts\` using \`S\` keys, and the tool in \`src/server.ts\`.
4. Verify live and flip \`verified\` to \`"live"\` with today's date.
`;
}
