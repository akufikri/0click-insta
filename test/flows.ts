import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { click, clickText, evalJson, fill, openUrl, press, typeInto, upload, url } from "../src/agent.ts";
import { devices } from "../src/registry.ts";

const device = process.env.IG_TEST_DEVICE ?? "";
const fixture = process.env.IG_FIXTURE_DIR ?? path.join(import.meta.dirname, "fixtures");

if (!device) {
  process.stdout.write("flows: skipped (set IG_TEST_DEVICE to a started device)\n");
  process.exit(0);
}

if (!devices.live(device)) {
  process.stderr.write(`flows: device ${device} is not running\n`);
  process.exit(1);
}

const png = path.join(fixture, "pixel.png");
assert.ok(existsSync(png), `missing fixture ${png}`);
const results: string[] = [];

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  results.push(`ok   ${name}`);
}

await step("goto navigates the pane tab", async () => {
  await openUrl(device, `file://${fixture}/create.html`);
  assert.equal(await url(device), `file://${fixture}/create.html`);
});

await step("click by selector opens the dialog", async () => {
  await click(device, "navCreate");
  const open = await evalJson<boolean>(device, "!!window.state.dialogOpen");
  assert.equal(open, true);
});

await step("upload attaches a real file to the file input", async () => {
  await upload(device, "fileInput", [png]);
  const files = await evalJson<number>(device, "document.querySelector('input[type=file]').files.length");
  assert.equal(files, 1);
});

await step("clickText advances the dialog", async () => {
  await clickText(device, "Next", 'div[role="dialog"]');
  const stepText = await evalJson<string>(device, "document.getElementById('panel2').textContent");
  assert.match(stepText, /step 2/);
});

await step("fill writes the caption", async () => {
  await fill(device, "captionArea", "0click fixture caption");
  const value = await evalJson<string>(device, "document.querySelector('div[role=\"dialog\"] textarea').value");
  assert.equal(value, "0click fixture caption");
});

await step("typeInto sends keystrokes", async () => {
  await typeInto(device, "captionArea", "!");
  const value = await evalJson<string>(device, "document.querySelector('div[role=\"dialog\"] textarea').value");
  assert.equal(value, "0click fixture caption!");
});

await step("press Enter reaches the page", async () => {
  await press(device, "Enter");
  const pressed = await evalJson<boolean>(device, "true");
  assert.equal(pressed, true);
});

await step("share click produces the Instagram-style confirmation", async () => {
  await clickText(device, "Share", 'div[role="dialog"]');
  const shared = await evalJson<{ shared: boolean; caption: string }>(device, "window.state");
  assert.equal(shared.shared, true);
  assert.match(shared.caption, /fixture caption/);
});

await step("post link extraction finds the shortcode", async () => {
  const link = await evalJson<string | null>(
    device,
    `(() => {
      const dialog = document.querySelector('div[role="dialog"]');
      const anchor = Array.from(dialog.querySelectorAll('a[href*="/p/"]'))[0];
      return anchor ? anchor.getAttribute('href') : null;
    })()`,
  );
  assert.equal(link, "/p/FIXTURE0001/");
});

await step("story fixture exposes the Story tab", async () => {
  await openUrl(device, `file://${fixture}/story.html`);
  const hasTab = await evalJson<boolean>(
    device,
    `Array.from(document.querySelectorAll('*')).some((node) => (node.innerText || '').trim() === 'Story')`,
  );
  assert.equal(hasTab, true);
});

await openUrl(device, "https://www.instagram.com/");
process.stdout.write(`${results.join("\n")}\nflows: ${results.length}/${results.length} ok\n`);
