import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolve, join } from "node:path";
import { sha256 } from "./history-files.mjs";
import {
  assembleMonthlyHistory,
  validatePublishedHistory,
} from "./monthly-history.mjs";

const root = resolve(import.meta.dirname, "..");
const manifest = validatePublishedHistory(
  JSON.parse(await readFile(join(root, "published-history.json"), "utf8")),
);
const cache = join(root, ".cache", "history-releases");
async function fetchArchive(asset) {
  const parts = new URL(asset.url).pathname.split("/");
  const directory = join(cache, parts.at(-2));
  const archive = join(directory, parts.at(-1));
  await mkdir(directory, { recursive: true });
  try {
    if (
      (await stat(archive)).size === asset.bytes &&
      (await sha256(archive)) === asset.sha256
    )
      return archive;
  } catch {}
  console.log(`Downloading ${parts.at(-1)}…`);
  const partial = archive + ".partial";
  try {
    const response = await fetch(asset.url, {
      signal: AbortSignal.timeout(15 * 60 * 1000),
    });
    if (!response.ok || !response.body)
      throw new Error(`History download failed: HTTP ${response.status}`);
    let received = 0;
    const limit = new Transform({
      transform(chunk, encoding, callback) {
        received += chunk.length;
        callback(
          received > asset.bytes
            ? new Error("History download exceeds expected size")
            : null,
          chunk,
        );
      },
    });
    await pipeline(
      Readable.fromWeb(response.body),
      limit,
      createWriteStream(partial),
    );
    if (received !== asset.bytes || (await sha256(partial)) !== asset.sha256)
      throw new Error("History archive checksum or size mismatch");
    await rename(partial, archive);
    return archive;
  } finally {
    await rm(partial, { force: true });
  }
}
const assets = [manifest.catalog, ...manifest.months];
const archives = new Map();
for (let i = 0; i < assets.length; i += 4) {
  const downloaded = await Promise.all(
    assets
      .slice(i, i + 4)
      .map(async (asset) => [asset.url, await fetchArchive(asset)]),
  );
  for (const [url, path] of downloaded) archives.set(url, path);
}
const target = join(root, "public-history");
await rm(target, { recursive: true, force: true });
try {
  await assembleMonthlyHistory(manifest, archives, target);
  console.log(
    `Verified ${manifest.runCount} runs in ${manifest.months.length} months; ready for the public history build.`,
  );
} catch (error) {
  await rm(target, { recursive: true, force: true });
  throw error;
}
