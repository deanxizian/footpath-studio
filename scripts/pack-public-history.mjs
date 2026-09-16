import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { packMonthlyHistory } from "./monthly-history.mjs";
import {
  validateHistorySource,
  validateSourceManifest,
} from "./history-source.mjs";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const value = (flag, fallback) => {
  const i = args.indexOf(flag);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith("--"))
    throw new Error(`Missing ${flag} argument`);
  return resolve(root, args[i + 1]);
};
const source = value("--source", join(root, "private-data"));
const output = value("--output", join(root, ".cache/monthly-publication"));
const config = validateHistorySource(
  JSON.parse(await readFile(join(root, "history-source.json"), "utf8")),
);
const previousFile = value("--previous");
const previous = previousFile
  ? validateSourceManifest(
      JSON.parse(await readFile(previousFile, "utf8")),
      config.repository,
    )
  : undefined;
await mkdir(output, { recursive: true });
const manifest = await packMonthlyHistory(
  source,
  output,
  `https://github.com/${config.repository}`,
  {
    owner: config.repository.split("/")[0],
    snapshotDate: new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
    }).format(new Date()),
    previous,
  },
);
await writeFile(
  join(output, "published-history.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(
  `Prepared ${manifest.runCount} runs across ${manifest.months.length} monthly Releases in ${output}. No source files changed.`,
);
