import test from "node:test";
import assert from "node:assert/strict";
import {
  DAY,
  cleanMean,
  prepareRuns,
  recentBaseline,
  aggregateRuns,
  footDifference,
  selectStage,
  trendRows,
  trendChange,
  paceSeries,
} from "../src/analysis-model.js";

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
function run(id, day, left = 10, right = 12, count = 12, extra = {}) {
  const start = 1700000000 + day * DAY;
  const rows = Array.from({ length: count * 2 }, (_, i) => ({
    index: i,
    side: (i % 2) + 1,
    time: start + Math.floor(i / 2) * 10,
    speed: i % 3 === 0 ? 2 : 4,
    xSpan: i % 2 ? right : left,
    ySpan: i % 2 ? right : left,
    zSpan: i % 2 ? right : left,
    groundContactTime: 230,
    strideTime: 670,
  }));
  return {
    id,
    start,
    end: rows.at(-1).time,
    activity: { timestamp: start },
    rows,
    ...extra,
  };
}

test("extreme observations are removed while ordinary variation remains in the mean", () => {
  const values = [9, 10, 10, 10, 11, 11, 12, 12, 1000, null, NaN, Infinity];
  const result = cleanMean(values);
  close(result.mean, 10.625);
  assert.equal(result.excluded, 1);
  assert.equal(result.total, 9);
  assert.equal(result.n, 8);
  assert.equal(values[8], 1000);
});

test("missing and sparse values never masquerade as zero or a reliable average", () => {
  assert.equal(cleanMean([null, NaN, Infinity]).mean, null);
  assert.equal(cleanMean([1, 2]).mean, null);
  assert.equal(cleanMean([0, 0, 0]).mean, 0);
  assert.equal(cleanMean([2, 2, 2, 2, 2, 2, 2, 2]).mean, 2);
  assert.equal(cleanMean([1, 1, 1, 100]).excluded, 0);
});

test("left, right and metrics have independent outlier rules; zero duration stays missing", () => {
  const raw = run("a", 0);
  raw.rows.forEach((row, i) => {
    row.ySpan += Math.floor(i / 2) % 3;
    row.groundContactTime = 0;
  });
  raw.rows[0].ySpan = 1000;
  const [value] = prepareRuns([raw]);
  assert.equal(value.summary[1].ySpan.excluded, 1);
  assert.equal(value.summary[2].ySpan.excluded, 0);
  assert.equal(value.summary[1].xSpan.excluded, 0);
  assert.equal(value.summary[1].groundContactTime.mean, null);
});

for (const days of [30, 60, 90, 180, 365]) {
  test(`${days}-day baseline includes both boundaries and the anchor run, but excludes later records`, () => {
    const runs = prepareRuns([
      run("old", -days - 1),
      run("boundary", -days),
      run("before", -1),
      run("selected", 0),
      run("same-time", 0),
      run("future", 1),
    ]);
    const selected = runs.find((value) => value.id === "selected");
    const baseline = recentBaseline(runs, selected, days);
    assert.equal(baseline.days, days);
    assert.deepEqual(
      baseline.runs.map((value) => value.id),
      ["boundary", "before", "same-time", "selected"],
    );
    assert.deepEqual(
      baseline.runs.map((value) => value.id),
      trendRows(runs, selected, days, "ySpan").map((value) => value.id),
    );
  });
}

test("changing baseline windows recalculates both feet from the same anchor, including that run", () => {
  const runs = prepareRuns([
    ...[10, 60, 120, 300, 365].map((age, i) =>
      run(`prior-${age}`, -age, (i + 1) * 10, (i + 1) * 10 + 2),
    ),
    run("too-old", -366, 1000, 1000),
    run("selected", 0, 200, 200),
    run("future", 1, 1000, 1000),
  ]);
  const selected = runs.find((value) => value.id === "selected");
  for (const [days, count, left, right] of [
    [30, 1, 10, 12],
    [60, 2, 15, 17],
    [90, 2, 15, 17],
    [180, 3, 20, 22],
    [365, 5, 30, 32],
  ]) {
    const baseline = recentBaseline(runs, selected, days);
    assert.equal(baseline.runs.length, count + 1);
    close(baseline.summary[1].ySpan.mean, (left * count + 200) / (count + 1));
    close(baseline.summary[2].ySpan.mean, (right * count + 200) / (count + 1));
    assert.equal(baseline.summary.difference.ySpan.n, count + 1);
    assert.equal(selected.summary[1].ySpan.mean, 200);
  }
  assert.equal(recentBaseline(runs, selected).days, 90);
  assert.equal(recentBaseline(runs, selected, 365).label, "365 天");
});

test("baseline follows activity start rather than delayed footpath recording", () => {
  const selectedRaw = run("selected", 90);
  selectedRaw.activity.timestamp -= 60;
  const runs = prepareRuns([run("prior", 0), selectedRaw]);
  assert.equal(
    recentBaseline(runs, runs[1]).start,
    selectedRaw.activity.timestamp - 90 * DAY,
  );
  assert.equal(selectStage(runs[1]).start, 0);
  assert.equal(runs[1].duration, 170);
});

test("a short run and a long run contribute equal weight to the baseline", () => {
  const runs = prepareRuns([
    run("short", -2, 10, 12, 3),
    run("long", -1, 20, 22, 1200),
    run("selected", 0, 15, 17, 6),
  ]);
  const baseline = recentBaseline(runs, runs[2]);
  assert.equal(baseline.summary[1].ySpan.mean, 15);
  assert.equal(baseline.summary[2].ySpan.mean, 17);
  assert.equal(baseline.summary[1].ySpan.n, 3);
});

test("default comparison includes all speeds, surfaces and footwear", () => {
  const raw = [
    run("a", -1, 10, 12, 12, {
      activity: { surface_type: "trail", apparel_ids: [1] },
    }),
    run("b", 0),
  ];
  const prepared = prepareRuns(raw);
  assert.equal(prepared[0].eligible.length, 24);
  assert.equal(recentBaseline(prepared, prepared[1]).runs.length, 2);
  assert.ok(prepareRuns(raw, 4)[0].eligible.length < 24);
});

test("directional asymmetry reverses with foot order; missing feet and zero denominator are unavailable", () => {
  close(footDifference(10, 12).percent, 200 / 11);
  close(footDifference(12, 10).percent, -200 / 11);
  assert.equal(footDifference(10, 12).delta, 2);
  assert.equal(footDifference(null, 10).percent, null);
  assert.equal(footDifference(0, 0).percent, null);
});

test("opposite imbalance directions cannot cancel the magnitude trend", () => {
  const summary = aggregateRuns(
    prepareRuns([run("a", 0, 10, 12), run("b", 1, 12, 10)]),
  );
  close(summary.difference.ySpan.mean, 0);
  close(summary.magnitude.ySpan.mean, 200 / 11);
});

test("baseline asymmetry uses only runs where both feet are available", () => {
  const single = run("single", 1, 100, 0);
  single.rows = single.rows.filter((row) => row.side === 1);
  const summary = aggregateRuns(
    prepareRuns([run("paired", 0, 10, 12), single]),
  );
  assert.equal(summary[1].ySpan.n, 2);
  assert.equal(summary[2].ySpan.n, 1);
  assert.equal(summary.difference.ySpan.n, 1);
  close(summary.difference.ySpan.mean, 200 / 11);
});

test("time windows preserve real elapsed time, keep fixed outlier limits, and include final samples", () => {
  const raw = run("a", 0, 10, 12, 60);
  raw.rows.forEach((row, i) => {
    row.ySpan += Math.floor(i / 2) % 3;
  });
  raw.rows.at(-2).ySpan = 1000;
  const [value] = prepareRuns([raw]);
  const last = selectStage(value, {
    segmented: true,
    position: 100,
    minutes: 1,
  });
  assert.equal(last.end, value.duration);
  assert.equal(last.start, value.duration - 60);
  assert.equal(last.summary[1].ySpan.excluded, 1);
  assert.ok(last.rows.includes(value.eligible.at(-1)));
  assert.deepEqual(last.summary[1].ySpan.bounds, value.summary[1].ySpan.bounds);
});

test("an unrecorded middle interval produces no values and pace gaps remain null", () => {
  const raw = run("a", 0, 10, 12, 100);
  raw.rows = raw.rows.filter(
    (row) => row.time < raw.start + 100 || row.time >= raw.start + 800,
  );
  const [value] = prepareRuns([raw]);
  const middle = selectStage(value, {
    segmented: true,
    position: 50,
    minutes: 2,
  });
  assert.equal(middle.rows.length, 0);
  assert.equal(middle.summary[1].ySpan.mean, null);
  assert.equal(paceSeries(value)[6].pace, null);
});

test("historical trends exclude future runs and preserve measured units with a five-run trailing mean", () => {
  const runs = prepareRuns(
    Array.from({ length: 8 }, (_, i) => run(String(i), i, i + 1, i + 2)),
  );
  const rows = trendRows(runs, runs[5], 90, "ySpan");
  assert.equal(rows.length, 6);
  assert.equal(rows[0].left, 1);
  assert.equal(rows[3].leftTrend, null);
  assert.equal(rows[4].leftTrend, 3);
  assert.equal(rows[5].leftTrend, 4);
  const recent = trendRows(runs, runs[5], 2, "ySpan");
  assert.equal(recent.length, 3);
  assert.equal(recent[0].left, 4);
});

for (const days of [30, 60, 90, 180, 365]) {
  test(`${days}-day trend summary uses only the beginning and end of the displayed range`, () => {
    const runs = prepareRuns([
      run("too-old", -days - 1, 1000, 1000),
      run("boundary", -days, 10, 12),
      run("early2", -days + 1, 10, 12),
      run("early3", -days + 2, 10, 12),
      run("late1", -2, 11, 11),
      run("late2", -1, 11, 11),
      run("selected", 0, 11, 11),
      run("future", 1, 100, 100),
    ]);
    const selected = runs.find((value) => value.id === "selected");
    const rows = trendRows(runs, selected, days, "ySpan");
    const change = trendChange(rows);
    assert.equal(change.windowSize, 3);
    assert.equal(change[1].before.n, 3);
    assert.equal(change[1].after.n, 3);
    close(change[1].percent, 10);
    close(change[2].percent, -100 / 12);
    close(change.difference.delta, -200 / 11);
    assert.deepEqual(
      rows.map((row) => row.id),
      ["boundary", "early2", "early3", "late1", "late2", "selected"],
    );
  });
}

test("within-range summary caps each end at five runs and preserves imbalance magnitude when the leading foot reverses", () => {
  const runs = prepareRuns(
    Array.from({ length: 12 }, (_, i) =>
      i < 5
        ? run(String(i), i, 10, 12)
        : i < 7
          ? run(String(i), i, 1000, 1000)
          : run(String(i), i, 12, 10),
    ),
  );
  const change = trendChange(trendRows(runs, runs.at(-1), 30, "ySpan"));
  assert.equal(change.windowSize, 5);
  assert.equal(change[1].before.n, 5);
  assert.equal(change[1].after.n, 5);
  assert.equal(change[1].before.mean, 10);
  assert.equal(change[1].after.mean, 12);
  close(change[1].percent, 20);
  close(change.difference.before.mean, 200 / 11);
  close(change.difference.after.mean, 200 / 11);
  close(change.difference.delta, 0);
});

test("sparse trends never reuse the same run at both ends or fabricate a change", () => {
  const runs = prepareRuns(
    Array.from({ length: 5 }, (_, i) => run(String(i), i)),
  );
  const change = trendChange(trendRows(runs, runs.at(-1), 90, "ySpan"));
  assert.equal(change.windowSize, 2);
  assert.equal(change[1].before.n, 2);
  assert.equal(change[1].after.n, 2);
  assert.equal(change[1].before.mean, null);
  assert.equal(change[1].enough, false);
  assert.equal(change[1].percent, null);
  assert.equal(change.difference.delta, null);
  assert.equal(trendChange([])[1].after.n, 0);
  assert.equal(trendChange([{ left: 10, right: 12 }])[1].after.n, 0);
});

test("within-range summary shares endpoint runs between feet but treats missing values independently", () => {
  const raw = Array.from({ length: 6 }, (_, i) => run(String(i), i));
  raw[5].rows = raw[5].rows.filter((row) => row.side === 2);
  const runs = prepareRuns(raw);
  const change = trendChange(trendRows(runs, runs.at(-1), 90, "ySpan"));
  assert.equal(change[1].after.n, 2);
  assert.equal(change[1].enough, false);
  assert.equal(change[1].percent, null);
  assert.equal(change[2].enough, true);
  assert.equal(change[2].percent, 0);
  assert.equal(change.difference.delta, null);
});

test("a zero initial mean keeps measured endpoints without inventing a percentage", () => {
  const runs = prepareRuns(
    Array.from({ length: 6 }, (_, i) => run(String(i), i, i < 3 ? 0 : 1, 2)),
  );
  const change = trendChange(trendRows(runs, runs.at(-1), 90, "ySpan"));
  assert.equal(change[1].enough, true);
  assert.equal(change[1].before.mean, 0);
  assert.equal(change[1].after.mean, 1);
  assert.equal(change[1].delta, 1);
  assert.equal(change[1].percent, null);
});

test("the only available run remains in the baseline", () => {
  const runs = prepareRuns([run("first", 0)]);
  const result = recentBaseline(runs, runs[0]);
  assert.equal(result.runs.length, 1);
  assert.equal(result.summary[1].ySpan.mean, 10);
  close(result.summary.difference.ySpan.mean, footDifference(10, 12).percent);
});
