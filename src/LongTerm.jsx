import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { COLORS, dateText, footName, number } from "./model.js";
import { METRICS, MIN_SAMPLES, fmt, pct, percentChange } from "./trends.js";
import { ShapeComparison } from "./Trends.jsx";
import {
  analyzeHistory,
  acrossRunComparison,
  edgeChange,
  historyCsv,
  loadRunData,
  longitudinalRows,
  runLabel,
} from "./history-model.js";

const shortDate = (t) => dateText(t);
const surfaceName = (value) =>
  ({
    road: "公路",
    track: "跑道",
    treadmill: "跑步机",
    trail: "越野",
    unknown: "未记录",
  })[value] ??
  (value || "未记录");

function HistoryTooltip({ active, payload, metric, relative, speedOnly }) {
  const row = payload?.find((p) => p.payload?.run)?.payload;
  if (!active || !row) return null;
  return (
    <div className="trend-tooltip">
      <strong>{runLabel(row.run)}</strong>
      {speedOnly ? (
        <p>中位速度 {fmt(row.speed, 3)} m/s</p>
      ) : (
        [1, 2].map((side) => {
          const s = row.run.summary[side][metric.key];
          return (
            <div key={side} className={side === 1 ? "left-text" : "right-text"}>
              <p>
                {footName(side)} {fmt(s.median, metric.digits)} {metric.unit}{" "}
                {relative && `（${pct(row[side === 1 ? "left" : "right"])}）`}
              </p>
              <small>
                n = {s.n} · 25–75%：{fmt(s.q25, metric.digits)}–
                {fmt(s.q75, metric.digits)}
              </small>
            </div>
          );
        })
      )}
      <small>
        保留 {row.run.eligible.length} / {row.run.rows.length} 段 ·{" "}
        {surfaceName(row.run.activity?.surface_type)}
      </small>
    </div>
  );
}

export function HistoryChart({
  rows,
  baseline,
  selected,
  metric,
  relative,
  spread,
  rolling,
  onSelect,
  speedOnly = false,
}) {
  const values = rows
    .flatMap((row) =>
      speedOnly
        ? [row.speed]
        : spread
          ? [
              row.left,
              row.right,
              ...(row.leftRange ?? []),
              ...(row.rightRange ?? []),
            ]
          : [row.left, row.right],
    )
    .filter(Number.isFinite);
  let lo = values.length ? Math.min(...values) : 0,
    hi = values.length ? Math.max(...values) : 1;
  if (relative && !speedOnly) {
    lo = Math.min(0, lo);
    hi = Math.max(0, hi);
  }
  const rough = (hi - lo || Math.abs(hi) * 0.1 || 1) / (speedOnly ? 2 : 4);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].find((n) => n * magnitude >= rough) * magnitude;
  const domain = [Math.floor(lo / step) * step, Math.ceil(hi / step) * step];
  if (domain[0] === domain[1]) {
    domain[0] -= step;
    domain[1] += step;
  }
  const ticks = Array.from(
    { length: Math.round((domain[1] - domain[0]) / step) + 1 },
    (_, i) => domain[0] + i * step,
  );
  const first = rows[0]?.time ?? 0,
    last = rows.at(-1)?.time ?? 1;
  const extent = first === last ? [first - 43200, last + 43200] : [first, last];
  const dateTicks = Array.from(
    { length: 5 },
    (_, i) => extent[0] + (i * (extent[1] - extent[0])) / 4,
  );
  const dense = rows.length > 80;
  const dot = (side) => (props) => {
    if (!Number.isFinite(props.cy) || !Number.isFinite(props.value))
      return null;
    const color = side === 1 ? COLORS.left : COLORS.right,
      active = props.payload.id === selected?.id;
    const radius = active ? 5 : dense ? 2 : 3.2;
    const common = {
      fill: color,
      fillOpacity: active ? 1 : dense ? 0.4 : 0.75,
      stroke: active ? "#edf0f4" : color,
      strokeWidth: active ? 1.5 : 0,
      tabIndex: 0,
      role: "button",
      "aria-label": `${runLabel(props.payload.run)}，${footName(side)}，${relative ? pct(props.value) : fmt(props.value, metric.digits)}`,
      onClick: (e) => {
        if (!dense) {
          e.stopPropagation();
          onSelect(props.payload.id);
        }
      },
      onKeyDown: (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(props.payload.id);
        }
      },
    };
    return side === 1 ? (
      <circle
        key={props.key}
        cx={props.cx}
        cy={props.cy}
        r={radius}
        {...common}
      />
    ) : (
      <rect
        key={props.key}
        x={props.cx - radius}
        y={props.cy - radius}
        width={radius * 2}
        height={radius * 2}
        {...common}
      />
    );
  };
  return (
    <div
      className={`trend-chart history-chart ${speedOnly ? "speed-chart" : ""}`}
      data-testid={speedOnly ? "history-speed-chart" : "history-chart"}
    >
      <div className="chart-unit">
        {speedOnly
          ? "速度 (m/s)"
          : relative
            ? "相对基准变化 (%)"
            : `${metric.label} (${metric.unit})`}
      </div>
      {!speedOnly && (
        <div className="chart-legend">
          <span>
            <i className="left-line" />● 左脚
          </span>
          <span>
            <i className="right-line" />■ 右脚
          </span>
        </div>
      )}
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <ComposedChart
          data={rows}
          margin={{ top: speedOnly ? 29 : 40, right: 24, left: 0, bottom: 0 }}
          accessibilityLayer
          onClick={(state) => {
            // In dense history, choose the nearest date rather than the top overlapping dot.
            const row =
              state.activeTooltipIndex != null
                ? rows[Number(state.activeTooltipIndex)]
                : null;
            if (state.isTooltipActive && row) onSelect(row.id);
          }}
        >
          <CartesianGrid vertical={false} stroke="#e1e7ed" />
          <XAxis
            type="number"
            dataKey="time"
            domain={extent}
            ticks={dateTicks}
            tickFormatter={shortDate}
            tick={{ fontSize: 12 }}
            tickLine={false}
            stroke="#8c9aa9"
            minTickGap={25}
            interval="preserveStartEnd"
          />
          <YAxis
            domain={domain}
            ticks={ticks}
            tickFormatter={(v) =>
              fmt(v, Math.max(0, -Math.floor(Math.log10(step))))
            }
            width={60}
            tick={{ fontSize: 12, fill: "#6c7c8e" }}
            axisLine={false}
            tickLine={false}
          />
          {relative && !speedOnly && (
            <ReferenceLine y={0} stroke="#98a4b1" strokeDasharray="4 4" />
          )}
          {selected && (
            <ReferenceLine
              x={selected.start}
              stroke="#789c99"
              strokeDasharray="3 3"
            />
          )}
          <Tooltip
            content={
              <HistoryTooltip
                metric={metric}
                relative={relative}
                speedOnly={speedOnly}
              />
            }
            isAnimationActive={false}
          />
          {!speedOnly &&
            spread &&
            [1, 2].map((side) => (
              <Area
                key={side}
                type="linear"
                dataKey={side === 1 ? "leftRange" : "rightRange"}
                fill={side === 1 ? COLORS.left : COLORS.right}
                fillOpacity={0.09}
                stroke="none"
                connectNulls={false}
                isAnimationActive={false}
                tooltipType="none"
              />
            ))}
          {speedOnly ? (
            <Line
              dataKey="speed"
              stroke="#7b8fa2"
              strokeWidth={1.5}
              dot={{ r: 2.5 }}
              activeDot={false}
              isAnimationActive={false}
              connectNulls={false}
            />
          ) : (
            [1, 2].map((side) => (
              <Line
                key={side}
                dataKey={side === 1 ? "left" : "right"}
                stroke={side === 1 ? COLORS.left : COLORS.right}
                strokeWidth={rolling ? 1 : 1.8}
                strokeOpacity={rolling ? 0.2 : 0.85}
                strokeDasharray={side === 2 ? "5 4" : undefined}
                dot={dot(side)}
                activeDot={false}
                isAnimationActive={false}
                connectNulls={false}
              />
            ))
          )}
          {!speedOnly &&
            rolling &&
            [1, 2].map((side) => (
              <Line
                key={"rolling" + side}
                dataKey={side === 1 ? "leftRolling" : "rightRolling"}
                stroke={side === 1 ? COLORS.left : COLORS.right}
                strokeWidth={2.7}
                strokeDasharray={side === 2 ? "6 4" : undefined}
                dot={false}
                activeDot={false}
                isAnimationActive={false}
                connectNulls={false}
              />
            ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function RunShapes({ baseline, selected, onInspect }) {
  const [loaded, setLoaded] = useState(null),
    [error, setError] = useState(null);
  const key = `${baseline.id}:${selected.id}`;
  useEffect(() => {
    let active = true;
    setError(null);
    Promise.all([loadRunData(baseline), loadRunData(selected)])
      .then(([before, current]) => {
        if (active) setLoaded({ key, before, current });
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [key]);
  const comparisons = useMemo(
    () =>
      loaded?.key === key
        ? Object.fromEntries(
            [1, 2].map((side) => [
              side,
              acrossRunComparison(
                loaded.before,
                loaded.current,
                baseline.eligible,
                selected.eligible,
                side,
              ),
            ]),
          )
        : null,
    [loaded, key, baseline, selected],
  );
  if (error)
    return (
      <p role="alert" className="empty-analysis">
        三维轨迹读取失败：{error}
      </p>
    );
  if (!comparisons)
    return (
      <div className="loading-shapes" role="status">
        正在读取所选跑步的三维曲线…
      </div>
    );
  return (
    <ShapeComparison
      comparisons={comparisons}
      title="跨次轨迹对比"
      currentLabel={shortDate(selected.start)}
      baselineLabel={`${shortDate(baseline.start)} 基准`}
      onInspect={onInspect}
    />
  );
}

const LongTerm = forwardRef(function LongTerm(
  { runs, settings, setSettings, selectedId, setSelectedId, onOpen },
  ref,
) {
  const {
    target,
    matched,
    metricKey,
    relative,
    spread,
    rolling,
    baselineId,
    days,
    surface,
  } = settings;
  const change = (key, value) =>
    setSettings((previous) => ({ ...previous, [key]: value }));
  const analysis = useMemo(
    () => analyzeHistory(runs, { target, matched, days, surface }),
    [runs, target, matched, days, surface],
  );
  const baseline = analysis.find((r) => r.id === baselineId) ?? analysis[0];
  const selected = analysis.find((r) => r.id === selectedId) ?? analysis.at(-1);
  const metric = METRICS.find((m) => m.key === metricKey);
  const rows = useMemo(
    () => longitudinalRows(analysis, baseline, metricKey, relative),
    [analysis, baseline, metricKey, relative],
  );
  useImperativeHandle(
    ref,
    () => ({ exportCsv: () => historyCsv(analysis, baseline) }),
    [analysis, baseline],
  );
  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected?.id, selectedId]);
  const validRuns = rows.filter(
    (row) => Number.isFinite(row.left) || Number.isFinite(row.right),
  ).length;
  const leftEdge = edgeChange(analysis, metricKey, 1),
    rightEdge = edgeChange(analysis, metricKey, 2);
  const rangeLabel = `${fmt(target * 0.95, 4)}–${fmt(target * 1.05, 4)} m/s`;
  return (
    <main
      className="trend-workspace longterm-workspace"
      data-testid="longterm-workspace"
      data-run-count={analysis.length}
      data-speed-min={target * 0.95}
      data-speed-max={target * 1.05}
      data-baseline={baseline?.id}
      data-current={selected?.id}
    >
      <div className="trend-main">
        <div className="trend-heading">
          <div>
            <h2>多次跑步的变化趋势</h2>
            <p>
              {analysis.length} 次跑步 ·{" "}
              {analysis.length
                ? `${dateText(analysis[0].start)}–${dateText(analysis.at(-1).start)}`
                : "当前筛选没有跑步"}{" "}
              · {number(analysis.reduce((n, r) => n + r.rows.length, 0))} 个片段
            </p>
          </div>
          <span className="local-badge">本地分析</span>
        </div>
        <div className="history-filters">
          <select
            aria-label="日期范围"
            value={days}
            onChange={(e) => change("days", Number(e.target.value))}
          >
            <option value={0}>全部已载入日期</option>
            <option value={60}>最近 60 天</option>
            <option value={30}>最近 30 天</option>
          </select>
          <select
            aria-label="路面筛选"
            value={surface}
            onChange={(e) => change("surface", e.target.value)}
          >
            <option value="all">所有路面</option>
            {[
              ...new Set(
                runs.map((r) => r.activity?.surface_type || "unknown"),
              ),
            ].map((s) => (
              <option key={s} value={s}>
                {surfaceName(s)}
              </option>
            ))}
          </select>
          <label className="plain-check">
            <input
              type="checkbox"
              checked={matched}
              onChange={(e) => change("matched", e.target.checked)}
            />
            固定速度范围
          </label>
          <label className="speed-target">
            目标{" "}
            <select
              aria-label="目标速度"
              value={target.toFixed(2)}
              onChange={(e) => change("target", Number(e.target.value))}
              disabled={!matched}
            >
              {Array.from({ length: 71 }, (_, i) =>
                (2 + i * 0.05).toFixed(2),
              ).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>{" "}
            m/s ±5%
          </label>
        </div>
        <div className="metric-buttons" role="group" aria-label="长期趋势指标">
          {METRICS.map((m) => (
            <button
              key={m.key}
              aria-pressed={metricKey === m.key}
              onClick={() => change("metricKey", m.key)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="chart-options">
          <span>每个点 = 一次跑步的片段中位数</span>
          <div>
            {[
              ["relative", relative, "相对基准"],
              ["spread", spread, "25–75% 范围"],
              ["rolling", rolling, "5 次滚动中位数"],
            ].map(([key, value, label]) => (
              <label key={key} className="plain-check">
                <input
                  type="checkbox"
                  checked={value}
                  onChange={(e) => change(key, e.target.checked)}
                />
                {label}
              </label>
            ))}
          </div>
        </div>
        {analysis.length > 0 ? (
          <>
            {!validRuns && (
              <p role="status" className="empty-analysis">
                当前速度范围或基准没有足够片段。可调整速度、取消筛选，或更换基准跑步。
              </p>
            )}
            <HistoryChart
              rows={rows}
              baseline={baseline}
              selected={selected}
              metric={metric}
              relative={relative}
              spread={spread}
              rolling={rolling}
              onSelect={setSelectedId}
            />
            <p className="chart-axis-label">
              日期 · 点击数据点选择跑步 ·{" "}
              {rolling
                ? "粗线为最近 5 次有效跑步的滚动中位数"
                : "连线仅引导阅读"}
            </p>
            <HistoryChart
              rows={rows}
              baseline={baseline}
              selected={selected}
              metric={metric}
              relative={relative}
              onSelect={setSelectedId}
              speedOnly
            />
            <div className="chart-footnote">
              <span>
                {matched
                  ? `所有日期共用 ${rangeLabel}`
                  : "全部速度 · 速度差异可能影响形状"}
              </span>
              <span>
                可比 {validRuns} / {analysis.length} 次 · 每侧至少 {MIN_SAMPLES}{" "}
                段
              </span>
            </div>
            {(leftEdge || rightEdge) && (
              <div className="longterm-summary" data-testid="longterm-summary">
                <strong>{metric.label} · 近期 5 次 vs 最早 5 次</strong>
                <span className="left-text">左 {pct(leftEdge?.change)}</span>
                <span className="right-text">右 {pct(rightEdge?.change)}</span>
                <small>
                  对各次中位数再取中位数，等权比较。增减不代表好坏。
                </small>
              </div>
            )}
            <RunShapes
              baseline={baseline}
              selected={selected}
              onInspect={(index) => onOpen(selected, "detail", index)}
            />
          </>
        ) : (
          <p role="status" className="empty-analysis">
            没有符合条件的跑步，请调整日期或路面筛选。
          </p>
        )}
        <details className="trend-source-data">
          <summary>跑步数据（{analysis.length} 次）</summary>
          <div className="source-table-wrap">
            <table>
              <caption>{metric.label} · 每个日期可选择查看</caption>
              <thead>
                <tr>
                  <th>日期 / 开始时间</th>
                  <th>路面</th>
                  <th>左中位数</th>
                  <th>左 n</th>
                  <th>右中位数</th>
                  <th>右 n</th>
                  <th>保留率</th>
                  <th>速度 m/s</th>
                </tr>
              </thead>
              <tbody>
                {analysis.map((run) => (
                  <tr
                    key={run.id}
                    className={
                      run.id === selected?.id ? "selected-run-row" : ""
                    }
                  >
                    <th>
                      <button onClick={() => setSelectedId(run.id)}>
                        {runLabel(run)}
                      </button>
                    </th>
                    <td>{surfaceName(run.activity?.surface_type)}</td>
                    <td>
                      {fmt(run.summary[1][metricKey].median, metric.digits)}
                    </td>
                    <td>{run.summary[1][metricKey].n}</td>
                    <td>
                      {fmt(run.summary[2][metricKey].median, metric.digits)}
                    </td>
                    <td>{run.summary[2][metricKey].n}</td>
                    <td>{fmt(run.retained * 100, 0)}%</td>
                    <td>{fmt(run.summary.speed.median, 3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>
      <aside className="trend-rail" aria-label="跨次比较与说明">
        {baseline && selected && (
          <>
            <section className="run-selectors">
              <label>
                基准跑步
                <select
                  aria-label="基准跑步"
                  value={baseline.id}
                  onChange={(e) => change("baselineId", e.target.value)}
                >
                  {analysis.map((run) => (
                    <option key={run.id} value={run.id}>
                      {runLabel(run)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                当前跑步
                <select
                  aria-label="当前跑步"
                  value={selected.id}
                  onChange={(e) => setSelectedId(e.target.value)}
                >
                  {analysis.map((run) => (
                    <option key={run.id} value={run.id}>
                      {runLabel(run)}
                    </option>
                  ))}
                </select>
              </label>
            </section>
            <section className="delta-section">
              <h2>当前 vs 基准</h2>
              <p className="section-subtitle">
                {shortDate(selected.start)} vs {shortDate(baseline.start)} ·
                每侧分别比较
              </p>
              <table className="delta-table" data-testid="history-delta">
                <thead>
                  <tr>
                    <th>指标</th>
                    <th>左脚</th>
                    <th>右脚</th>
                  </tr>
                </thead>
                <tbody>
                  {METRICS.map((m) => (
                    <tr
                      key={m.key}
                      className={m.key === metricKey ? "current-metric" : ""}
                    >
                      <th>
                        <button onClick={() => change("metricKey", m.key)}>
                          {m.label}
                        </button>
                      </th>
                      {[1, 2].map((side) => {
                        const a = baseline.summary[side][m.key],
                          b = selected.summary[side][m.key];
                        return (
                          <td
                            key={side}
                            className={side === 1 ? "left-text" : "right-text"}
                          >
                            <strong>
                              {pct(
                                a.n >= MIN_SAMPLES && b.n >= MIN_SAMPLES
                                  ? percentChange(b.median, a.median)
                                  : null,
                              )}
                            </strong>
                            <small>
                              {fmt(a.median, m.digits)} →{" "}
                              {fmt(b.median, m.digits)}
                            </small>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="table-footnote">
                X/Y/Z：原始坐标单位 · 触地与周期：ms
                <br />
                基准 → 当前 · 变化率 =（当前 ÷ 基准 − 1）×100%
              </p>
            </section>
            <section className="selected-window">
              <h2>样本与条件</h2>
              <dl className="metric-list" data-testid="history-samples">
                <div>
                  <dt>基准 · 左 / 右</dt>
                  <dd>
                    {baseline.summary[1].n} / {baseline.summary[2].n}
                  </dd>
                </div>
                <div>
                  <dt>当前 · 左 / 右</dt>
                  <dd>
                    {selected.summary[1].n} / {selected.summary[2].n}
                  </dd>
                </div>
                <div>
                  <dt>保留率 · 基准 → 当前</dt>
                  <dd>
                    {fmt(baseline.retained * 100, 0)}% →{" "}
                    {fmt(selected.retained * 100, 0)}%
                  </dd>
                </div>
                <div>
                  <dt>速度 · 基准 → 当前</dt>
                  <dd>
                    {fmt(baseline.summary.speed.median, 3)} →{" "}
                    {fmt(selected.summary.speed.median, 3)}
                  </dd>
                </div>
                <div>
                  <dt>路面 · 基准 → 当前</dt>
                  <dd>
                    {surfaceName(baseline.activity?.surface_type)} →{" "}
                    {surfaceName(selected.activity?.surface_type)}
                  </dd>
                </div>
              </dl>
              <button
                className="button primary open-run"
                onClick={() => onOpen(selected, "trends")}
              >
                查看这次跑步 →
              </button>
            </section>
          </>
        )}
        <section className="trend-explanation">
          <h2>怎样看长期变化</h2>
          <p>
            先看同一指标的滚动中位数是否持续变化，再点开日期对照三维形状和样本量。
          </p>
          <p>
            {matched
              ? `各次共用 ${rangeLabel}，不会随每次的快慢移动筛选范围。`
              : "已取消速度筛选，当前比较包含各次跑步的全部速度。"}{" "}
            5 次滚动中位数按有效跑步次数计算；25–75% 带表示单次片段分布。
          </p>
          <details>
            <summary>数据来源与比较边界</summary>
            <p>
              当前载入 {runs.length} 次 Footpath
              {runs.length > 0
                ? `，覆盖 ${dateText(runs[0].start)}–${dateText(runs.at(-1).start)}`
                : ""}
              。未返回可用轨迹的活动不参与比较。
            </p>
            <p>
              幅度是每段原始 X/Y/Z
              的最大值减最小值，不等同于人体步幅或身体垂直振幅。单位未另行标定。
            </p>
            <p>
              每侧不足 3 段不画趋势点或代表轨迹，统计表保留实际
              n。缺失数据不记为零。5 次滚动中位数要求 5
              次有效记录；近期/最早摘要要求至少 10 次，保证两组不重叠。
            </p>
            <p>
              三维线为接近对应 X/Y/Z
              幅度中位数的真实片段；灰色虚线是基准。片段按各轴相对偏差平方和最小选取。
            </p>
            <p>
              路面、坡度、装备和传感器佩戴仍可能影响比较。请结合各次活动的路面与装备记录判断；佩戴方向未验证。
            </p>
            <p>
              “导入 JSON”可一次选择多份原始 Footpath
              文件，追加到当前历史并去重。所有数据在本机处理；刷新后恢复内置历史，导出
              CSV 可保存当前结果。
            </p>
          </details>
        </section>
      </aside>
    </main>
  );
});
export default LongTerm;
