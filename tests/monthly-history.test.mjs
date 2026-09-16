import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import {
  assembleMonthlyHistory,
  historyMonth,
  packMonthlyHistory,
  validatePublishedHistory,
  writeHistoryArchive,
} from "../scripts/monthly-history.mjs";
import {
  extractHistoryArchive,
  verifyHistory,
} from "../scripts/history-files.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("monthly grouping uses Shanghai run start, including UTC month/year boundaries", () => {
  const month = (iso) => historyMonth(Date.parse(iso) / 1000);
  assert.equal(month("2024-01-31T15:59:59Z"), "2024-01");
  assert.equal(month("2024-01-31T16:00:00Z"), "2024-02");
  assert.equal(month("2023-12-31T16:00:00Z"), "2024-01");
  assert.throws(() => historyMonth(NaN), /invalid/);
  assert.throws(() => historyMonth("1700000000"), /invalid/);
});

test("monthly packages are standalone, deterministic, and reconstruct the exact public dataset", async () => {
  const directory = await mkdtemp(join(tmpdir(), "footpath-months-"));
  const source = join(directory, "source");
  const data = join(source, "data");
  try {
    await mkdir(data, { recursive: true });
    const runs = [];
    for (const [i, iso] of [
      "2024-01-31T15:59:59Z",
      "2024-01-31T16:00:00Z",
      "2024-02-29T15:30:00Z",
    ].entries()) {
      const bytes = gzipSync(JSON.stringify({ segments: [], sample: i }));
      const name = hash(bytes) + ".bin";
      await writeFile(join(data, name), bytes);
      runs.push({
        id: `run-${i}`,
        start: Date.parse(iso) / 1000,
        rows:
          i === 1 ? Array.from({ length: 9 }, () => [2]) : [[i === 2 ? 6 : 3]],
        packedUrl: `/data/${name}`,
      });
    }
    const bytes = gzipSync(
      JSON.stringify({
        format: "footpath-studio-collection-v1",
        defaultSpeed: 3.5,
        rowFields: ["speed"],
        transformVersion: 2,
        runs,
      }),
    );
    const index = hash(bytes) + ".bin";
    await writeFile(join(data, index), bytes);
    await writeFile(
      join(data, "version.json"),
      JSON.stringify({
        format: "footpath-studio-public-v1",
        index,
        revision: "a".repeat(64),
      }),
    );
    const output = join(directory, "packages");
    const release = "https://github.com/example/footpath-studio";
    const manifest = await packMonthlyHistory(source, output, release, {
      owner: "example",
      snapshotDate: "2024-03-01",
    });
    // Exercise the actual Action packing entry point without a source config
    // file, and ensure a fork publishes URLs under its own repository.
    const cliOutput = join(directory, "cli-packages");
    execFileSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../scripts/pack-public-history.mjs", import.meta.url),
        ),
        "--source",
        source,
        "--output",
        cliOutput,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_ACTIONS: "true",
          GITHUB_REPOSITORY: "fork-owner/my-studio",
          VERCEL: "",
          VERCEL_GIT_REPO_OWNER: "",
          VERCEL_GIT_REPO_SLUG: "",
        },
      },
    );
    const cliManifest = JSON.parse(
      await readFile(join(cliOutput, "published-history.json"), "utf8"),
    );
    assert.equal(cliManifest.runCount, 3);
    assert.ok(
      [cliManifest.catalog, ...cliManifest.months].every((asset) =>
        asset.url.startsWith(
          "https://github.com/fork-owner/my-studio/releases/download/footpath-",
        ),
      ),
    );
    assert.deepEqual(
      manifest.months.map(({ month, runCount }) => [month, runCount]),
      [
        ["2024-01", 1],
        ["2024-02", 2],
      ],
    );
    const standalone = join(directory, "standalone");
    await mkdir(standalone);
    extractHistoryArchive(
      join(output, "footpath-2024-02", basename(manifest.months[1].url)),
      standalone,
      manifest.months[1].fileCount,
    );
    const february = await verifyHistory(
      join(standalone, "data"),
      manifest.months[1],
    );
    assert.equal(february.runCount, 2);
    // Nine slow fragments from one run must have the same weight as one fast
    // fragment from another run. The median of the two run medians is 4 m/s.
    assert.equal(february.history.defaultSpeed, 4);
    // Local file times must not churn unchanged monthly assets.
    for (const name of await readdir(data))
      await utimes(join(data, name), new Date(), new Date());
    const repacked = await packMonthlyHistory(
      source,
      join(directory, "repacked"),
      release,
      { owner: "example", snapshotDate: "2024-03-01" },
    );
    assert.deepEqual(repacked, manifest);
    const reusedOutput = join(directory, "reused");
    const reused = await packMonthlyHistory(source, reusedOutput, release, {
      owner: "example",
      snapshotDate: "2024-03-02",
    });
    assert.deepEqual(reused.months, manifest.months);
    // A fresh publication directory must retain every unchanged archive so
    // the publisher can repair remote upload damage without a previous cache.
    for (const asset of [reused.catalog, ...reused.months]) {
      const tag = new URL(asset.url).pathname.split("/").at(-2);
      const bytes = await readFile(
        join(reusedOutput, tag, basename(asset.url)),
      );
      assert.equal(bytes.length, asset.bytes);
      assert.equal(hash(bytes), asset.sha256);
      assert.deepEqual(
        bytes,
        await readFile(join(output, tag, basename(asset.url))),
      );
    }
    assert.equal(reused.catalog.url, manifest.catalog.url);
    assert.match(
      manifest.months[0].url,
      /download\/footpath-2024-01\/footpath-2024-01-[a-f0-9]{64}\.tar$/,
    );
    const archives = new Map(
      [manifest.catalog, ...manifest.months].map((asset) => [
        asset.url,
        join(
          output,
          new URL(asset.url).pathname.split("/").at(-2),
          basename(asset.url),
        ),
      ]),
    );
    const assembled = join(directory, "assembled");
    await assembleMonthlyHistory(manifest, archives, assembled);
    assert.deepEqual(
      (await readdir(join(assembled, "data"))).sort(),
      (await readdir(data)).sort(),
    );
    for (const name of await readdir(data))
      assert.deepEqual(
        await readFile(join(assembled, "data", name)),
        await readFile(join(data, name)),
      );
    assert.doesNotThrow(() => validatePublishedHistory(manifest));
    assert.throws(
      () =>
        validatePublishedHistory({
          ...manifest,
          months: [manifest.months[0], manifest.months[0]],
        }),
      /manifest/,
    );
    assert.throws(
      () =>
        validatePublishedHistory({
          ...manifest,
          months: manifest.months.slice(1),
        }),
      /manifest/,
    );
    assert.throws(
      () =>
        validatePublishedHistory({
          ...manifest,
          catalog: {
            ...manifest.catalog,
            url: "https://example.com/footpath-catalog.tar",
          },
        }),
      /manifest/,
    );
    assert.throws(
      () => validatePublishedHistory({ ...manifest, timeZone: "UTC" }),
      /manifest/,
    );
    // Each asset must contain the month named in the manifest, not just valid files.
    const swapped = new Map(archives);
    swapped.set(manifest.months[0].url, archives.get(manifest.months[1].url));
    await assert.rejects(
      assembleMonthlyHistory(manifest, swapped, join(directory, "swapped")),
      /archive paths|count mismatch|disagree/,
    );
    // Valid hashes and the right run count still cannot hide changed metadata.
    february.history.runs[0].title = "Unexpected title";
    const changedIndex = gzipSync(JSON.stringify(february.history));
    const changedRevision = hash(changedIndex);
    const changedArchive = join(directory, "changed.tar");
    await writeHistoryArchive(changedArchive, [
      {
        name: "data/version.json",
        bytes: Buffer.from(
          JSON.stringify({
            format: "footpath-studio-public-v1",
            index: changedRevision + ".bin",
            revision: changedRevision,
          }),
        ),
      },
      { name: `data/${changedRevision}.bin`, bytes: changedIndex },
      ...february.history.runs.map((run) => ({
        name: run.packedUrl.slice(1),
        path: join(standalone, run.packedUrl.slice(1)),
      })),
    ]);
    const changedManifest = {
      ...manifest,
      months: manifest.months.map((item, i) =>
        i === 1 ? { ...item, revision: changedRevision } : item,
      ),
    };
    const changedArchives = new Map(archives);
    changedArchives.set(manifest.months[1].url, changedArchive);
    await assert.rejects(
      assembleMonthlyHistory(
        changedManifest,
        changedArchives,
        join(directory, "changed"),
      ),
      /Monthly index and catalog disagree/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
