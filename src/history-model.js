import { normalizeData, dateText, clockTime } from "./model.js";
import { fetchDataBytes } from "./site-data.js";
import {
  METRICS,
  MIN_SAMPLES,
  deriveRows,
  eligibleRows,
  percentChange,
  quantile,
  summarize,
  representative,
} from "./trends.js";

export const ROW_FIELDS = [
  "index",
  "side",
  "time",
  "speed",
  "xSpan",
  "ySpan",
  "zSpan",
  "groundContactTime",
  "strideTime",
];
export const signature = (run) =>
  `${run.start}:${run.end}:${run.rows.length}:${run.pointCount}`;
export const runLabel = (run) =>
  `${dateText(run.start)} ${clockTime(run.start).slice(0, 5)} · ${run.activity?.name ?? "导入跑步"}`;
export const gearKey = (run) =>
  (run.activity?.apparel_ids ?? []).map(String).sort().join(",");

export function expandHistory(input) {
  if (
    input?.format !== "footpath-studio-collection-v1" ||
    !Array.isArray(input.runs) ||
    !input.runs.length
  )
    throw new Error("历史数据格式无效");
  return input.runs
    .map((run) => ({
      ...run,
      rows: run.rows.map((row) => ({
        ...Object.fromEntries(ROW_FIELDS.map((key, i) => [key, row[i]])),
        elapsed: row[2] - run.start,
      })),
    }))
    .sort((a, b) => a.start - b.start);
}

export function runFromRaw(input, fileName) {
  const data = normalizeData(input, fileName);
  const rows = deriveRows(data);
  return {
    id: `import-${data.start}-${data.end}-${rows.length}-${data.pointCount}`,
    title: data.title,
    start: data.start,
    end: data.end,
    pointCount: data.pointCount,
    activity: { name: data.title },
    rows,
    data,
  };
}

export function mergeRuns(existing, incoming) {
  const seen = new Set(existing.map(signature));
  const result = [...existing];
  for (const run of incoming)
    if (!seen.has(signature(run))) {
      seen.add(signature(run));
      result.push(run);
    }
  return result.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

const cache = new Map();
export function clearRunCache() {
  cache.clear();
}
export async function loadRunData(run) {
  if (run.data) return run.data;
  if (cache.has(run.id)) {
    const value = cache.get(run.id);
    cache.delete(run.id);
    cache.set(run.id, value);
    return value;
  }
  const promise = (async () => {
    let compressed;
    if (run.packedGzip)
      compressed = Uint8Array.from(atob(run.packedGzip), (c) =>
        c.charCodeAt(0),
      );
    else compressed = await fetchDataBytes(run.packedUrl);
    const stream = new Blob([compressed])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    return normalizeData(JSON.parse(await new Response(stream).text()));
  })();
  cache.set(run.id, promise);
  while (cache.size > 3) cache.delete(cache.keys().next().value);
  try {
    return await promise;
  } catch (error) {
    cache.delete(run.id);
    throw error;
  }
}

export function defaultTarget(runs) {
  const middle = quantile(
    runs.map((run) =>
      quantile(
        run.rows.map((row) => row.speed),
        0.5,
      ),
    ),
    0.5,
  );
  return middle === null ? 3.5 : Math.round(middle / 0.05) * 0.05;
}

export function targetSpeedOptions(runs, current) {
  const values = [
    ...Array.from({ length: 71 }, (_, index) => 2 + index * 0.05),
    defaultTarget(runs),
    current,
  ];
  return [
    ...new Set(values.filter(Number.isFinite).map((value) => value.toFixed(2))),
  ].sort((a, b) => Number(a) - Number(b));
}

export function analyzeHistory(
  runs,
  {
    target = defaultTarget(runs),
    matched = true,
    surface = "all",
    days = 0,
  } = {},
) {
  const range = { center: target, min: target * 0.95, max: target * 1.05 };
  const end = Math.max(...runs.map((run) => run.start));
  const endDay = Math.floor((end + 28800) / 86400) * 86400 - 28800;
  return runs
    .filter(
      (run) =>
        (!days || run.start >= endDay - (days - 1) * 86400) &&
        (surface === "all" ||
          (run.activity?.surface_type || "unknown") === surface),
    )
    .map((run) => {
      const rows = eligibleRows(run.rows, matched, range);
      return {
        ...run,
        eligible: rows,
        summary: summarize(rows),
        retained: rows.length / run.rows.length,
        range,
        matched,
      };
    });
}

export function longitudinalRows(
  analysis,
  baseline,
  metricKey,
  relative = true,
) {
  const result = analysis.map((run) => {
    const row = {
      id: run.id,
      time: run.start,
      run,
      speed:
        run.summary.speed.n >= MIN_SAMPLES ? run.summary.speed.median : null,
    };
    for (const [side, key] of [
      [1, "left"],
      [2, "right"],
    ]) {
      const current = run.summary[side][metricKey],
        b = baseline?.summary[side][metricKey];
      const valid =
        current.n >= MIN_SAMPLES &&
        (!relative || (b?.n >= MIN_SAMPLES && b.median !== 0));
      const transform = (value) =>
        relative ? percentChange(value, b?.median) : value;
      row[key] = valid ? transform(current.median) : null;
      row[key + "Range"] = valid
        ? [transform(current.q25), transform(current.q75)]
        : null;
    }
    return row;
  });
  for (const key of ["left", "right"]) {
    const trailing = [];
    for (const row of result) {
      if (Number.isFinite(row[key])) trailing.push(row[key]);
      if (trailing.length > 5) trailing.shift();
      row[key + "Rolling"] =
        Number.isFinite(row[key]) && trailing.length === 5
          ? quantile(trailing, 0.5)
          : null;
    }
  }
  return result;
}

export function edgeChange(analysis, metricKey, side) {
  const valid = analysis.filter(
    (run) => run.summary[side][metricKey].n >= MIN_SAMPLES,
  );
  if (valid.length < 10) return null;
  const first = valid.slice(0, 5),
    last = valid.slice(-5);
  const before = quantile(
    first.map((run) => run.summary[side][metricKey].median),
    0.5,
  );
  const after = quantile(
    last.map((run) => run.summary[side][metricKey].median),
    0.5,
  );
  return {
    before,
    after,
    change: percentChange(after, before),
    first: first.map((r) => r.id),
    last: last.map((r) => r.id),
  };
}

export function acrossRunComparison(
  baselineData,
  currentData,
  baselineRows,
  currentRows,
  side,
) {
  const baselineIndex = representative(baselineRows, side),
    currentIndex = representative(currentRows, side);
  const segments = [];
  if (baselineIndex !== null)
    segments.push({
      ...baselineData.segments[baselineIndex],
      color: "#8996a8",
      dashed: true,
      hideMarker: true,
      linewidth: 2.4,
    });
  if (currentIndex !== null)
    segments.push({
      ...currentData.segments[currentIndex],
      hideMarker: true,
      linewidth: 3,
    });
  const bounds = {
    min: [0, 1, 2].map((i) =>
      Math.min(baselineData.bounds.min[i], currentData.bounds.min[i]),
    ),
    max: [0, 1, 2].map((i) =>
      Math.max(baselineData.bounds.max[i], currentData.bounds.max[i]),
    ),
  };
  return {
    ...currentData,
    segments,
    bounds,
    viewBounds: bounds,
    pointCount: segments.reduce((n, s) => n + s.points.length, 0),
    baselineIndex,
    currentIndex,
  };
}

export function historyCsv(analysis, baseline) {
  const rows = [
    [
      "activity_id",
      "foot_data_id",
      "date_shanghai",
      "activity_name",
      "side",
      "metric",
      "unit",
      "valid_count",
      "median",
      "q25",
      "q75",
      "baseline_foot_data_id",
      "baseline_median",
      "change_pct",
      "speed_median_m_s",
      "retained_count",
      "original_count",
      "retained_fraction",
      "speed_filter",
      "speed_min_m_s",
      "speed_max_m_s",
      "apparel_ids",
      "surface_type",
      "representative_source_index_0based",
    ],
  ];
  for (const run of analysis)
    for (const side of [1, 2])
      for (const metric of METRICS) {
        const s = run.summary[side][metric.key],
          b = baseline?.summary[side][metric.key];
        rows.push([
          run.activity?.id ?? "",
          run.id,
          dateText(run.start) + " " + clockTime(run.start),
          run.activity?.name ?? run.title,
          side === 1 ? "left" : "right",
          metric.key,
          metric.unit,
          s.n,
          s.median,
          s.q25,
          s.q75,
          baseline?.id,
          b?.median,
          s.n >= MIN_SAMPLES && b?.n >= MIN_SAMPLES
            ? percentChange(s.median, b.median)
            : null,
          run.summary[side].speed.median,
          run.eligible.length,
          run.rows.length,
          run.retained,
          run.matched ? "shared_target_plus_minus_5_percent" : "all_segments",
          run.matched ? run.range.min : null,
          run.matched ? run.range.max : null,
          gearKey(run),
          run.activity?.surface_type,
          representative(run.eligible, side),
        ]);
      }
  const quote = (cell) => {
    let value = cell == null ? "" : String(cell);
    if (typeof cell === "string" && /^[=+\-@\t\r]/.test(value))
      value = `'${value}`;
    return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  };
  return "\uFEFF" + rows.map((row) => row.map(quote).join(",")).join("\r\n");
}
