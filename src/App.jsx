import React, { useCallback, useMemo, useState } from "react";
import { expandHistory } from "./history-model.js";
import TrajectoryPanel from "./TrajectoryPanel.jsx";
import DistanceRange, { RANGE_STEPS } from "./DistanceRange.jsx";
import { dateText, clockTime, elapsed } from "./model.js";
import {
  ANALYSIS_METRICS,
  BASELINE_DAYS,
  BASELINE_WINDOWS,
  DAY,
  prepareRuns,
  recentBaseline,
  trendRows,
  trendChange,
  percentage,
  footDifference,
} from "./analysis-model.js";
import {
  distanceProfile,
  selectDistanceStage,
  distancePaceSeries,
} from "./distance-model.js";
import {
  HistoryPlot,
  PacePlot,
  valueText,
  metricText,
  signedText,
} from "./AnalysisCharts.jsx";

const runTitle = (run) => run.activity?.name ?? run.title ?? "跑步";
const runOption = (run) =>
  `${dateText(run.startTime)} ${clockTime(run.startTime).slice(0, 5)} · ${runTitle(run)}`;
const pct = (value) => (Number.isFinite(value) ? `${signedText(value)}%` : "—");
const direction = (value) =>
  !Number.isFinite(value)
    ? "—"
    : Math.abs(value) < 0.05
      ? "接近一致"
      : `${value > 0 ? "右" : "左"}侧更高 ${valueText(Math.abs(value))}%`;

function Chevron({ next = false }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <path d={next ? "m9 5 7 7-7 7" : "m15 5-7 7 7 7"} />
    </svg>
  );
}

function FootCell({ current, baseline, metric, side }) {
  const change = percentage(current.mean, baseline.mean);
  return (
    <td className={`foot-cell ${side === 1 ? "foot-left" : "foot-right"}`}>
      <strong>{metricText(current.mean, metric)}</strong>
      {Number.isFinite(change) && (
        <span className="cell-change">{pct(change)}</span>
      )}
      <small title={`${baseline.n} 次跑步；当前 ${current.n} 个有效片段`}>
        基准 {metricText(baseline.mean, metric)}
      </small>
    </td>
  );
}

function ComparisonTable({ summary, baseline, metricKey, onMetric }) {
  return (
    <table className="studio-metrics" data-testid="comparison-table">
      <thead>
        <tr>
          <th scope="col">指标</th>
          <th scope="col" className="foot-left">
            左脚
          </th>
          <th scope="col" className="foot-right">
            右脚
          </th>
        </tr>
      </thead>
      <tbody>
        {ANALYSIS_METRICS.map((metric) => (
          <tr
            key={metric.key}
            className={metricKey === metric.key ? "selected-metric" : ""}
            data-metric={metric.key}
            onClick={() => onMetric(metric.key)}
          >
            <th scope="row">
              <button aria-pressed={metricKey === metric.key}>
                {metric.label}
              </button>
              <small>{metric.unit}</small>
            </th>
            {[1, 2].map((side) => (
              <FootCell
                key={side}
                side={side}
                current={summary[side][metric.key]}
                baseline={baseline[side][metric.key]}
                metric={metric}
              />
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TrendSummary({ changes, metric, days }) {
  const balance = changes.difference;
  return (
    <div className="studio-trend-summary" data-testid="trend-summary">
      <h3>
        {days} 天内变化
        <span title="仅使用所选范围内的数据，期初和期末各取最多 5 次跑步均值，每侧各至少 3 次有效记录。">
          期初 → 期末
        </span>
      </h3>
      <div className="trend-summary-values">
        {[1, 2].map((side) => (
          <div key={side} className={side === 1 ? "foot-left" : "foot-right"}>
            <span>{side === 1 ? "左脚" : "右脚"}</span>
            <strong>
              {Number.isFinite(changes[side].percent)
                ? pct(changes[side].percent)
                : changes[side].enough
                  ? "—"
                  : "样本不足"}
            </strong>
            <small>
              {metricText(changes[side].before.mean, metric)} →{" "}
              {metricText(changes[side].after.mean, metric)} {metric.unit}
            </small>
          </div>
        ))}
        <div>
          <span>左右差异大小</span>
          <strong className="trend-change-value">
            {Number.isFinite(balance.delta) ? (
              <>
                {valueText(balance.before.mean)}%{" "}
                <span className="trend-change-context">→</span>{" "}
                {valueText(balance.after.mean)}%
              </>
            ) : (
              "—"
            )}
          </strong>
          <small>
            {Number.isFinite(balance.delta)
              ? Math.abs(balance.delta) < 0.05
                ? "基本持平"
                : balance.delta > 0
                  ? "差异增大"
                  : "差异减小"
              : "样本不足"}
          </small>
        </div>
      </div>
    </div>
  );
}

function FootBalance({ summary, baseline, baselineLabel, metric }) {
  const current = footDifference(
    summary[1][metric.key].mean,
    summary[2][metric.key].mean,
  );
  const reference = baseline.difference[metric.key].mean;
  return (
    <section
      className="studio-balance"
      aria-label="本次左右脚差异"
      data-testid="current-balance"
    >
      <h3>
        左右差异 <span>· {metric.label}</span>
      </h3>
      <div className="balance-values">
        <div>
          <span>当前</span>
          <strong>
            {Number.isFinite(current.percent)
              ? `${signedText(current.percent)}%`
              : "—"}
          </strong>
        </div>
        <div>
          <span>{baselineLabel}基准</span>
          <strong>
            {Number.isFinite(reference) ? `${signedText(reference)}%` : "—"}
          </strong>
        </div>
      </div>
      <p>
        {Number.isFinite(current.percent)
          ? direction(current.percent)
          : "当前无法计算左右差异"}
        {Number.isFinite(current.delta) && (
          <>
            {" "}
            · 相差 {metricText(Math.abs(current.delta), metric)} {metric.unit}
          </>
        )}
      </p>
    </section>
  );
}

export default function App({ history, source = "archive" }) {
  const runs = useMemo(() => expandHistory(history), [history]);
  const [selectedId, setSelectedId] = useState(() => runs.at(-1).id);
  const [metricKey, setMetricKey] = useState(ANALYSIS_METRICS[0].key);
  const [baselineDays, setBaselineDays] = useState(BASELINE_DAYS);
  const [distanceRange, setDistanceRange] = useState([0, RANGE_STEPS]);
  const prepared = useMemo(() => prepareRuns(runs), [runs]);
  const latest = prepared.at(-1);
  const selectedIndex = prepared.findIndex((run) => run.id === selectedId);
  const selected = prepared[selectedIndex] ?? latest;
  const baseline = useMemo(
    () => recentBaseline(prepared, latest, baselineDays),
    [prepared, latest, baselineDays],
  );
  const distance = useMemo(() => distanceProfile(selected), [selected]);
  const stage = useMemo(
    () =>
      selectDistanceStage(selected, distance, {
        start: distance.totalKm * (distanceRange[0] / RANGE_STEPS),
        end: distance.totalKm * (distanceRange[1] / RANGE_STEPS),
      }),
    [selected, distance, distanceRange],
  );
  const pace = useMemo(
    () => distancePaceSeries(selected, distance),
    [selected, distance],
  );
  const rows = useMemo(
    () => trendRows(prepared, latest, baselineDays, metricKey),
    [prepared, latest, baselineDays, metricKey],
  );
  const trendStart = latest.startTime - baselineDays * DAY;
  const changes = useMemo(() => trendChange(rows), [rows]);
  const metric = ANALYSIS_METRICS.find((item) => item.key === metricKey);
  const activateRun = useCallback((id) => {
    setSelectedId(id);
    setDistanceRange([0, RANGE_STEPS]);
  }, []);
  const stageLabel = !stage.fullRange
    ? `≈ ${valueText(stage.start, 2)}–${valueText(stage.end, 2)} km`
    : distance.available
      ? `全程 · ${distance.hasRecordedTotal ? "" : "≈ "}${valueText(distance.totalKm, 2)} km`
      : "全程";
  const validRuns = rows.filter(
    (row) => Number.isFinite(row.left) || Number.isFinite(row.right),
  ).length;
  const baselineValidRuns = baseline.runs.filter(
    (run) =>
      Number.isFinite(run.summary[1][metricKey].mean) ||
      Number.isFinite(run.summary[2][metricKey].mean),
  ).length;

  return (
    <div
      className="studio"
      data-testid="footpath-analysis"
      data-selected-run={selected.id}
      data-baseline-count={baselineValidRuns}
      data-baseline-days={baseline.days}
    >
      <header className="studio-header">
        <h1 className="studio-brand">
          Footpath <span>Studio</span>
        </h1>
        <span>
          {source === "demo" ? "合成演示" : "历史记录"} · {runs.length} 次
        </span>
      </header>
      <div className="studio-toolbar">
        <div className="toolbar-row">
          <label className="toolbar-caption" htmlFor="activity-select">
            活动
          </label>
          <div className="run-selector">
            <button
              className="icon-button"
              aria-label="上一次跑步"
              disabled={selectedIndex <= 0}
              onClick={() => activateRun(prepared[selectedIndex - 1].id)}
            >
              <Chevron />
            </button>
            <select
              id="activity-select"
              aria-label="选择跑步"
              value={selected.id}
              onChange={(event) => activateRun(event.target.value)}
            >
              {[...prepared].reverse().map((run) => (
                <option key={run.id} value={run.id}>
                  {runOption(run)}
                </option>
              ))}
            </select>
            <button
              className="icon-button"
              aria-label="下一次跑步"
              disabled={selectedIndex >= prepared.length - 1}
              onClick={() => activateRun(prepared[selectedIndex + 1].id)}
            >
              <Chevron next />
            </button>
          </div>
          <div className="run-metadata toolbar-meta">
            {Number.isFinite(selected.activity?.distance) && (
              <span>{valueText(selected.activity.distance / 1000, 2)} km</span>
            )}
            {Number.isFinite(selected.activity?.moving_time) && (
              <span title="运动时长">
                {elapsed(selected.activity.moving_time)}
              </span>
            )}
          </div>
        </div>
        <div
          className="baseline-label toolbar-row"
          data-testid="baseline-label"
          title={`最近 ${baseline.label} · ${dateText(baseline.start)} 至 ${dateText(baseline.end)}`}
        >
          <span className="baseline-caption toolbar-caption">基准</span>
          <div
            className="baseline-options"
            role="group"
            aria-label="对比基准范围"
          >
            {BASELINE_WINDOWS.map((value) => (
              <button
                key={value}
                aria-pressed={baselineDays === value}
                onClick={() => setBaselineDays(value)}
              >
                {value} 天
              </button>
            ))}
          </div>
          <span className="baseline-count toolbar-meta">
            {baselineValidRuns} 次跑步
          </span>
        </div>
      </div>

      <main className="studio-layout">
        <TrajectoryPanel
          selected={selected}
          baseline={baseline}
          allRuns={prepared}
          stage={stage}
        >
          <div className="run-timeline">
            <div className="timeline-heading">
              <span>配速 / km</span>
            </div>
            <PacePlot
              rows={pace}
              totalKm={distance.totalKm}
              stage={stage}
              rangeLabel={stageLabel}
            />
            <DistanceRange
              range={distanceRange}
              onChange={setDistanceRange}
              totalKm={distance.totalKm}
              disabled={!distance.available}
            />
            {!distance.available && (
              <p className="inline-empty" role="status">
                距离数据不足，显示整次跑步
              </p>
            )}
            {stage.rows.length === 0 && (
              <p className="inline-empty" role="status">
                此公里区间没有 Footpath 片段
              </p>
            )}
            {baseline.runs.length === 0 && (
              <p className="inline-empty" role="status">
                最近 {baseline.label}没有基准记录
              </p>
            )}
            {baseline.runs.length > 0 && baselineValidRuns === 0 && (
              <p className="inline-empty" role="status">
                当前指标没有有效基准
              </p>
            )}
          </div>
        </TrajectoryPanel>

        <aside className="studio-comparison studio-panel" aria-label="本次对比">
          <div className="panel-heading">
            <h2>指标对比</h2>
          </div>

          <ComparisonTable
            summary={stage.summary}
            baseline={baseline.summary}
            metricKey={metricKey}
            onMetric={setMetricKey}
          />
          <FootBalance
            summary={stage.summary}
            baseline={baseline.summary}
            baselineLabel={`最近 ${baseline.label}`}
            metric={metric}
          />
        </aside>
        <section className="studio-trends studio-panel" aria-label="变化趋势">
          <div className="panel-heading">
            <h2>变化趋势</h2>
            <span
              className="panel-meta"
              title={`${dateText(trendStart)} 至 ${dateText(latest.startTime)}`}
            >
              最近 {baseline.label} · {validRuns} 次跑步
            </span>
          </div>
          <div className="metric-tabs" role="group" aria-label="趋势指标">
            {ANALYSIS_METRICS.map((item) => (
              <button
                key={item.key}
                aria-pressed={metricKey === item.key}
                onClick={() => setMetricKey(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="trend-plots">
            <div>
              <div className="chart-heading">
                <h3>
                  {metric.label} <span>· {metric.unit}</span>
                </h3>
                <div className="foot-legend">
                  <span className="foot-left">左脚</span>
                  <span className="foot-right">右脚</span>
                </div>
              </div>
              <HistoryPlot
                rows={rows}
                metric={metric}
                startTime={trendStart}
                endTime={latest.startTime}
                onSelect={activateRun}
              />
            </div>
            <div>
              <div className="chart-heading difference-heading">
                <h3>
                  左右差异 <span>· %</span>
                </h3>
                <span className="direction-legend">＋右高 / −左高</span>
              </div>
              <HistoryPlot
                rows={rows}
                metric={metric}
                startTime={trendStart}
                endTime={latest.startTime}
                onSelect={activateRun}
                difference
              />
            </div>
          </div>
          <TrendSummary changes={changes} metric={metric} days={baselineDays} />
        </section>
      </main>
    </div>
  );
}
