import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { packMonthlyHistory } from "./monthly-history.mjs";

const root = resolve(import.meta.dirname, "..");
const source = resolve(root, process.argv[2] || "private-data");
const tag = process.argv[3];
if (!tag || !/^[a-zA-Z0-9][\w.-]*$/.test(tag))
  throw new Error(
    "Usage: pnpm pack:history [source] <new-release-tag> [snapshot-date]",
  );
const manifestPath = join(root, "published-history.json");
const previous = JSON.parse(await readFile(manifestPath, "utf8"));
const oldUrl = previous.catalog?.url || previous.url;
const match =
  /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/releases\/download\//.exec(
    oldUrl,
  );
if (!match) throw new Error("Invalid previous release URL");
const output = join(root, ".cache", "history-releases", tag);
await mkdir(output, { recursive: true });
const manifest = await packMonthlyHistory(
  source,
  output,
  `https://github.com/${match[1]}/releases/download/${tag}`,
  {
    owner: previous.owner,
    snapshotDate: process.argv[4] || new Date().toISOString().slice(0, 10),
    previous: process.argv.includes("--reuse") ? previous : undefined,
  },
);
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
await writeFile(
  join(output, "published-history.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(
  `Prepared ${manifest.months.length} monthly packages and a catalog for ${manifest.runCount} runs in ${output}. Review before publishing.`,
);
