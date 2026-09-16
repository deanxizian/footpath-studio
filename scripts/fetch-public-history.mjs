import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import {
  sha256,
  verifyHistory,
  validateArchiveEntries,
} from "./history-files.mjs";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  await readFile(join(root, "published-history.json"), "utf8"),
);
if (
  !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\/[\w.-]+\/footpath-history\.tar$/.test(
    manifest.url,
  ) ||
  !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
  !Number.isSafeInteger(manifest.bytes) ||
  manifest.bytes <= 0 ||
  manifest.bytes >= 2 ** 31 ||
  !Number.isSafeInteger(manifest.fileCount) ||
  manifest.fileCount < 3 ||
  !Number.isSafeInteger(manifest.runCount) ||
  manifest.runCount < 1
)
  throw new Error("Invalid published history manifest");
const cache = join(root, ".cache");
const archive = join(cache, "footpath-history.tar");
await mkdir(cache, { recursive: true });
let cached = false;
try {
  cached =
    (await stat(archive)).size === manifest.bytes &&
    (await sha256(archive)) === manifest.sha256;
} catch {}
if (!cached) {
  console.log(
    `Downloading approved history snapshot (${manifest.runCount} runs)…`,
  );
  const partial = archive + ".partial";
  try {
    const response = await fetch(manifest.url, {
      signal: AbortSignal.timeout(15 * 60 * 1000),
    });
    if (!response.ok || !response.body)
      throw new Error(`History download failed: HTTP ${response.status}`);
    let received = 0;
    const limit = new Transform({
      transform(chunk, encoding, callback) {
        received += chunk.length;
        callback(
          received > manifest.bytes
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
    if (
      received !== manifest.bytes ||
      (await sha256(partial)) !== manifest.sha256
    )
      throw new Error("History archive checksum or size mismatch");
    await rename(partial, archive);
  } finally {
    await rm(partial, { force: true });
  }
}
const list = (flag) =>
  execFileSync("tar", [flag, archive], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  })
    .trimEnd()
    .split("\n");
validateArchiveEntries(list("-tf"), list("-tvf"), manifest.fileCount);
const target = join(root, "public-history");
await rm(target, { recursive: true, force: true });
await mkdir(target);
try {
  execFileSync("tar", [
    "-xf",
    archive,
    "-C",
    target,
    "--no-same-owner",
    "--no-same-permissions",
  ]);
  await verifyHistory(join(target, "data"), manifest);
  console.log(
    `Verified ${manifest.runCount} runs; ready for the public history build.`,
  );
} catch (error) {
  await rm(target, { recursive: true, force: true });
  throw error;
}
