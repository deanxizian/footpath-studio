import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolve, join } from "node:path";
import {
  sha256,
  extractHistoryArchive,
  readHistoryIndex,
} from "./history-files.mjs";
import {
  assembleMonthlyHistory,
  validatePublishedHistory,
} from "./monthly-history.mjs";
import { fetchPublishedHistory, resolveRepository } from "./history-source.mjs";

const root = resolve(import.meta.dirname, "..");
const argument = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  if (i < 0) return fallback;
  if (!process.argv[i + 1] || process.argv[i + 1].startsWith("--"))
    throw new Error(`Missing ${flag} argument`);
  return resolve(root, process.argv[i + 1]);
};
const catalogOnly = process.argv.includes("--catalog-only");
const manifestFile = argument("--manifest");
const manifest = manifestFile
  ? validatePublishedHistory(JSON.parse(await readFile(manifestFile, "utf8")))
  : await fetchPublishedHistory(resolveRepository({ cwd: root }));
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
const assets = [manifest.catalog, ...(catalogOnly ? [] : manifest.months)];
const archives = new Map();
for (let i = 0; i < assets.length; i += 4) {
  const downloaded = await Promise.all(
    assets
      .slice(i, i + 4)
      .map(async (asset) => [asset.url, await fetchArchive(asset)]),
  );
  for (const [url, path] of downloaded) archives.set(url, path);
}
const target = argument("--target", join(root, "public-history"));
await rm(target, { recursive: true, force: true });
try {
  if (catalogOnly) {
    await mkdir(target, { recursive: true });
    extractHistoryArchive(archives.get(manifest.catalog.url), target, 2);
    const { version, history } = await readHistoryIndex(join(target, "data"));
    if (
      history.runs.length !== manifest.runCount ||
      version.revision !== manifest.revision
    )
      throw new Error("Catalog and manifest disagree");
  } else await assembleMonthlyHistory(manifest, archives, target);
  await mkdir(join(root, ".cache"), { recursive: true });
  await writeFile(
    join(root, ".cache/published-history.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  console.log(
    catalogOnly
      ? `Catalog verified: ${manifest.runCount} runs in ${manifest.months.length} months.`
      : `Verified ${manifest.runCount} runs in ${manifest.months.length} months; ready for the public history build.`,
  );
} catch (error) {
  await rm(target, { recursive: true, force: true });
  throw error;
}
