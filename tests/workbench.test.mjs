import test from "node:test";
import assert from "node:assert/strict";
import { buildComparison, searchRuns } from "../src/workbench-model.js";
import { COLORS } from "../src/model.js";

test("comparison retains each run’s actual median fragment and foot identity", () => {
  const data = (offset) => ({
    segments: [1, 1, 1, 2, 2, 2].map((side, index) => ({
      index,
      side,
      points: [
        [offset + index, -0.1, 0],
        [offset + index + 0.2, 0.1, 0.3],
      ],
    })),
  });
  const rows = [1, 1, 1, 2, 2, 2].map((side, index) => ({
    index,
    side,
    xSpan: (index % 3) + 1,
    ySpan: (index % 3) + 1,
    zSpan: (index % 3) + 1,
  }));
  const current = data(10),
    baseline = data(20);
  const comparison = buildComparison(current, baseline, rows, rows);
  assert.equal(comparison.segments.length, 4);
  assert.deepEqual(
    comparison.segments.map((segment) => segment.sourceIndex),
    [1, 4, 1, 4],
  );
  for (const segment of comparison.segments) {
    const source = segment.comparisonRole === "current" ? current : baseline;
    assert.equal(segment.points, source.segments[segment.sourceIndex].points);
    assert.equal(
      segment.color,
      segment.side === 1 ? COLORS.left : COLORS.right,
    );
    assert.equal(segment.dashed, segment.comparisonRole === "baseline");
  }
  assert.equal(comparison.pointCount, 8);
  assert.equal(current.segments[1].dashed, undefined);
});

test("insufficient samples never become an invented representative curve", () => {
  const source = {
    segments: [0, 1].map((index) => ({
      index,
      side: 1,
      points: [
        [0, 0, 0],
        [1, 1, 1],
      ],
    })),
  };
  const rows = source.segments.map((segment) => ({
    ...segment,
    xSpan: 1,
    ySpan: 1,
    zSpan: 1,
  }));
  assert.deepEqual(buildComparison(source, source, rows, rows).segments, []);
});

test("run picker accepts dashed dates and uses Shanghai dates at UTC day boundaries", () => {
  const run = {
    id: "1",
    start: Date.parse("2026-09-14T17:00:00Z") / 1000,
    activity: { name: "Moderate Tempo Run" },
  };
  assert.equal(searchRuns([run], "2026-09-15")[0], run);
  assert.equal(searchRuns([run], "tempo")[0], run);
  assert.equal(searchRuns([run], "2026/09/14").length, 0);
});
