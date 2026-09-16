import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  rm,
  mkdir,
  readdir,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  verifyHistory,
  validateArchiveEntries,
  extractHistoryArchive,
} from "../scripts/history-files.mjs";

test("history rejects corrupt geometry and unreferenced files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "footpath-test-"));
  const packed = gzipSync('{"segments":[]}');
  const name = (buffer) =>
    createHash("sha256").update(buffer).digest("hex") + ".bin";
  const index = gzipSync(
    JSON.stringify({
      format: "footpath-studio-collection-v1",
      runs: [{ packedUrl: "/data/" + name(packed) }],
    }),
  );
  try {
    await writeFile(join(directory, name(packed)), packed);
    await writeFile(join(directory, name(index)), index);
    await writeFile(
      join(directory, "version.json"),
      JSON.stringify({
        format: "footpath-studio-public-v1",
        index: name(index),
      }),
    );
    assert.equal((await verifyHistory(directory)).runCount, 1);
    await writeFile(join(directory, "session.json"), "{}");
    await assert.rejects(verifyHistory(directory), /Unexpected/);
    await rm(join(directory, "session.json"));
    await writeFile(join(directory, name(packed)), "corrupt");
    await assert.rejects(verifyHistory(directory), /checksum/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("archive accepts only paired regular AppleDouble metadata without changing the data count", () => {
  const names = ["data/._version.json", "data/version.json"];
  assert.doesNotThrow(() => validateArchiveEntries(names, ["-rw", "-rw"], 1));
  assert.throws(() => validateArchiveEntries(names, ["-rw", "-rw"], 2));
  assert.throws(() => validateArchiveEntries(names, ["lrwxrwxrwx", "-rw"], 1));
  assert.throws(() =>
    validateArchiveEntries(["data/._version.json"], ["-rw"], 1),
  );
  assert.throws(() =>
    validateArchiveEntries(
      [...names, `data/._${"a".repeat(64)}.bin`],
      ["-rw", "-rw", "-rw"],
      1,
    ),
  );
  assert.throws(() =>
    validateArchiveEntries(
      [...names, "data/._session.json"],
      ["-rw", "-rw", "-rw"],
      1,
    ),
  );
});

test("native tar extraction discards macOS metadata on Linux and macOS", async () => {
  const directory = await mkdtemp(join(tmpdir(), "footpath-archive-"));
  const archive = join(directory, "history.tar");
  const target = join(directory, "extracted");
  const dataFile = `${"a".repeat(64)}.bin`;
  const names = ["version.json", dataFile];
  try {
    await mkdir(join(directory, "data"));
    await mkdir(target);
    for (const name of names) {
      await writeFile(join(directory, "data", name), `content: ${name}`);
      await writeFile(join(directory, "data", "._" + name), "metadata");
    }
    execFileSync(
      "tar",
      [
        "--format=ustar",
        "-cf",
        archive,
        "-C",
        directory,
        ...names.flatMap((name) => [`data/._${name}`, `data/${name}`]),
      ],
      { env: { ...process.env, COPYFILE_DISABLE: "1" } },
    );
    extractHistoryArchive(archive, target, names.length);
    assert.deepEqual(
      (await readdir(join(target, "data"))).sort(),
      names.sort(),
    );
    assert.equal(
      await readFile(join(target, "data", dataFile), "utf8"),
      `content: ${dataFile}`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("archive rejects path traversal, duplicate entries and symbolic links before extraction", () => {
  assert.doesNotThrow(() =>
    validateArchiveEntries(
      ["data/version.json"],
      ["-rw-r--r-- version.json"],
      1,
    ),
  );
  assert.throws(() =>
    validateArchiveEntries(["data/../../secret"], ["-rw"], 1),
  );
  assert.throws(() =>
    validateArchiveEntries(
      ["data/version.json", "data/version.json"],
      ["-rw", "-rw"],
      2,
    ),
  );
  assert.throws(() =>
    validateArchiveEntries(["data/version.json"], ["lrwxrwxrwx"], 1),
  );
});
