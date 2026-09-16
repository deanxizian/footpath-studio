import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { fetchDataBytes, loadHistory } from "../src/site-data.js";
import { loadRunData, clearRunCache } from "../src/history-model.js";

const filename = (bytes) =>
  createHash("sha256").update(bytes).digest("hex") + ".bin";
globalThis.window = {
  location: { href: "https://example.test/", origin: "https://example.test" },
};

test("public files load without credentials and reject external paths or corrupt contents", async () => {
  const bytes = gzipSync('{"x":-0,"y":1.2}');
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return new Response(bytes);
  };
  try {
    assert.deepEqual(
      await fetchDataBytes("/data/" + filename(bytes)),
      new Uint8Array(bytes),
    );
    assert.equal(calls[0].length, 1);
    assert.equal(calls[0][0], "https://example.test/data/" + filename(bytes));
    await assert.rejects(
      fetchDataBytes("https://external.test/data/" + filename(bytes)),
    );
    await assert.rejects(fetchDataBytes("/secret.json"));
    assert.equal(calls.length, 1);
    globalThis.fetch = async () => new Response("corrupt data");
    await assert.rejects(fetchDataBytes("/data/" + filename(bytes)), /校验/);
  } finally {
    globalThis.fetch = previous;
  }
});

test("public run geometry loads lazily and retains negative zero", async () => {
  const raw =
    '{"format":"footpath-studio-v1","title":"Fixture","segments":[{"side":1,"timestamp":100,"timestamp_frac":0,"speed":3.5,"power":200,"points":[[-0,0,0],[1,0.2,0.3],[0,0,0]]}]}';
  const bytes = gzipSync(raw);
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(bytes);
  };
  try {
    clearRunCache();
    const run = { id: "fixture", packedUrl: "/data/" + filename(bytes) };
    const first = await loadRunData(run),
      second = await loadRunData(run);
    assert.equal(first, second);
    assert.equal(calls, 1);
    assert.equal(first.pointCount, 3);
    assert.equal(Object.is(first.segments[0].points[0][0], -0), true);
  } finally {
    globalThis.fetch = previous;
    clearRunCache();
  }
});

test("history loads without a key and rejects an empty collection", async () => {
  const previous = globalThis.fetch;
  const history = {
    format: "footpath-studio-collection-v1",
    runs: [{ id: "fixture" }],
  };
  let bytes = gzipSync(JSON.stringify(history));
  globalThis.fetch = async (url) =>
    new Response(
      String(url).endsWith("version.json")
        ? JSON.stringify({
            format: "footpath-studio-public-v1",
            index: filename(bytes),
          })
        : bytes,
    );
  try {
    assert.deepEqual(await loadHistory(), history);
    bytes = gzipSync(JSON.stringify({ ...history, runs: [] }));
    await assert.rejects(loadHistory(), /还没有/);
  } finally {
    globalThis.fetch = previous;
  }
});

test("failed downloads can be retried without a stale cached failure", async () => {
  const bytes = gzipSync(
    '{"format":"footpath-studio-v1","segments":[{"side":2,"timestamp":100,"points":[[0,0,0],[1,1,1]]}]}',
  );
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () =>
    ++calls === 1 ? new Response("", { status: 503 }) : new Response(bytes);
  try {
    clearRunCache();
    const run = { id: "retry", packedUrl: "/data/" + filename(bytes) };
    await assert.rejects(loadRunData(run), /503/);
    assert.equal((await loadRunData(run)).pointCount, 2);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = previous;
    clearRunCache();
  }
});
