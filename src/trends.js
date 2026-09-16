import { elapsed } from "./model.js";

export const METRICS = [
  { key: "ySpan", label: "Y 轴幅度", unit: "原始单位", digits: 4 },
  { key: "zSpan", label: "Z 轴幅度", unit: "原始单位", digits: 4 },
  { key: "xSpan", label: "X 轴幅度", unit: "原始单位", digits: 4 },
  { key: "groundContactTime", label: "触地时间", unit: "ms", digits: 0 },
  { key: "strideTime", label: "周期时间", unit: "ms", digits: 0 },
];
export const MIN_SAMPLES = 3;
const finite = (x) => typeof x === "number" && Number.isFinite(x);
const positive = (x) => (finite(x) && x > 0 ? x : null);

export function quantile(values, probability) {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * probability;
  const lo = Math.floor(index),
    hi = Math.ceil(index);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
}

export function stats(values) {
  const valid = values.filter(finite);
  return {
    n: valid.length,
    median: quantile(valid, 0.5),
    q25: quantile(valid, 0.25),
    q75: quantile(valid, 0.75),
  };
}

export function deriveRows(data) {
  return data.segments
    .map((segment) => {
      const bounds = [0, 1, 2].map((axis) => {
        let min = Infinity,
          max = -Infinity;
        for (const point of segment.points) {
          min = Math.min(min, point[axis]);
          max = Math.max(max, point[axis]);
        }
        return max - min;
      });
      return {
        index: segment.index,
        side: segment.side,
        time: segment.time,
        elapsed: segment.time - data.start,
        xSpan: bounds[0],
        ySpan: bounds[1],
        zSpan: bounds[2],
        speed: positive(segment.speed),
        groundContactTime: positive(segment.groundContactTime),
        strideTime: positive(segment.strideTime),
      };
    })
    .sort((a, b) => a.time - b.time || a.index - b.index);
}

export function speedRange(rows) {
  const center = quantile(
    rows.map((row) => row.speed),
    0.5,
  );
  return {
    center,
    min: center === null ? null : center * 0.95,
    max: center === null ? null : center * 1.05,
  };
}

export function eligibleRows(rows, matched, range = speedRange(rows)) {
  if (!matched) return rows;
  return rows.filter(
    (row) =>
      finite(row.speed) &&
      range.min !== null &&
      row.speed >= range.min &&
      row.speed <= range.max,
  );
}

export function percentChange(value, baseline) {
  return finite(value) && finite(baseline) && baseline !== 0
    ? (value / baseline - 1) * 100
    : null;
}

export function summarize(rows) {
  const result = { n: rows.length, speed: stats(rows.map((row) => row.speed)) };
  for (const side of [1, 2]) {
    const footRows = rows.filter((row) => row.side === side);
    result[side] = {
      n: footRows.length,
      speed: stats(footRows.map((row) => row.speed)),
    };
    for (const { key } of METRICS)
      result[side][key] = stats(footRows.map((row) => row[key]));
  }
  return result;
}

function interval(id, label, start, end, rows, duration) {
  const included = rows.filter(
    (row) =>
      row.elapsed >= start &&
      (row.elapsed < end || (end === duration && row.elapsed === end)),
  );
  return {
    id,
    label,
    start,
    end,
    midpoint: (start + end) / 2,
    rows: included,
    summary: summarize(included),
    rangeLabel: `${elapsed(start)}–${elapsed(end)}`,
  };
}

export function buildAnalysis(
  data,
  rows,
  { matched = true, minutes = 5 } = {},
) {
  if (![1, 2, 5, 10].includes(minutes)) throw new Error("Unsupported time bin");
  const duration = Math.max(0, data.end - data.start);
  const range = speedRange(rows);
  const eligible = eligibleRows(rows, matched, range);
  const thirds = ["前程", "中程", "后程"].map((label, i) =>
    interval(
      `third-${i}`,
      label,
      (duration * i) / 3,
      (duration * (i + 1)) / 3,
      eligible,
      duration,
    ),
  );
  const binSize = minutes * 60;
  const count = Math.max(1, Math.ceil(duration / binSize));
  const bins = Array.from({ length: count }, (_, i) =>
    interval(
      `bin-${i}`,
      `${elapsed(i * binSize)}–${elapsed(Math.min(duration, (i + 1) * binSize))}`,
      i * binSize,
      Math.min(duration, (i + 1) * binSize),
      eligible,
      duration,
    ),
  );
  // Gaps are determined from the raw recording, not from the optional speed filter.
  const gaps = [];
  for (let i = 1; i < rows.length; i++)
    if (rows[i].elapsed - rows[i - 1].elapsed > 15) {
      gaps.push({
        start: rows[i - 1].elapsed,
        end: rows[i].elapsed,
        seconds: rows[i].elapsed - rows[i - 1].elapsed,
      });
    }
  return {
    duration,
    range,
    eligible,
    thirds,
    bins,
    gaps,
    matched,
    minutes,
    baseline: thirds[0].summary,
  };
}

export function chartRows(analysis, metricKey, relative = true) {
  return analysis.bins.map((bin) => {
    const row = {
      id: bin.id,
      time: bin.midpoint,
      bin,
      speed:
        bin.summary.speed.n >= MIN_SAMPLES ? bin.summary.speed.median : null,
    };
    for (const [side, key] of [
      [1, "left"],
      [2, "right"],
    ]) {
      const current = bin.summary[side][metricKey],
        baseline = analysis.baseline[side][metricKey];
      const valid =
        current.n >= MIN_SAMPLES &&
        (!relative || (baseline.n >= MIN_SAMPLES && baseline.median !== 0));
      const transform = (value) =>
        relative ? percentChange(value, baseline.median) : value;
      row[key] = valid ? transform(current.median) : null;
      row[`${key}Range`] = valid
        ? [transform(current.q25), transform(current.q75)]
        : null;
    }
    return row;
  });
}

// Select a real recorded fragment closest to the three coordinate-span medians.
// Each relative deviation has equal weight; no synthetic mean trajectory is drawn.
export function representative(rows, side) {
  const candidates = rows.filter((row) => row.side === side);
  if (candidates.length < MIN_SAMPLES) return null;
  const keys = ["xSpan", "ySpan", "zSpan"];
  const medians = keys.map((key) =>
    quantile(
      candidates.map((row) => row[key]),
      0.5,
    ),
  );
  let best = null,
    bestScore = Infinity;
  for (const row of candidates) {
    const score = keys.reduce(
      (sum, key, i) =>
        sum + ((row[key] - medians[i]) / (Math.abs(medians[i]) || 1)) ** 2,
      0,
    );
    if (score < bestScore) {
      best = row.index;
      bestScore = score;
    }
  }
  return best;
}

export function comparisonData(data, baselineRows, currentRows, side) {
  const baselineIndex = representative(baselineRows, side),
    currentIndex = representative(currentRows, side);
  const segments = [];
  if (baselineIndex !== null)
    segments.push({
      ...data.segments[baselineIndex],
      color: "#8996a8",
      dashed: true,
      hideMarker: true,
      linewidth: 2.4,
    });
  if (currentIndex !== null)
    segments.push({
      ...data.segments[currentIndex],
      hideMarker: true,
      linewidth: 3,
    });
  return {
    ...data,
    segments,
    viewBounds: data.bounds,
    pointCount: segments.reduce((n, s) => n + s.points.length, 0),
    baselineIndex,
    currentIndex,
  };
}

export const fmt = (value, digits = 1) =>
  finite(value) ? value.toFixed(digits) : "—";
export const pct = (value) =>
  finite(value)
    ? Math.abs(value) < 0.05
      ? "0.0%"
      : `${value > 0 ? "+" : ""}${value.toFixed(1)}%`
    : "—";

export function csvExport(data, analysis) {
  const header = [
    "activity_title",
    "activity_start_unix",
    "scope",
    "interval",
    "start_elapsed_s",
    "end_elapsed_s",
    "side",
    "segment_count",
    "metric",
    "unit",
    "valid_count",
    "median",
    "q25",
    "q75",
    "baseline_median",
    "change_pct",
    "speed_median_m_s",
    "speed_filter",
    "speed_min_m_s",
    "speed_max_m_s",
    "representative_source_index_0based",
  ];
  const rows = [header];
  for (const bin of [...analysis.thirds, ...analysis.bins])
    for (const side of [1, 2])
      for (const metric of METRICS) {
        const s = bin.summary[side][metric.key],
          b = analysis.baseline[side][metric.key];
        rows.push([
          data.title,
          data.start,
          bin.id.startsWith("third")
            ? "elapsed_time_third"
            : `${analysis.minutes}_minute_bin`,
          bin.label,
          bin.start,
          bin.end,
          side === 1 ? "left" : "right",
          bin.summary[side].n,
          metric.key,
          metric.unit === "原始单位" ? "raw_coordinate_unit" : metric.unit,
          s.n,
          s.median,
          s.q25,
          s.q75,
          b.median,
          s.n >= MIN_SAMPLES && b.n >= MIN_SAMPLES
            ? percentChange(s.median, b.median)
            : null,
          bin.summary[side].speed.median,
          analysis.matched
            ? "overall_speed_median_plus_minus_5_percent"
            : "all_segments",
          analysis.matched ? analysis.range.min : null,
          analysis.matched ? analysis.range.max : null,
          representative(bin.rows, side),
        ]);
      }
  const quote = (cell) => {
    let value = cell === null || cell === undefined ? "" : String(cell);
    if (typeof cell === "string" && /^[=+\-@\t\r]/.test(value))
      value = `'${value}`;
    return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  };
  return "\uFEFF" + rows.map((row) => row.map(quote).join(",")).join("\r\n");
}
