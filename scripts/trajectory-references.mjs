import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { readHistoryIndex } from "./history-files.mjs";
import { expandHistory } from "../src/history-model.js";
import { prepareRuns } from "../src/analysis-model.js";
import { normalizeData } from "../src/model.js";
import {
  runTrajectories,
  TRAJECTORY_VERSION,
} from "../src/trajectory-model.js";

// Derived build assets only: original Release archives and sync data stay intact.
export async function buildTrajectoryReferences(directory, cacheDirectory) {
  const { version, history } = await readHistoryIndex(directory);
  await mkdir(cacheDirectory, { recursive: true });
  const references = {};
  for (const run of prepareRuns(expandHistory(history))) {
    const signature = createHash("sha256")
      .update(JSON.stringify([TRAJECTORY_VERSION, run.packedUrl, run.rows]))
      .digest("hex");
    const cacheFile = join(cacheDirectory, signature + ".json");
    let entry;
    try {
      entry = JSON.parse(await readFile(cacheFile, "utf8"));
    } catch {
      if (!/^\/data\/[a-f0-9]{64}\.bin$/.test(run.packedUrl))
        throw new Error("Invalid trajectory data path");
      const bytes = await readFile(join(directory, run.packedUrl.slice(6)));
      if (
        createHash("sha256").update(bytes).digest("hex") !==
        run.packedUrl.slice(6, -4)
      )
        throw new Error("Trajectory checksum mismatch");
      const data = normalizeData(JSON.parse(gunzipSync(bytes)));
      entry = runTrajectories(data, run.eligible, run.summary);
      await writeFile(cacheFile, JSON.stringify(entry));
    }
    references[run.id] = entry;
  }
  return JSON.stringify({
    format: "footpath-trajectory-references-v1",
    version: TRAJECTORY_VERSION,
    revision: version.revision,
    runs: references,
  });
}
