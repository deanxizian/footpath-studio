import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  prepareRuns,
  recentBaseline,
  selectStage,
} from "../src/analysis-model.js";
import { createDemoRun } from "../src/demo.js";
import { runFromRaw, ROW_FIELDS } from "../src/history-model.js";
import {
  averageTrajectories,
  baselineTrajectories,
  comparisonTrajectories,
  resampleTrajectory,
  runTrajectories,
  trajectoryBounds,
} from "../src/trajectory-model.js";
import { buildTrajectoryReferences } from "../scripts/trajectory-references.mjs";

const curve = (scale) =>
  resampleTrajectory([
    [0, 0, 0],
    [-scale, 0.1 * scale, 0.3 * scale],
    [0, 0, 0],
  ]);
const reference = (scale, n = 10) => ({
  1: { points: curve(scale), n },
  2: { points: curve(scale * 2), n },
});
const almost = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);

test("cycle interpolation aligns the origin, preserves amplitude and variable sample counts", () => {
  const a = resampleTrajectory([
    [2, 3, 4],
    [1, 4, 6],
    [2, 3, 4],
  ]);
  const b = resampleTrajectory([
    [0, 0, 0],
    [-0.5, 0.5, 1],
    [-1, 1, 2],
    [-0.5, 0.5, 1],
    [0, 0, 0],
  ]);
  assert.equal(a.length, 101);
  for (let i = 0; i < a.length; i++)
    for (let axis = 0; axis < 3; axis++) almost(a[i][axis], b[i][axis]);
  assert.deepEqual(a[50], [-1, 1, 2]);
  assert.deepEqual(a[0], [0, 0, 0]);
  assert.deepEqual(a[100], [0, 0, 0]);
});

test("missing, malformed and zero-length trajectories cannot produce a renderable curve", () => {
  for (const points of [
    null,
    [],
    [[0, 0, 0]],
    [
      [0, 0, 0],
      [NaN, 0, 0],
    ],
    [
      [2, 2, 2],
      [2, 2, 2],
    ],
  ])
    assert.equal(resampleTrajectory(points), null);
  assert.equal(averageTrajectories([]), null);
  assert.equal(averageTrajectories([Array(101).fill([NaN, 0, 0])]), null);
});

test("90-day trajectory baseline gives runs equal weight, includes the anchor and excludes later runs", () => {
  const day = 86400;
  const runs = prepareRuns(
    [1, 2, 3, 4].map((i) => ({
      id: String(i),
      start: i * day,
      end: i * day + 60,
      rows: [],
    })),
  );
  const baseline = recentBaseline(runs, runs[2]);
  const result = baselineTrajectories(baseline.runs, {
    1: reference(1, 1000),
    2: reference(3, 3),
    3: reference(2),
    4: reference(100),
  });
  assert.equal(result[1].n, 3);
  result[1].points[50].forEach((value, i) => almost(value, [-2, 0.2, 0.6][i]));
  assert.equal(result[2].n, 3);
  assert.equal(result[2].points[50][0], -4);
});

test("baseline excludes a missing foot without replacing it with the other foot", () => {
  const result = baselineTrajectories([{ id: "only-left" }], {
    "only-left": { 1: { points: curve(1) }, 2: { points: null } },
  });
  assert.equal(result[1].n, 1);
  assert.equal(result[2].n, 0);
  assert.equal(result[2].points, null);
  assert.deepEqual(baselineTrajectories([], {}), {
    1: { n: 0, points: null },
    2: { n: 0, points: null },
  });
});

test("trajectory references follow the same 30, 60, 90, 180 and 365-day windows", () => {
  const selectedStart = 400 * 86400;
  const runs = prepareRuns(
    [10, 60, 120, 300, 365, 366, 0, -1].map((age) => ({
      id: String(age),
      start: selectedStart - age * 86400,
      end: selectedStart - age * 86400 + 60,
      rows: [],
    })),
  );
  const references = Object.fromEntries(
    [10, 60, 120, 300, 365].map((age, i) => [
      String(age),
      reference(i * 2 + 1),
    ]),
  );
  references[366] = reference(100);
  references[0] = reference(200);
  references[-1] = reference(300);
  const selected = runs.find((run) => run.id === "0");
  for (const [days, count, scale] of [
    [30, 1, 1],
    [60, 2, 2],
    [90, 2, 2],
    [180, 3, 3],
    [365, 5, 5],
  ]) {
    const baseline = recentBaseline(runs, selected, days);
    const result = baselineTrajectories(baseline.runs, references);
    const meanScale = (scale * count + 200) / (count + 1);
    assert.equal(result[1].n, count + 1);
    assert.equal(result[2].n, count + 1);
    almost(result[1].points[50][0], -meanScale);
    almost(result[2].points[50][0], -meanScale * 2);
  }
});

test("geometry applies full-run XYZ bounds, requires three samples, and keeps missing timing fields", () => {
  const bounds = { 1: {}, 2: {} };
  for (const side of [1, 2])
    for (const key of ["xSpan", "ySpan", "zSpan"])
      bounds[side][key] = { bounds: [0, 5] };
  const rows = [1, 2, 3, 99].map((value, index) => ({
    index,
    side: 1,
    xSpan: value,
    ySpan: 1,
    zSpan: 1,
    groundContactTime: null,
  }));
  const data = {
    segments: rows.map((row) => ({
      side: 1,
      points: [
        [0, 0, 0],
        [-row.xSpan, 1, 1],
        [0, 0, 0],
      ],
    })),
  };
  const result = runTrajectories(data, rows, bounds);
  assert.equal(result[1].n, 3);
  assert.equal(result[1].points[50][0], -2);
  assert.equal(result[2].points, null);
  assert.equal(runTrajectories(data, rows.slice(0, 2), bounds)[1].points, null);
});

test("moving the run window changes current geometry while the baseline stays identical", () => {
  const raw = createDemoRun(20);
  const run = prepareRuns([runFromRaw(raw)])[0];
  const start = selectStage(run, { segmented: true, position: 0, minutes: 5 });
  const end = selectStage(run, { segmented: true, position: 100, minutes: 5 });
  const a = runTrajectories(run.data, start.rows, run.summary);
  const b = runTrajectories(run.data, end.rows, run.summary);
  const base = reference(0.5);
  const before = JSON.stringify(base);
  const bounds = trajectoryBounds(a, b, base);
  const first = comparisonTrajectories(a, base, bounds);
  const last = comparisonTrajectories(b, base, bounds);
  assert.notDeepEqual(
    first.segments.filter((s) => s.comparisonRole === "current"),
    last.segments.filter((s) => s.comparisonRole === "current"),
  );
  assert.deepEqual(
    first.segments.filter((s) => s.comparisonRole === "baseline"),
    last.segments.filter((s) => s.comparisonRole === "baseline"),
  );
  assert.equal(JSON.stringify(base), before);
  assert.equal(first.segments.length, 4);
  assert.equal(first.segments[0].dashed, true);
  assert.equal(first.segments[2].dashed, false);
});

test("mirroring changes only display bounds, never source coordinates", () => {
  const current = reference(1),
    bounds = trajectoryBounds(current);
  const copy = JSON.stringify({ current, bounds });
  const mirrored = comparisonTrajectories(current, null, bounds, true);
  assert.equal(mirrored.viewBounds.min[1], -mirrored.viewBounds.max[1]);
  assert.equal(JSON.stringify({ current, bounds }), copy);
  assert.equal(mirrored.segments.length, 2);
});

test("derived reference build is deterministic and leaves source archives unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "footpath-trajectory-test-"));
  try {
    const dataDir = join(root, "data"),
      cacheDir = join(root, "cache");
    await mkdir(dataDir);
    const raw = createDemoRun(1),
      run = runFromRaw(raw),
      bytes = gzipSync(JSON.stringify(raw));
    const digest = (value) => createHash("sha256").update(value).digest("hex");
    const packedUrl = "/data/" + digest(bytes) + ".bin";
    const history = {
      format: "footpath-studio-collection-v1",
      runs: [
        {
          ...run,
          data: undefined,
          packedUrl,
          rows: run.rows.map((row) => ROW_FIELDS.map((key) => row[key])),
        },
      ],
    };
    const indexBytes = gzipSync(JSON.stringify(history)),
      index = digest(indexBytes) + ".bin";
    const version = JSON.stringify({
      format: "footpath-studio-public-v1",
      index,
      revision: digest(indexBytes),
    });
    await writeFile(join(dataDir, "version.json"), version);
    await writeFile(join(dataDir, index), indexBytes);
    await writeFile(join(dataDir, packedUrl.slice(6)), bytes);
    const first = await buildTrajectoryReferences(dataDir, cacheDir);
    const second = await buildTrajectoryReferences(dataDir, cacheDir);
    assert.equal(first, second);
    const result = JSON.parse(first);
    assert.ok(result.runs[run.id][1].n > 3);
    assert.equal(result.runs[run.id][1].points.length, 101);
    assert.equal(
      await readFile(join(dataDir, "version.json"), "utf8"),
      version,
    );
    assert.deepEqual(await readFile(join(dataDir, packedUrl.slice(6))), bytes);
    await writeFile(join(dataDir, packedUrl.slice(6)), "corrupt");
    await assert.rejects(
      buildTrajectoryReferences(dataDir, join(root, "fresh-cache")),
      /checksum/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
