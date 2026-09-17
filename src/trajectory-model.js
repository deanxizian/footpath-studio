import { MIN_OBSERVATIONS } from "./analysis-model.js";

export const TRAJECTORY_VERSION = 2;
export const PHASE_POINTS = 101;
const AXES = ["xSpan", "ySpan", "zSpan"];

// Resample by cycle progress, without scaling the original coordinate amplitudes.
// Preserve each fragment's recorded starting phase; remove its small origin offset.
export function resampleTrajectory(points, count = PHASE_POINTS) {
  if (
    !Number.isInteger(count) ||
    count < 2 ||
    !Array.isArray(points) ||
    points.length < 2 ||
    points.some(
      (p) => !Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite),
    ) ||
    points.every((p) => p.every((value, axis) => value === points[0][axis]))
  )
    return null;
  return Array.from({ length: count }, (_, i) => {
    const phase = (i * (points.length - 1)) / (count - 1);
    const a = Math.floor(phase),
      b = Math.min(a + 1, points.length - 1);
    return points[a].map(
      (value, axis) =>
        value + (points[b][axis] - value) * (phase - a) - points[0][axis],
    );
  });
}

export function averageTrajectories(curves) {
  const valid = curves.filter(
    (curve) =>
      curve?.length === PHASE_POINTS &&
      curve.every(
        (p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite),
      ),
  );
  if (!valid.length) return null;
  return Array.from({ length: PHASE_POINTS }, (_, point) =>
    [0, 1, 2].map(
      (axis) =>
        valid.reduce((sum, curve) => sum + curve[point][axis], 0) /
        valid.length,
    ),
  );
}

export function runTrajectories(data, rows, summary) {
  const result = {};
  for (const side of [1, 2]) {
    const curves = [];
    for (const row of rows) {
      if (
        row.side !== side ||
        !AXES.every((key) => {
          const value = row[key],
            bounds = summary[side][key].bounds;
          return (
            Number.isFinite(value) &&
            value >= 0 &&
            value >= bounds[0] &&
            value <= bounds[1]
          );
        })
      )
        continue;
      const segment = data.segments[row.index];
      if (segment?.side !== side) continue;
      const curve = resampleTrajectory(segment.points);
      if (curve) curves.push(curve);
    }
    result[side] = {
      n: curves.length,
      points:
        curves.length >= MIN_OBSERVATIONS ? averageTrajectories(curves) : null,
    };
  }
  return result;
}

export function baselineTrajectories(runs, references) {
  return Object.fromEntries(
    [1, 2].map((side) => {
      const curves = runs
        .map((run) => references[run.id]?.[side]?.points)
        .filter(Boolean);
      return [side, { n: curves.length, points: averageTrajectories(curves) }];
    }),
  );
}

export function trajectoryBounds(...collections) {
  const points = collections.flatMap((collection) =>
    [1, 2].flatMap((side) => collection?.[side]?.points ?? []),
  );
  if (!points.length) return null;
  return {
    min: [0, 1, 2].map((axis) => Math.min(0, ...points.map((p) => p[axis]))),
    max: [0, 1, 2].map((axis) => Math.max(0, ...points.map((p) => p[axis]))),
  };
}

export function comparisonTrajectories(
  current,
  baseline,
  bounds,
  mirror = false,
) {
  const segments = [];
  for (const [role, collection] of [
    ["baseline", baseline],
    ["current", current],
  ]) {
    for (const side of [1, 2]) {
      const points = collection?.[side]?.points;
      if (!points) continue;
      segments.push({
        index: segments.length,
        side,
        points,
        color: side === 1 ? "#f5a23a" : "#5c9bed",
        comparisonRole: role,
        dashed: role === "baseline",
        opacity: role === "baseline" ? 0.5 : 1,
        linewidth: role === "baseline" ? 2 : 3,
        hideMarker: true,
      });
    }
  }
  // Keep scale fixed while scrubbing, but include an unusual stage if needed.
  const extra = trajectoryBounds(current, baseline);
  const viewBounds =
    bounds && extra
      ? {
          min: bounds.min.map((v, i) => Math.min(v, extra.min[i])),
          max: bounds.max.map((v, i) => Math.max(v, extra.max[i])),
        }
      : extra;
  if (mirror && viewBounds) {
    const width = Math.max(
      Math.abs(viewBounds.min[1]),
      Math.abs(viewBounds.max[1]),
    );
    viewBounds.min[1] = -width;
    viewBounds.max[1] = width;
  }
  return { segments, viewBounds, pointCount: segments.length * PHASE_POINTS };
}
