import assert from "node:assert/strict";
import path from "node:path";
import { evalJson, openUrl } from "../src/agent.ts";
import { devices } from "../src/registry.ts";
import { CdpConnection, cdpTargets } from "../src/stealth.ts";
import { planTrajectory } from "../src/humanmouse.ts";
import { sleep } from "../src/sleep.ts";

const device = process.env.IG_TEST_DEVICE ?? "";
const fixture = path.join(import.meta.dirname, "fixtures", "checkbox.html");

if (!device) {
  process.stdout.write("cursor: skipped (set IG_TEST_DEVICE to a started device)\n");
  process.exit(0);
}
const live = devices.live(device);
if (!live) {
  process.stderr.write(`cursor: device ${device} is not running\n`);
  process.exit(1);
}

await openUrl(device, `file://${fixture}`);
const targets = await cdpTargets(live.cdpPort);
const page = targets.find((target) => target.type === "page" && target.url.includes("checkbox.html"));
assert.ok(page?.webSocketDebuggerUrl, "fixture page target not found");

const connection = await CdpConnection.connect(page.webSocketDebuggerUrl);
const geometry = await connection.send<{ result: { value: { x: number; y: number; w: number; h: number } } }>(
  "Runtime.evaluate",
  { returnByValue: true, expression: `(() => { const r = document.getElementById('anchor').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()` },
);
const box = geometry.result.value;
const target = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
const from = { x: 60, y: 400 };
const trajectory = planTrajectory(from, target, { seed: 7 });

for (const step of trajectory) {
  await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: step.x, y: step.y, button: "none", timestamp: Date.now() / 1000 });
  await sleep(Math.min(step.delayMs, 12));
}
await connection.send("Input.dispatchMouseEvent", { type: "mousePressed", x: target.x, y: target.y, button: "left", clickCount: 1 });
await sleep(60);
await connection.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1 });
connection.close();

const observed = await evalJson<{ moves: Array<{ x: number; y: number; t: number }>; clicks: Array<{ x: number; y: number }> }>(
  device,
  "({ moves: window.__moves, clicks: window.__clicks })",
);

assert.ok(observed.moves.length >= 8, `page saw only ${observed.moves.length} mouse moves`);
const last = observed.moves[observed.moves.length - 1];
assert.equal(last.x, target.x, "cursor did not land on the target x");
assert.equal(last.y, target.y, "cursor did not land on the target y");
assert.equal(observed.clicks.length, 1, `expected exactly one press, saw ${observed.clicks.length}`);
assert.equal(observed.clicks[0].x, target.x);
const straight = Math.hypot(target.x - from.x, target.y - from.y);
const bow = Math.max(
  ...observed.moves.map((point) =>
    Math.abs((target.x - from.x) * (from.y - point.y) - (from.x - point.x) * (target.y - from.y)) / straight,
  ),
);
assert.ok(bow > 1, `cursor path in the browser was straight (max ${bow.toFixed(2)}px off the line)`);
const span = observed.moves[observed.moves.length - 1].t - observed.moves[0].t;
assert.ok(span > 40, `cursor moved too fast: ${span}ms`);
process.stdout.write(
  `cursor: ${observed.moves.length} real mousemove events, ${straight.toFixed(0)}px straight line, ${bow.toFixed(1)}px bow, ${span}ms, one press exactly on target\n`,
);
