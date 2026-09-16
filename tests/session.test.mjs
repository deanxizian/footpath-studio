import test from "node:test";
import assert from "node:assert/strict";
import { createDemoRun, createDemoSession } from "../src/demo.js";
import {
  createSession,
  readRunFiles,
  MAX_FILE_BYTES,
  MAX_BATCH_BYTES,
} from "../src/session.js";
import { expandHistory, loadRunData } from "../src/history-model.js";

const file = (name, raw) => ({
  name,
  size: JSON.stringify(raw).length,
  text: async () => JSON.stringify(raw),
});
test("demo opens without a network or account and keeps recorded sides", async () => {
  const session = createDemoSession();
  assert.equal(session.source, "demo");
  const runs = expandHistory(session.history);
  assert.equal(runs.length, 24);
  assert.ok(
    runs.every((run) => !run.packedUrl && run.title.includes("合成演示")),
  );
  const data = await loadRunData(runs.at(-1));
  assert.equal(data, session.initialData);
  assert.equal(data.leftCount, 48);
  assert.equal(data.rightCount, 48);
  assert.equal(data.pointCount, 96 * 65);
});

test("personal session sorts and deduplicates imports without adding demo runs", async () => {
  const runs = await readRunFiles([
    file("later.json", createDemoRun(2)),
    file("early.json", createDemoRun(0)),
    file("duplicate.json", createDemoRun(2)),
  ]);
  const session = createSession(runs);
  assert.equal(session.source, "imported");
  assert.equal(session.history.runs.length, 2);
  assert.ok(session.history.runs[0].start < session.history.runs[1].start);
  assert.equal(session.initialData.start, session.history.runs[1].start);
});

test("an invalid batch fails as a whole and size limits run before any file read", async () => {
  await assert.rejects(
    readRunFiles([
      file("good.json", createDemoRun(0)),
      { name: "broken.json", size: 1, text: async () => "{" },
    ]),
    /broken.json/,
  );
  let reads = 0;
  const oversized = {
    name: "large.json",
    size: MAX_FILE_BYTES + 1,
    text: async () => {
      reads++;
      return "{}";
    },
  };
  await assert.rejects(readRunFiles([oversized]), /128 MB/);
  await assert.rejects(
    readRunFiles(
      Array.from({ length: 3 }, () => ({
        ...oversized,
        size: Math.ceil(MAX_BATCH_BYTES / 3),
      })),
    ),
    /256 MB/,
  );
  assert.equal(reads, 0);
});
