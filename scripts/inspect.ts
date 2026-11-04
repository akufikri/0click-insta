import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inspectScreens, renderInspectReport } from "../src/inspector.ts";
import { GUIDE_NAMES, type GuideName } from "../src/guidelines.ts";
import { devices } from "../src/registry.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const device = flag("device") ?? process.env.IG_INSPECT_DEVICE ?? devices.list().find((meta) => devices.live(meta.id))?.id;
if (!device) {
  process.stderr.write("usage: npm run inspect -- --device <id> [--flows home,profile] [--username handle] [--out report.md]\n");
  process.stderr.write("no running device found; start one with device_start first\n");
  process.exit(1);
}

const flowsArg = flag("flows");
const flows = flowsArg
  ? (flowsArg.split(",").map((value) => value.trim()).filter((value) => GUIDE_NAMES.includes(value as GuideName)) as GuideName[])
  : undefined;

const report = await inspectScreens({ device, flows, navigate: true, username: flag("username") });
const markdown = renderInspectReport(report);

const root = path.join(import.meta.dirname, "..");
const out = flag("out") ?? path.join(root, "mapping", "inspect", `${report.startedAt.replace(/[:.]/g, "-")}-${device}.md`);
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, markdown);

process.stdout.write(`${markdown.split("\n").slice(0, 12).join("\n")}\n\n`);
process.stdout.write(`report: ${path.relative(root, out)}\n`);
process.stdout.write(
  `screens ${report.summary.ready}/${report.summary.screens} ready, selector keys ${report.summary.selectors}, broken ${report.summary.broken}\n`,
);
if (report.summary.broken > 0) process.exitCode = 2;
