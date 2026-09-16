import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  verifyHistory,
  validateArchiveEntries,
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
