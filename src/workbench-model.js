import { COLORS } from "./model.js";
import { representative } from "./trends.js";

// Compare recorded fragments selected with the same rule and speed filter.
// Keeping the source index makes every displayed curve traceable to raw data.
export function buildComparison(current, baseline, currentRows, baselineRows) {
  const segments = [];
  for (const [role, data, rows] of [
    ["baseline", baseline, baselineRows],
    ["current", current, currentRows],
  ]) {
    for (const side of [1, 2]) {
      const sourceIndex = representative(rows, side);
      if (sourceIndex === null) continue;
      const source = data.segments[sourceIndex];
      if (!source || source.side !== side)
        throw new Error("代表片段与原始数据不匹配。");
      segments.push({
        ...source,
        sourceIndex,
        comparisonRole: role,
        color: side === 1 ? COLORS.left : COLORS.right,
        dashed: role === "baseline",
        opacity: role === "baseline" ? 0.55 : 0.98,
        hideMarker: true,
        linewidth: role === "baseline" ? 2.2 : 3,
      });
    }
  }
  return {
    ...current,
    segments,
    pointCount: segments.reduce((n, s) => n + s.points.length, 0),
  };
}

export function searchRuns(runs, query) {
  const normalize = (value) =>
    String(value)
      .toLowerCase()
      .replace(/[\/\-\s]/g, "");
  const term = normalize(query.trim());
  return [...runs].reverse().filter((run) => {
    const date = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(run.start * 1000));
    return normalize(
      `${date} ${run.activity?.name ?? run.title ?? ""}`,
    ).includes(term);
  });
}

export function durationLabel(seconds) {
  if (!Number.isFinite(seconds)) return "未记录时长";
  const value = Math.max(0, Math.round(seconds));
  return [
    Math.floor(value / 3600),
    Math.floor((value % 3600) / 60)
      .toString()
      .padStart(2, "0"),
    (value % 60).toString().padStart(2, "0"),
  ].join(":");
}
