import test from "node:test";
import assert from "node:assert/strict";
import { prepareRuns } from "../src/analysis-model.js";
import {
  distanceProfile,
  distanceAtTime,
  selectDistanceStage,
  distancePaceSeries,
} from "../src/distance-model.js";

const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
function prepared(samples, distance) {
  const start = 1700000000;
  const rows = samples.flatMap(([time, speed], i) =>
    [1, 2].map((side) => ({
      index: i * 2 + side - 1,
      time: start + time,
      side,
      speed,
      xSpan: 1,
      ySpan: 10 + (i % 3),
      zSpan: 0.2,
      groundContactTime: 230,
      strideTime: 670,
    })),
  );
  return prepareRuns([
    {
      id: "run",
      start,
      end: rows.at(-1).time,
      activity: { timestamp: start, distance },
      rows,
    },
  ])[0];
}

test("kilometer positions follow changing speed, calibrated to recorded distance", () => {
  const run = prepared(
    [
      [0, 1],
      [100, 3],
    ],
    400,
  );
  const profile = distanceProfile(run);
  assert.equal(profile.estimated, true);
  assert.equal(profile.hasRecordedTotal, true);
  close(distanceAtTime(profile, 50), 0.15);
  close(distanceAtTime(profile, 100), 0.4);
  close(distanceAtTime(profile, -1), 0);
  close(distanceAtTime(profile, 150), 0.4);
});

test("simultaneous left and right samples contribute one speed observation", () => {
  const run = prepared([
    [0, 2],
    [100, 2],
  ]);
  run.rows
    .filter((row) => row.side === 2)
    .forEach((row) => {
      row.speed = 4;
    });
  const profile = distanceProfile(run);
  assert.equal(profile.knots.length, 2);
  assert.equal(profile.hasRecordedTotal, false);
  close(profile.totalKm, 0.3);
  close(distanceAtTime(profile, 50), 0.15);
});

test("missing speed samples do not create negative distances or nonfinite positions", () => {
  const run = prepared([
    [0, NaN],
    [20, 2],
    [60, -1],
    [80, 2],
    [100, null],
  ]);
  const profile = distanceProfile(run);
  close(profile.totalKm, 0.2);
  close(distanceAtTime(profile, 10), 0.02);
  close(distanceAtTime(profile, 90), 0.18);
  assert.equal(distanceAtTime(profile, NaN), null);
});

test("missing distance mapping preserves whole-run observations and metrics", () => {
  for (const run of [
    prepared(
      [
        [0, 0],
        [100, 0],
      ],
      400,
    ),
    prepared([[0, 2]], 400),
  ]) {
    const profile = distanceProfile(run);
    assert.equal(profile.available, false);
    const stage = selectDistanceStage(run, profile, { start: 0.1, end: 0.2 });
    assert.equal(stage.fullRange, true);
    assert.equal(stage.rows, run.eligible);
    assert.equal(stage.summary, run.summary);
    assert.deepEqual(distancePaceSeries(run, profile), []);
  }
});

test("manual kilometer bounds select both feet without shifting outlier thresholds", () => {
  const run = prepared(
    Array.from({ length: 101 }, (_, i) => [i * 10, 2]),
    2000,
  );
  run.rows.find(
    (row) => row.side === 1 && row.time === run.startTime + 450,
  ).ySpan = 1000;
  const [withOutlier] = prepareRuns([run]);
  const stage = selectDistanceStage(withOutlier, distanceProfile(withOutlier), {
    start: 0.8,
    end: 1,
  });
  assert.equal(stage.fullRange, false);
  assert.equal(stage.rows.length, 20);
  assert.equal(stage.rows[0].time, run.startTime + 400);
  assert.equal(stage.rows.at(-1).time, run.startTime + 490);
  assert.equal(stage.summary[1].ySpan.excluded, 1);
  assert.deepEqual(
    stage.summary[1].ySpan.bounds,
    withOutlier.summary[1].ySpan.bounds,
  );
});

test("full precision end includes the final samples; whole range reuses the full summary", () => {
  const run = prepared(
    Array.from({ length: 101 }, (_, i) => [i * 10, 2]),
    13183,
  );
  const profile = distanceProfile(run);
  const final = selectDistanceStage(run, profile, {
    start: 12,
    end: profile.totalKm,
  });
  assert.equal(final.end, 13.183);
  assert.ok(final.rows.includes(run.eligible.at(-1)));
  const full = selectDistanceStage(run, profile);
  assert.equal(full.fullRange, true);
  assert.equal(full.rows, run.eligible);
  assert.equal(full.summary, run.summary);
});

test("reversed or out-of-range manual bounds remain ordered and bounded", () => {
  const run = prepared(
    [
      [0, 2],
      [100, 2],
    ],
    400,
  );
  const profile = distanceProfile(run);
  const stage = selectDistanceStage(run, profile, { start: 0.3, end: -2 });
  assert.equal(stage.start, 0);
  assert.equal(stage.end, 0.3);
  assert.equal(
    selectDistanceStage(run, profile, { start: -1, end: 10 }).fullRange,
    true,
  );
});

test("a missing middle kilometer interval stays empty and retains pace gaps", () => {
  const run = prepared(
    [
      [0, 2],
      [60, 2],
      [540, 2],
      [600, 2],
    ],
    1200,
  );
  const profile = distanceProfile(run);
  const stage = selectDistanceStage(run, profile, { start: 0.4, end: 0.8 });
  assert.equal(stage.rows.length, 0);
  assert.equal(stage.summary[1].ySpan.mean, null);
  const pace = distancePaceSeries(run, profile);
  assert.equal(pace[4].pace, null);
  close(pace[4].distance, 0.54);
});
