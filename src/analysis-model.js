import { METRICS } from "./trends.js";
import { CENTIMETERS_PER_METER } from "./model.js";

export const DAY = 86400;
export const BASELINE_DAYS = 90;
export const BASELINE_WINDOWS = [30, 60, 90, 180, 365];
export const MIN_OBSERVATIONS = 3;
// Keep archive values and calculations in meters; convert only display text.
export const ANALYSIS_METRICS = METRICS.map((metric) =>
  metric.unit === "m"
    ? {
        ...metric,
        unit: "cm",
        digits: 2,
        displayScale: CENTIMETERS_PER_METER,
      }
    : metric,
);
const finite = Number.isFinite;
const mean = (values) =>
  values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  return (
    sorted[Math.floor(i)] +
    (sorted[Math.ceil(i)] - sorted[Math.floor(i)]) * (i % 1)
  );
}

// Extreme outliers only. A zero IQR or fewer than eight samples does not
// provide enough spread information to reject observations automatically.
export function cleanMean(values, fixedBounds = null) {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  const q25 = percentile(sorted, 0.25),
    q75 = percentile(sorted, 0.75);
  const iqr = q75 - q25;
  const bounds =
    fixedBounds ??
    (sorted.length >= 8 && iqr > 0
      ? [q25 - 3 * iqr, q75 + 3 * iqr]
      : [-Infinity, Infinity]);
  const kept = sorted.filter(
    (value) => value >= bounds[0] && value <= bounds[1],
  );
  return {
    mean: kept.length >= MIN_OBSERVATIONS ? mean(kept) : null,
    n: kept.length,
    total: sorted.length,
    excluded: sorted.length - kept.length,
    bounds,
  };
}

function validValue(row, key) {
  const value = row[key];
  return finite(value) &&
    (key === "groundContactTime" || key === "strideTime"
      ? value > 0
      : value >= 0)
    ? value
    : null;
}

export function summarizeClean(rows, reference = null) {
  const result = {};
  for (const side of [1, 2]) {
    const foot = rows.filter((row) => row.side === side);
    result[side] = { n: foot.length };
    for (const { key } of METRICS)
      result[side][key] = cleanMean(
        foot.map((row) => validValue(row, key)),
        reference?.[side]?.[key]?.bounds,
      );
  }
  return result;
}

export function eventStart(run) {
  return finite(run.activity?.timestamp)
    ? Math.min(run.start, run.activity.timestamp)
    : run.start;
}

export function prepareRuns(runs, targetSpeed = null) {
  return runs
    .map((run) => {
      const rows =
        targetSpeed === null
          ? run.rows
          : run.rows.filter(
              (row) =>
                finite(row.speed) &&
                row.speed >= targetSpeed * 0.95 &&
                row.speed <= targetSpeed * 1.05,
            );
      const startTime = eventStart(run);
      return {
        ...run,
        startTime,
        duration: Math.max(0, run.end - startTime),
        eligible: rows,
        summary: summarizeClean(rows),
      };
    })
    .sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
}

export function percentage(value, reference) {
  return finite(value) && finite(reference) && reference !== 0
    ? (value / reference - 1) * 100
    : null;
}

// Symmetric denominator: positive means right > left; negative means left > right.
export function footDifference(left, right) {
  if (!finite(left) || !finite(right)) return { delta: null, percent: null };
  const center = (left + right) / 2;
  return {
    delta: right - left,
    percent: center > 0 ? ((right - left) / center) * 100 : null,
  };
}

function acrossRuns(values) {
  const valid = values.filter(finite).sort((a, b) => a - b);
  return {
    mean: mean(valid),
    n: valid.length,
    q25: percentile(valid, 0.25),
    q75: percentile(valid, 0.75),
  };
}

export function aggregateRuns(runs) {
  const summary = { 1: {}, 2: {}, difference: {}, magnitude: {} };
  for (const { key } of METRICS) {
    for (const side of [1, 2])
      summary[side][key] = acrossRuns(
        runs.map((run) => run.summary[side][key].mean),
      );
    const differences = runs.map(
      (run) =>
        footDifference(run.summary[1][key].mean, run.summary[2][key].mean)
          .percent,
    );
    summary.difference[key] = acrossRuns(differences);
    // Do not let opposite directions cancel when measuring the size of imbalance.
    summary.magnitude[key] = acrossRuns(
      differences.filter(finite).map(Math.abs),
    );
  }
  return summary;
}

export function recentBaseline(runs, anchor, days = BASELINE_DAYS) {
  if (!BASELINE_WINDOWS.includes(days)) days = BASELINE_DAYS;
  const end = anchor.startTime;
  const start = end - days * DAY;
  const included = runs.filter(
    (run) => run.startTime >= start && run.startTime <= end,
  );
  return {
    days,
    label: `${days} 天`,
    start,
    end,
    runs: included,
    summary: aggregateRuns(included),
  };
}

export function selectStage(
  run,
  { segmented = false, position = 0, minutes = 5 } = {},
) {
  const width = Math.min(run.duration, Math.max(1, minutes) * 60);
  const start = segmented
    ? (Math.max(0, run.duration - width) *
        Math.min(100, Math.max(0, position))) /
      100
    : 0;
  const end = segmented ? Math.min(run.duration, start + width) : run.duration;
  // Whole-run outlier bounds remain fixed while the time window moves.
  const rows = segmented
    ? run.eligible.filter((row) => {
        const time = row.time - run.startTime;
        return (
          time >= start && (time < end || (end === run.duration && time <= end))
        );
      })
    : run.eligible;
  return {
    start,
    end,
    rows,
    summary: segmented ? summarizeClean(rows, run.summary) : run.summary,
  };
}

export function paceSeries(run) {
  const bins = Array.from(
    { length: Math.max(1, Math.ceil(run.duration / 60)) },
    (_, i) => ({ time: i * 60, speeds: [] }),
  );
  for (const row of run.rows) {
    if (!finite(row.speed) || row.speed <= 0) continue;
    const index = Math.min(
      bins.length - 1,
      Math.max(0, Math.floor((row.time - run.startTime) / 60)),
    );
    bins[index].speeds.push(row.speed);
  }
  return bins.map(({ time, speeds }) => ({
    time: Math.min(time + 30, run.duration),
    pace: speeds.length ? 1000 / mean(speeds) / 60 : null,
  }));
}

export function trendRows(runs, selected, days, key) {
  const end = selected.startTime;
  const included = runs.filter(
    (run) =>
      run.startTime <= end && (!days || run.startTime >= end - days * DAY),
  );
  const trailing = { left: [], right: [], difference: [] };
  return included.map((run) => {
    const left = run.summary[1][key].mean,
      right = run.summary[2][key].mean;
    const row = {
      id: run.id,
      time: run.startTime,
      left,
      right,
      difference: footDifference(left, right).percent,
    };
    for (const field of Object.keys(trailing)) {
      if (finite(row[field])) {
        trailing[field].push(row[field]);
        if (trailing[field].length > 5) trailing[field].shift();
      }
      row[field + "Trend"] =
        finite(row[field]) && trailing[field].length === 5
          ? mean(trailing[field])
          : null;
    }
    return row;
  });
}

export function trendChange(rows) {
  const observed = rows.filter((row) => finite(row.left) || finite(row.right));
  // Both ends come from the plotted range and never share a run.
  const windowSize = Math.min(5, Math.floor(observed.length / 2));
  const first = observed.slice(0, windowSize);
  const last = windowSize ? observed.slice(-windowSize) : [];
  const summarize = (group, field, absolute) => {
    const values = group.map((row) =>
      absolute && finite(row[field]) ? Math.abs(row[field]) : row[field],
    );
    const result = acrossRuns(values);
    return {
      ...result,
      mean: result.n >= MIN_OBSERVATIONS ? result.mean : null,
    };
  };
  const change = (field, absolute = false) => {
    const before = summarize(first, field, absolute);
    const after = summarize(last, field, absolute);
    const enough = before.n >= MIN_OBSERVATIONS && after.n >= MIN_OBSERVATIONS;
    return {
      before,
      after,
      enough,
      percent: enough ? percentage(after.mean, before.mean) : null,
      delta: enough ? after.mean - before.mean : null,
    };
  };
  return {
    windowSize,
    1: change("left"),
    2: change("right"),
    difference: change("difference", true),
  };
}
