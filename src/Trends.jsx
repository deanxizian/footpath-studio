import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { FootpathScene } from "./scene";
import { COLORS, dateText, elapsed, footName, number } from "./model";
import {
  METRICS,
  MIN_SAMPLES,
  buildAnalysis,
  chartRows,
  comparisonData,
  csvExport,
  deriveRows,
  fmt,
  pct,
  percentChange,
} from "./trends.js";

function TrendTooltip({ active, payload, metric, relative, speedOnly }) {
  const point = payload?.find((entry) => entry.payload?.bin)?.payload;
  if (!active || !point) return null;
  const { bin } = point;
  return (
    <div className="trend-tooltip">
      <strong>{bin.rangeLabel}</strong>
      {speedOnly ? (
        <p>
          速度中位数 {fmt(bin.summary.speed.median, 3)} m/s ·{" "}
          {bin.summary.speed.n} 段
        </p>
      ) : (
        [1, 2].map((side) => {
          const s = bin.summary[side][metric.key];
          return (
            <div className={side === 1 ? "left-text" : "right-text"} key={side}>
              <p>
                {footName(side)}：{fmt(s.median, metric.digits)} {metric.unit}{" "}
                {relative && (
                  <b>（{pct(point[side === 1 ? "left" : "right"])}）</b>
                )}
              </p>
              <small>
                n = {s.n} · 25–75%：{fmt(s.q25, metric.digits)}–
                {fmt(s.q75, metric.digits)}
              </small>
            </div>
          );
        })
      )}
      {!speedOnly && <small>点击图上的点，查看对应时间段的轨迹</small>}
    </div>
  );
}

function TrendChart({
  analysis,
  selected,
  metric,
  relative,
  spread,
  onSelect,
  speedOnly = false,
}) {
  const rows = useMemo(
    () => chartRows(analysis, metric.key, relative),
    [analysis, metric.key, relative],
  );
  const total = analysis.duration;
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
  let low = values.length ? Math.min(...values) : 0,
    high = values.length ? Math.max(...values) : 1;
  if (!speedOnly && relative) {
    low = Math.min(0, low);
    high = Math.max(0, high);
  }
  const rough = (high - low || Math.abs(high) * 0.1 || 1) / (speedOnly ? 2 : 4);
  const base = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].find((n) => n * base >= rough) * base;
  const domain = [Math.floor(low / step) * step, Math.ceil(high / step) * step];
  if (domain[0] === domain[1]) {
    domain[0] -= step;
    domain[1] += step;
  }
  const yTicks = Array.from(
    { length: Math.round((domain[1] - domain[0]) / step) + 1 },
    (_, i) => domain[0] + i * step,
  );
  const axisDigits = Math.max(0, -Math.floor(Math.log10(step)));
  const ticks =
    total < 600
      ? [0, total / 2, total]
      : [
          0,
          ...Array.from(
            { length: Math.floor(total / 600) },
            (_, i) => (i + 1) * 600,
          ).filter((t) => total - t > 240),
          total,
        ];
  const selectPoint = (state) => {
    if (!state || state.activeLabel === undefined) return;
    const t = Number(state.activeLabel);
    if (!Number.isFinite(t)) return;
    const closest = rows.reduce((a, b) =>
      Math.abs(a.time - t) <= Math.abs(b.time - t) ? a : b,
    );
    onSelect(closest.id);
  };
  const dot = (side) => (props) => {
    if (!Number.isFinite(props.cy)) return null;
    const label = `${props.payload.bin.rangeLabel}，${footName(side)}，${relative ? pct(props.value) : `${fmt(props.value, metric.digits)} ${metric.unit}`}`;
    const common = {
      fill: side === 1 ? COLORS.left : COLORS.right,
      stroke: "#fff",
      strokeWidth: 1,
      tabIndex: 0,
      role: "button",
      "aria-label": label,
      onClick: (e) => {
        e.stopPropagation();
        onSelect(props.payload.id);
      },
      onKeyDown: (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(props.payload.id);
        }
      },
    };
    return side === 1 ? (
      <circle key={props.key} cx={props.cx} cy={props.cy} r={3.7} {...common} />
    ) : (
      <rect
        key={props.key}
        x={props.cx - 3.6}
        y={props.cy - 3.6}
        width={7.2}
        height={7.2}
        {...common}
      />
    );
  };
  const unit = speedOnly
    ? "速度 (m/s)"
    : relative
      ? "相对前程变化 (%)"
      : `${metric.label} (${metric.unit})`;
  return (
    <div
      className={`trend-chart ${speedOnly ? "speed-chart" : ""}`}
      data-testid={speedOnly ? "speed-chart" : "trend-chart"}
    >
      <div className="chart-unit">{unit}</div>
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
          margin={{ top: speedOnly ? 27 : 38, right: 24, bottom: 0, left: 0 }}
          onClick={selectPoint}
          accessibilityLayer
        >
          <CartesianGrid vertical={false} stroke="#e1e7ed" />
          <XAxis
            dataKey="time"
            type="number"
            domain={[0, Math.max(1, total)]}
            ticks={ticks}
            tickFormatter={(t) =>
              total < 600 ? elapsed(t) : fmt(t / 60, t === total ? 1 : 0)
            }
            stroke="#8c9aa9"
            tickLine={false}
            tick={{ fontSize: 12 }}
            height={30}
            interval="preserveStartEnd"
            minTickGap={32}
          />
          <YAxis
            domain={domain}
            ticks={yTicks}
            tickFormatter={(value) => fmt(value, axisDigits)}
            width={60}
            axisLine={false}
            tickLine={false}
            tick={{ fill: "#6c7c8e", fontSize: 12 }}
          />
          {analysis.gaps.map((gap, index) => (
            <ReferenceArea
              key={index}
              x1={gap.start}
              x2={gap.end}
              fill="#b4bfca"
              fillOpacity={0.2}
              stroke="none"
            />
          ))}
          <ReferenceArea
            x1={selected.start}
            x2={selected.end}
            fill="#138b82"
            fillOpacity={0.035}
            stroke="none"
          />
          {!speedOnly && relative && (
            <ReferenceLine y={0} stroke="#8494a6" strokeDasharray="4 4" />
          )}
          <Tooltip
            content={
              <TrendTooltip
                metric={metric}
                relative={relative}
                speedOnly={speedOnly}
              />
            }
            cursor={{ stroke: "#9eacba", strokeDasharray: "3 3" }}
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
                fillOpacity={0.1}
                stroke="none"
                connectNulls={false}
                isAnimationActive={false}
                tooltipType="none"
              />
            ))}
          {speedOnly ? (
            <Line
              type="linear"
              dataKey="speed"
              stroke="#657b93"
              strokeWidth={1.7}
              dot={{ r: 2 }}
              activeDot={{ r: 4 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          ) : (
            [1, 2].map((side) => (
              <Line
                key={side}
                type="linear"
                dataKey={side === 1 ? "left" : "right"}
                name={footName(side)}
                stroke={side === 1 ? COLORS.left : COLORS.right}
                strokeWidth={2}
                strokeDasharray={side === 2 ? "6 4" : undefined}
                dot={dot(side)}
                activeDot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ShapeComparison({
  comparisons,
  title = "分段轨迹对比",
  currentLabel = "当前",
  baselineLabel = "基线",
  actions,
  onInspect,
}) {
  const [camera, setCamera] = useState("3d");
  const [error, setError] = useState(null);
  const hosts = useRef({});
  const scenes = useRef({});
  const activeSide = useRef(null);
  useEffect(() => {
    try {
      for (const side of [1, 2]) {
        const scene = new FootpathScene(hosts.current[side], () => {
          activeSide.current = side;
          setCamera("free");
        });
        scenes.current[side] = scene;
        scene.controls.addEventListener("change", () => {
          if (activeSide.current === side)
            scenes.current[side === 1 ? 2 : 1]?.copyCamera(scene);
        });
      }
    } catch (e) {
      setError(`三维视图暂不可用：${e.message}`);
    }
    return () => {
      for (const scene of Object.values(scenes.current)) scene.dispose();
      scenes.current = {};
    };
  }, []);
  useEffect(() => {
    activeSide.current = null;
    for (const side of [1, 2]) {
      const scene = scenes.current[side],
        comp = comparisons[side];
      if (!scene) continue;
      scene.setData(comp, false);
      scene.setSelected(comp.segments.map((_, i) => i));
      scene.setDisplay({ 1: true, 2: true }, "single", 0);
      scene.setView(camera === "free" ? "3d" : camera);
    }
    if (camera === "free") setCamera("3d");
  }, [comparisons]);
  function changeView(value) {
    activeSide.current = null;
    setCamera(value);
    for (const scene of Object.values(scenes.current)) scene.setView(value);
  }
  return (
    <section className="shape-comparison" aria-label={title}>
      <div className="comparison-heading">
        <h2>{title}</h2>
        <div className="comparison-actions">
          {actions}
          <div className="compact-buttons views" aria-label="对比视角">
            {[
              ["3d", "3D"],
              ["side", "侧视"],
              ["top", "俯视"],
            ].map(([value, label]) => (
              <button
                key={value}
                aria-pressed={camera === value}
                onClick={() => changeView(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="comparison-canvases">
        {[1, 2].map((side) => {
          const comp = comparisons[side];
          return (
            <figure
              key={side}
              className="comparison-foot"
              data-testid={`comparison-${side}`}
              data-baseline-index={comp.baselineIndex ?? ""}
              data-current-index={comp.currentIndex ?? ""}
            >
              <div className="comparison-caption">
                <strong>{footName(side)}</strong>
                <span className={side === 1 ? "left-text" : "right-text"}>
                  — {currentLabel}{" "}
                  <span className="baseline-legend">┄ {baselineLabel}</span>
                </span>
              </div>
              <div
                className="comparison-host"
                ref={(element) => {
                  hosts.current[side] = element;
                }}
              />
              {(comp.currentIndex === null ||
                comp.baselineIndex === null ||
                error) && (
                <div className="comparison-empty">
                  {error ??
                    `样本不足 ${MIN_SAMPLES} 段，${comp.currentIndex === null ? "当前" : "基线"}无代表轨迹`}
                </div>
              )}
              <figcaption>
                {comp.currentIndex !== null ? (
                  <button onClick={() => onInspect(comp.currentIndex)}>
                    查看原始片段 #{comp.currentIndex + 1} ↗
                  </button>
                ) : (
                  <span>当前无可比片段</span>
                )}
                {comp.baselineIndex !== null && (
                  <span>基线 #{comp.baselineIndex + 1}</span>
                )}
              </figcaption>
            </figure>
          );
        })}
      </div>
      <p className="comparison-note">
        真实代表片段 · 原始坐标单位 · 三轴等比例 · 拖动或缩放时视角同步
      </p>
    </section>
  );
}

function Comparison({ data, analysis, selected, onSelect, onInspect }) {
  const comparisons = useMemo(
    () => ({
      1: comparisonData(data, analysis.thirds[0].rows, selected.rows, 1),
      2: comparisonData(data, analysis.thirds[0].rows, selected.rows, 2),
    }),
    [data, analysis, selected],
  );
  return (
    <ShapeComparison
      comparisons={comparisons}
      currentLabel={selected.label.includes("程") ? selected.label : "选段"}
      baselineLabel="前程基线"
      onInspect={onInspect}
      actions={
        <div className="compact-buttons" aria-label="选择跑步阶段">
          {analysis.thirds.map((period) => (
            <button
              key={period.id}
              aria-pressed={selected.id === period.id}
              onClick={() => onSelect(period.id)}
            >
              {period.label}
            </button>
          ))}
        </div>
      }
    />
  );
}

function DeltaTable({ analysis, metricKey, setMetricKey }) {
  const before = analysis.thirds[0],
    after = analysis.thirds[2];
  return (
    <section className="delta-section">
      <h2>后程 vs 前程</h2>
      <p className="section-subtitle">相同筛选范围 · 各阶段片段中位数</p>
      <table className="delta-table" data-testid="delta-table">
        <thead>
          <tr>
            <th>指标</th>
            <th>左脚</th>
            <th>右脚</th>
          </tr>
        </thead>
        <tbody>
          {METRICS.map((metric) => (
            <tr
              key={metric.key}
              className={metricKey === metric.key ? "current-metric" : ""}
            >
              <th>
                <button
                  aria-label={`查看${metric.label}趋势`}
                  onClick={() => setMetricKey(metric.key)}
                >
                  {metric.label}
                </button>
              </th>
              {[1, 2].map((side) => {
                const a = before.summary[side][metric.key],
                  b = after.summary[side][metric.key];
                const change =
                  a.n >= MIN_SAMPLES && b.n >= MIN_SAMPLES
                    ? percentChange(b.median, a.median)
                    : null;
                return (
                  <td
                    key={side}
                    className={side === 1 ? "left-text" : "right-text"}
                  >
                    <strong>{pct(change)}</strong>
                    <small>
                      {fmt(a.median, metric.digits)} →{" "}
                      {fmt(b.median, metric.digits)}
                    </small>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="table-footnote">
        前程 {before.rangeLabel} · 后程 {after.rangeLabel}
        <br />
        片段数（左 / 右）：{before.summary[1].n} / {before.summary[2].n} →{" "}
        {after.summary[1].n} / {after.summary[2].n}
        <br />
        X/Y/Z 沿用原始单位；触地与周期为 ms。
      </p>
    </section>
  );
}

const Trends = forwardRef(function Trends(
  { data, onInspect, settings, setSettings },
  ref,
) {
  const { matched, minutes, metricKey, selectedId, relative, spread } =
    settings;
  const change = (key, value) =>
    setSettings((previous) => ({ ...previous, [key]: value }));
  const setMatched = (value) => change("matched", value),
    setMinutes = (value) => change("minutes", value);
  const setMetricKey = (value) => change("metricKey", value),
    setSelectedId = (value) => change("selectedId", value);
  const setRelative = (value) => change("relative", value),
    setSpread = (value) => change("spread", value);
  const rows = useMemo(() => deriveRows(data), [data]);
  const analysis = useMemo(
    () => buildAnalysis(data, rows, { matched, minutes }),
    [data, rows, matched, minutes],
  );
  const selected =
    [...analysis.thirds, ...analysis.bins].find(
      (bin) => bin.id === selectedId,
    ) ?? analysis.thirds[2];
  const metric = METRICS.find((m) => m.key === metricKey);
  useImperativeHandle(
    ref,
    () => ({ exportCsv: () => csvExport(data, analysis) }),
    [data, analysis],
  );
  const unavailable = matched && analysis.range.center === null;
  return (
    <main
      className="trend-workspace"
      data-testid="trend-workspace"
      data-eligible-count={analysis.eligible.length}
      data-filter={matched ? "speed-matched" : "all"}
    >
      <div className="trend-main">
        <div className="trend-heading">
          <div>
            <h2>本次跑步的变化趋势</h2>
            <p>
              {dateText(data.start)} · {elapsed(analysis.duration)} 轨迹覆盖 ·{" "}
              {number(data.segments.length)} 个片段
            </p>
          </div>
          <div className="trend-filters">
            <select
              aria-label="趋势分段时长"
              value={minutes}
              onChange={(e) => {
                setMinutes(Number(e.target.value));
                setSelectedId("third-2");
              }}
            >
              {[1, 2, 5, 10].map((n) => (
                <option key={n} value={n}>
                  {n} 分钟
                </option>
              ))}
            </select>
            <label
              className="plain-check"
              title="只保留本次中位速度 ±5% 的片段"
            >
              <input
                type="checkbox"
                checked={matched}
                onChange={(e) => setMatched(e.target.checked)}
              />
              相近速度
            </label>
          </div>
        </div>
        <div className="metric-buttons" role="group" aria-label="趋势指标">
          {METRICS.map((m) => (
            <button
              key={m.key}
              aria-pressed={metricKey === m.key}
              onClick={() => setMetricKey(m.key)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <div className="chart-options">
          <span>
            分段中位数 ·{" "}
            {relative ? "左右脚分别以各自前程为基线" : "显示各指标原始数值"}
          </span>
          <div>
            <label className="plain-check">
              <input
                type="checkbox"
                checked={relative}
                onChange={(e) => setRelative(e.target.checked)}
              />
              相对变化
            </label>
            <label className="plain-check">
              <input
                type="checkbox"
                checked={spread}
                onChange={(e) => setSpread(e.target.checked)}
              />
              25–75% 范围
            </label>
          </div>
        </div>
        {unavailable && (
          <p role="status" className="empty-analysis">
            该文件缺少有效速度，请取消“相近速度”查看全部片段。
          </p>
        )}
        <TrendChart
          analysis={analysis}
          selected={selected}
          metric={metric}
          relative={relative}
          spread={spread}
          onSelect={setSelectedId}
        />
        <p className="chart-axis-label">
          时间（{analysis.duration < 600 ? "分:秒" : "分钟"}） ·
          点击数据点可联动轨迹
        </p>
        <TrendChart
          analysis={analysis}
          selected={selected}
          metric={metric}
          relative={relative}
          onSelect={setSelectedId}
          speedOnly
        />
        <div className="chart-footnote">
          <span>
            <i className="gap-key" />
            灰带：超过 15 秒无轨迹片段
          </span>
          <span>
            {matched
              ? `${fmt(analysis.range.min, 3)}–${fmt(analysis.range.max, 3)} m/s · ${analysis.eligible.length} 段`
              : `全部 ${rows.length} 段`}{" "}
            · 连线仅引导阅读
          </span>
        </div>
        <Comparison
          data={data}
          analysis={analysis}
          selected={selected}
          onSelect={setSelectedId}
          onInspect={onInspect}
        />
        <details className="trend-source-data">
          <summary>查看趋势统计数据</summary>
          <div className="source-table-wrap">
            <table>
              <caption>
                {metric.label} · {minutes} 分钟一段 · 数值沿用 {metric.unit}
              </caption>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>左脚中位数</th>
                  <th>左 n</th>
                  <th>右脚中位数</th>
                  <th>右 n</th>
                  <th>速度 m/s</th>
                </tr>
              </thead>
              <tbody>
                {analysis.bins.map((bin) => (
                  <tr key={bin.id}>
                    <th>{bin.rangeLabel}</th>
                    <td>
                      {fmt(bin.summary[1][metricKey].median, metric.digits)}
                    </td>
                    <td>{bin.summary[1][metricKey].n}</td>
                    <td>
                      {fmt(bin.summary[2][metricKey].median, metric.digits)}
                    </td>
                    <td>{bin.summary[2][metricKey].n}</td>
                    <td>{fmt(bin.summary.speed.median, 3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>
      <aside className="trend-rail" aria-label="阶段变化与比较说明">
        <DeltaTable
          analysis={analysis}
          metricKey={metricKey}
          setMetricKey={setMetricKey}
        />
        <section className="selected-window">
          <h2>当前时间段</h2>
          <select
            aria-label="当前时间段"
            value={selected.id}
            onChange={(e) => setSelectedId(e.target.value)}
          >
            <optgroup label="按总时长三等分">
              {analysis.thirds.map((bin) => (
                <option key={bin.id} value={bin.id}>
                  {bin.label}（{bin.rangeLabel}）
                </option>
              ))}
            </optgroup>
            <optgroup label={`${minutes} 分钟片段`}>
              {analysis.bins.map((bin) => (
                <option key={bin.id} value={bin.id}>
                  {bin.label}
                </option>
              ))}
            </optgroup>
          </select>
          <dl className="metric-list" data-testid="window-details">
            <div>
              <dt>片段数（左脚）</dt>
              <dd>{selected.summary[1].n}</dd>
            </div>
            <div>
              <dt>片段数（右脚）</dt>
              <dd>{selected.summary[2].n}</dd>
            </div>
            <div>
              <dt>中位速度</dt>
              <dd>
                {fmt(selected.summary.speed.median, 3)} <span>m/s</span>
              </dd>
            </div>
            <div>
              <dt>{metric.label} · 左</dt>
              <dd>
                {fmt(selected.summary[1][metricKey].median, metric.digits)}
              </dd>
            </div>
            <div>
              <dt>{metric.label} · 右</dt>
              <dd>
                {fmt(selected.summary[2][metricKey].median, metric.digits)}
              </dd>
            </div>
          </dl>
        </section>
        <section className="trend-explanation">
          <h2>比较说明</h2>
          <p>
            {matched ? (
              <>
                速度范围固定为{" "}
                <strong>
                  {fmt(analysis.range.min, 3)}–{fmt(analysis.range.max, 3)} m/s
                </strong>
                （本次中位速度 ±5%），保留 {analysis.eligible.length} /{" "}
                {rows.length} 段。
              </>
            ) : (
              <>当前保留全部 {rows.length} 个片段，包含速度较低的片段。</>
            )}
          </p>
          <p>
            前、中、后程按轨迹起止时间三等分。变化率 =（后程中位数 ÷ 前程中位数
            − 1）× 100%。
          </p>
          <p>
            X/Y/Z 幅度 = 每段对应坐标的最大值 −
            最小值，单位未另行标定。它们不等同于步幅或身体垂直振幅。
          </p>
          <details>
            <summary>数据与方法细节</summary>
            <p>
              轨迹为抽样片段。{analysis.gaps.length} 处记录间隔超过 15 秒，最长{" "}
              {fmt(Math.max(0, ...analysis.gaps.map((g) => g.seconds)), 1)}{" "}
              秒；仅凭间隔不能判断是否暂停。
            </p>
            <p>
              每侧不足 {MIN_SAMPLES}{" "}
              段时不画趋势或代表轨迹；缺失值不记为零。25–75%
              范围反映片段分布，不是置信区间。
            </p>
            <p>
              代表轨迹选用最接近该段 X/Y/Z
              幅度中位数的真实片段，按各轴相对偏差平方和最小选取，不是平均轨迹。
            </p>
            <p>
              速度筛选只能缩小速度差异；路面、坡度和设备佩戴仍可能影响比较。数值增减本身没有“好坏”评级。
            </p>
            <p>
              本页显示这次跑步内部的变化；跨日期比较请使用“长期趋势”。导入文件与所有计算都在浏览器本地完成。
            </p>
          </details>
        </section>
      </aside>
    </main>
  );
});
export default Trends;
