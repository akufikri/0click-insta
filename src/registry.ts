import { DeviceManager } from "./device.ts";
import type { LiveBrowser } from "./device.ts";
import { fail } from "./errors.ts";
import { paneCommand } from "./tb.ts";

export const devices = new DeviceManager();

export function requireLive(id: string): LiveBrowser {
  const live = devices.live(id);
  if (!live) {
    const command = safePaneCommand(id);
    fail(
      "DeviceNotRunning",
      `no terminal-browser running for device ${id} — start it with device_start, or run in a terminal pane: ${command}`,
      { command },
    );
  }
  return live;
}

function safePaneCommand(id: string): string {
  try {
    return paneCommand(id, devices.root);
  } catch {
    return `~/.0click/instagram/bin/pane.sh ${id}`;
  }
}
