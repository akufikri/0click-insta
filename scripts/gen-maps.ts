import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GUIDE_NAMES } from "../src/guidelines.ts";
import { mapFile, renderIndex, renderMap } from "../src/mapdoc.ts";

const root = path.join(import.meta.dirname, "..", "mapping");
mkdirSync(root, { recursive: true });

const written: string[] = [];
for (const flow of GUIDE_NAMES) {
  const file = path.join(root, mapFile(flow));
  writeFileSync(file, renderMap(flow));
  written.push(path.relative(path.join(import.meta.dirname, ".."), file));
}
writeFileSync(path.join(root, "README.md"), renderIndex());
written.push("mapping/README.md");

process.stdout.write(`${written.join("\n")}\n${written.length} mapping files written\n`);
