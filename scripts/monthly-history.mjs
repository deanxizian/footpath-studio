import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gzipSync } from "node:zlib";
import {
  DATA_FILE,
  extractHistoryArchive,
  readHistoryIndex,
  sha256,
  verifyHistory,
} from "./history-files.mjs";

export const HISTORY_TIME_ZONE = "Asia/Shanghai";
const monthPattern = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const monthFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: HISTORY_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
});
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function historyMonth(start) {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(new Date(start * 1000).getTime())
  )
    throw new Error("History run has an invalid start time");
  const parts = Object.fromEntries(
    monthFormatter
      .formatToParts(new Date(start * 1000))
      .map(({ type, value }) => [type, value]),
  );
  const month = `${parts.year}-${parts.month}`;
  if (!monthPattern.test(month)) throw new Error("Unsupported history month");
  return month;
}

export function groupHistoryMonths(runs) {
  const groups = new Map();
  for (const run of runs) {
    const month = historyMonth(run.start);
    if (!groups.has(month)) groups.set(month, []);
    groups.get(month).push(run);
  }
  return new Map(
    [...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, values]) => [
        month,
        values.sort(
          (a, b) =>
            a.start - b.start || String(a.id).localeCompare(String(b.id)),
        ),
      ]),
  );
}

export function validatePublishedHistory(manifest) {
  const positive = (value) => Number.isSafeInteger(value) && value > 0;
  const validAsset = (asset, name) =>
    asset &&
    typeof asset.url === "string" &&
    /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\/[a-zA-Z0-9][\w.-]*\/[^/]+$/.test(
      asset.url,
    ) &&
    asset.url.endsWith("/" + name) &&
    /^[a-f0-9]{64}$/.test(asset.sha256) &&
    positive(asset.bytes) &&
    asset.bytes < 2 ** 31 &&
    positive(asset.fileCount);
  if (
    manifest?.format !== "footpath-studio-monthly-history-v1" ||
    manifest.timeZone !== HISTORY_TIME_ZONE ||
    !positive(manifest.runCount) ||
    !positive(manifest.fileCount) ||
    !/^[a-f0-9]{64}$/.test(manifest.revision) ||
    !validAsset(manifest.catalog, "footpath-catalog.tar") ||
    manifest.catalog.fileCount !== 2 ||
    !Array.isArray(manifest.months) ||
    !manifest.months.length ||
    new Set(manifest.months.map((item) => item.month)).size !==
      manifest.months.length ||
    manifest.months.some(
      (item) =>
        !monthPattern.test(item.month) ||
        !validAsset(item, `footpath-${item.month}.tar`) ||
        !positive(item.runCount) ||
        item.fileCount < 3 ||
        !/^[a-f0-9]{64}$/.test(item.revision),
    ) ||
    manifest.months.reduce((total, item) => total + item.runCount, 0) !==
      manifest.runCount
  )
    throw new Error("Invalid monthly history manifest");
  return manifest;
}

// Fixed USTAR headers make unchanged monthly packages byte-for-byte reusable
// across macOS and Linux, without copying host ownership, timestamps or xattrs.
export async function writeHistoryArchive(archive, entries) {
  const ordered = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  if (
    !ordered.length ||
    new Set(ordered.map(({ name }) => name)).size !== ordered.length ||
    ordered.some(
      ({ name }) => !name.startsWith("data/") || !DATA_FILE.test(name.slice(5)),
    )
  )
    throw new Error("Invalid history archive entries");
  async function* contents() {
    for (const entry of ordered) {
      const bytes = entry.bytes;
      const size = bytes ? bytes.length : (await stat(entry.path)).size;
      if (!Number.isSafeInteger(size) || size < 0 || size >= 2 ** 31)
        throw new Error("Unsupported history file size");
      const header = Buffer.alloc(512);
      header.write(entry.name, 0, 100, "ascii");
      const octal = (offset, width, value) =>
        header.write(
          value.toString(8).padStart(width - 1, "0") + "\0",
          offset,
          width,
          "ascii",
        );
      octal(100, 8, 0o644);
      octal(108, 8, 0);
      octal(116, 8, 0);
      octal(124, 12, size);
      octal(136, 12, 0);
      header.fill(32, 148, 156);
      header[156] = 48;
      header.write("ustar\0", 257, "ascii");
      header.write("00", 263, "ascii");
      header.write(
        header
          .reduce((sum, byte) => sum + byte, 0)
          .toString(8)
          .padStart(6, "0") + "\0 ",
        148,
        8,
        "ascii",
      );
      yield header;
      if (bytes) yield bytes;
      else yield* createReadStream(entry.path);
      if (size % 512) yield Buffer.alloc(512 - (size % 512));
    }
    yield Buffer.alloc(1024);
  }
  await pipeline(Readable.from(contents()), createWriteStream(archive));
}

export async function packMonthlyHistory(
  source,
  output,
  releaseBaseUrl,
  metadata,
) {
  if (
    !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\/[a-zA-Z0-9][\w.-]*$/.test(
      releaseBaseUrl,
    )
  )
    throw new Error("Invalid history release URL");
  const data = join(source, "data");
  const verified = await verifyHistory(data);
  const history = verified.history;
  await mkdir(output, { recursive: true });
  const packageAsset = async (name, entries) => {
    const archive = join(output, name);
    await writeHistoryArchive(archive, entries);
    return {
      url: `${releaseBaseUrl}/${name}`,
      sha256: await sha256(archive),
      bytes: (await stat(archive)).size,
      fileCount: entries.length,
    };
  };
  const catalog = await packageAsset(
    "footpath-catalog.tar",
    ["version.json", verified.index].map((name) => ({
      name: `data/${name}`,
      path: join(data, name),
    })),
  );
  const months = [];
  for (const [month, runs] of groupHistoryMonths(history.runs)) {
    const speedIndex = history.rowFields?.indexOf("speed") ?? -1;
    const speeds = runs
      .flatMap((run) => run.rows.map((row) => row[speedIndex]))
      .filter((value) => Number.isFinite(value) && value > 0)
      .sort((a, b) => a - b);
    const monthly = {
      format: history.format,
      rowFields: history.rowFields,
      transformVersion: history.transformVersion,
      defaultSpeed: speeds.length
        ? Math.round(speeds[Math.floor(speeds.length / 2)] * 20) / 20
        : 3.5,
      runs,
    };
    const indexBytes = gzipSync(JSON.stringify(monthly));
    const revision = digest(indexBytes);
    const index = revision + ".bin";
    const version = Buffer.from(
      JSON.stringify({ format: "footpath-studio-public-v1", index, revision }),
    );
    const geometry = [
      ...new Set(runs.map((run) => run.packedUrl.slice("/data/".length))),
    ];
    const asset = await packageAsset(`footpath-${month}.tar`, [
      { name: "data/version.json", bytes: version },
      { name: `data/${index}`, bytes: indexBytes },
      ...geometry.map((name) => ({
        name: `data/${name}`,
        path: join(data, name),
      })),
    ]);
    months.push({ month, ...asset, runCount: runs.length, revision });
  }
  return validatePublishedHistory({
    format: "footpath-studio-monthly-history-v1",
    snapshotDate: metadata.snapshotDate,
    owner: metadata.owner,
    timeZone: HISTORY_TIME_ZONE,
    runCount: verified.runCount,
    fileCount: verified.fileCount,
    revision: verified.revision,
    catalog,
    months,
  });
}

export async function assembleMonthlyHistory(manifest, archives, target) {
  validatePublishedHistory(manifest);
  await mkdir(target, { recursive: true });
  const staging = await mkdtemp(join(target, ".months-"));
  try {
    extractHistoryArchive(archives.get(manifest.catalog.url), target, 2);
    const { history } = await readHistoryIndex(join(target, "data"));
    const groups = groupHistoryMonths(history.runs);
    if (
      groups.size !== manifest.months.length ||
      manifest.months.some(
        (item) => groups.get(item.month)?.length !== item.runCount,
      )
    )
      throw new Error("Monthly manifest and catalog disagree");
    for (const month of manifest.months) {
      const directory = join(staging, month.month);
      await mkdir(directory);
      extractHistoryArchive(
        archives.get(month.url),
        directory,
        month.fileCount,
      );
      const data = join(directory, "data");
      const verified = await verifyHistory(data, month);
      if (
        JSON.stringify(verified.history.runs) !==
        JSON.stringify(groups.get(month.month))
      )
        throw new Error(`Monthly index and catalog disagree: ${month.month}`);
      for (const name of new Set(
        verified.history.runs.map((run) =>
          run.packedUrl.slice("/data/".length),
        ),
      ))
        await copyFile(join(data, name), join(target, "data", name));
      await rm(directory, { recursive: true, force: true });
    }
    await verifyHistory(join(target, "data"), manifest);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
