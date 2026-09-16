import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { sha256, verifyHistory } from "./history-files.mjs";

// This command only prepares a local artifact. Publishing is a separate explicit step.
const root = resolve(import.meta.dirname, "..");
const source = resolve(root, process.argv[2] || "private-data");
const result = await verifyHistory(join(source, "data"));
const manifestPath = join(root, "published-history.json");
const previous = JSON.parse(await readFile(manifestPath, "utf8"));
const archive = join(root, ".cache", "footpath-history.tar");
await mkdir(join(root, ".cache"), { recursive: true });
execFileSync(
  "tar",
  [
    "--format=ustar",
    "-cf",
    archive,
    "-C",
    source,
    ...result.files.map((file) => `data/${file}`),
  ],
  { env: { ...process.env, COPYFILE_DISABLE: "1" } },
);
const manifest = {
  ...previous,
  sha256: await sha256(archive),
  bytes: (await stat(archive)).size,
  runCount: result.runCount,
  fileCount: result.fileCount,
  revision: result.revision,
};
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(
  `Prepared ${result.runCount} runs in ${archive}; review the manifest before publishing.`,
);
