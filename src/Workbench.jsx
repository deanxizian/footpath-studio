import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { FootpathScene } from "./scene.js";
import { dateText, clockTime, number } from "./model.js";
import { METRICS, MIN_SAMPLES, fmt, pct, percentChange } from "./trends.js";
import {
  analyzeHistory,
  historyCsv,
  loadRunData,
  longitudinalRows,
} from "./history-model.js";
import { HistoryChart } from "./LongTerm.jsx";
import {
  buildComparison,
  durationLabel,
  searchRuns,
} from "./workbench-model.js";

const surfaceLabel = (value) =>
  ({
    road: "公路",
    track: "跑道",
    treadmill: "跑步机",
    trail: "越野",
    unknown: "未记录",
  })[value] ??
  (value || "未记录");
const displayMetrics = [
  "xSpan",
  "ySpan",
  "zSpan",
  "groundContactTime",
  "strideTime",
].map((key) => METRICS.find((m) => m.key === key));
const metricLabel = (metric) => metric.label.replace(" 轴", "");

function RunCard({ run, role, visible, onVisibility, onChoose }) {
  const title = role === "current" ? "当前跑步" : "基准跑步";
  return (
    <section className={`analysis-run-card ${role}`} aria-label={title}>
      <div className="analysis-run-card-top">
        <label>
          <input
            type="checkbox"
            aria-label={`显示${title}轨迹`}
            checked={visible}
            onChange={(e) => onVisibility(e.target.checked)}
          />
          {title}
        </label>
        <button onClick={onChoose} aria-label={`更换${title}`}>
          更换活动
        </button>
      </div>
      <time dateTime={new Date(run.start * 1000).toISOString()}>
        {dateText(run.start)} {clockTime(run.start).slice(0, 5)}
      </time>
      <p className="analysis-run-name">{run.activity?.name ?? run.title}</p>
      <p className="analysis-run-meta">
        {Number.isFinite(run.activity?.distance)
          ? `${(run.activity.distance / 1000).toFixed(2)} km`
          : "未记录距离"}{" "}
        · {durationLabel(run.activity?.moving_time)}
      </p>
      <div className={`run-line-legend ${role}`}>
        <i />
        {role === "current" ? "实线 · 当前跑步" : "虚线 · 基准跑步"}
      </div>
    </section>
  );
}

function RunPicker({ runs, role, selectedId, onSelect, onClose }) {
  const dialog = useRef(null);
  const search = useRef(null);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(40);
  const filtered = useMemo(() => searchRuns(runs, query), [runs, query]);
  useEffect(() => {
    dialog.current.showModal();
    search.current.focus();
    return () => dialog.current?.close();
  }, []);
  const close = () => {
    dialog.current.close();
    onClose();
  };
  return (
    <dialog
      ref={dialog}
      className="run-picker"
      aria-labelledby="run-picker-title"
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="run-picker-inner">
        <header>
          <div>
            <h2 id="run-picker-title">
              选择{role === "current" ? "当前" : "基准"}跑步
            </h2>
            <p>已载入 {runs.length} 次可选活动</p>
          </div>
          <button onClick={close}>关闭</button>
        </header>
        <label className="run-search-label" htmlFor="run-search">
          搜索日期或活动名称
        </label>
        <input
          id="run-search"
          ref={search}
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setLimit(40);
          }}
          placeholder="例如 2026/09/15 或 Tempo"
        />
        <div className="run-picker-results" aria-label="可选跑步">
          {filtered.slice(0, limit).map((run) => (
            <button
              key={run.id}
              className={run.id === selectedId ? "selected" : ""}
              aria-pressed={run.id === selectedId}
              onClick={() => {
                dialog.current.close();
                onSelect(run.id);
              }}
            >
              <span>
                <time>
                  {dateText(run.start)}{" "}
                  <small>{clockTime(run.start).slice(0, 5)}</small>
                </time>
                <strong>{run.activity?.name ?? run.title}</strong>
              </span>
              <span className="run-picker-meta">
                {Number.isFinite(run.activity?.distance)
                  ? `${(run.activity.distance / 1000).toFixed(2)} km`
                  : "—"}
                <small>{number(run.rows.length)} 个片段</small>
              </span>
            </button>
          ))}
          {!filtered.length && (
            <p role="status" className="picker-empty">
              没有匹配的活动，试试其他日期或名称。
            </p>
          )}
        </div>
        <footer>
          <span>{filtered.length} 次匹配</span>
          {limit < filtered.length && (
            <button onClick={() => setLimit((n) => n + 40)}>显示更多</button>
          )}
        </footer>
      </div>
    </dialog>
  );
}

function ComparisonCanvas({ data, mirror, left, right, camera, onFreeView }) {
  const host = useRef(null);
  const scene = useRef(null);
  const [error, setError] = useState("");
  useEffect(() => {
    try {
      scene.current = new FootpathScene(host.current, onFreeView);
    } catch {
      setError("三维视图未能启动，请使用支持 WebGL 2 的浏览器。");
    }
    return () => {
      scene.current?.dispose();
      scene.current = null;
    };
  }, []);
  useEffect(() => {
    if (!scene.current) return;
    scene.current.setData(data, mirror);
    scene.current.setSelected(data.segments.map((_, index) => index));
  }, [data, mirror]);
  useEffect(() => {
    scene.current?.setDisplay({ 1: left, 2: right }, "single", 0);
  }, [data, mirror, left, right]);
  useEffect(() => {
    if (camera.name !== "free") scene.current?.setView(camera.name);
  }, [camera]);
  return (
    <div
      className="analysis-canvas"
      ref={host}
      data-testid="analysis-canvas"
      data-current-fragments={
        data.segments.filter((s) => s.comparisonRole === "current").length
      }
      data-baseline-fragments={
        data.segments.filter((s) => s.comparisonRole === "baseline").length
      }
      data-view={camera.name}
      data-mirror={mirror}
      data-left={left}
      data-right={right}
    >
      {error && (
        <p className="analysis-plot-message" role="alert">
          {error}
        </p>
      )}
      {!left && !right && (
        <p className="analysis-plot-message" role="status">
          开启左脚或右脚以显示轨迹
        </p>
      )}
    </div>
  );
}

function ComparisonTable({ baseline, selected, metricKey, onMetric }) {
  return (
    <section className="analysis-summary-section">
      <h2>当前 vs 基准</h2>
      <table className="analysis-delta-table" data-testid="analysis-delta">
        <thead>
          <tr>
            <th>指标</th>
            <th>左脚</th>
            <th>右脚</th>
          </tr>
        </thead>
        <tbody>
          {displayMetrics.map((metric) => (
            <tr
              key={metric.key}
              className={metricKey === metric.key ? "active" : ""}
            >
              <th>
                <button
                  aria-pressed={metricKey === metric.key}
                  onClick={() => onMetric(metric.key)}
                >
                  {metricLabel(metric)}
                </button>
              </th>
              {[1, 2].map((side) => {
                const before = baseline.summary[side][metric.key],
                  after = selected.summary[side][metric.key];
                const change =
                  before.n >= MIN_SAMPLES && after.n >= MIN_SAMPLES
                    ? percentChange(after.median, before.median)
                    : null;
                return (
                  <td
                    key={side}
                    className={side === 1 ? "left-text" : "right-text"}
                    title={`${fmt(before.median, metric.digits)} → ${fmt(after.median, metric.digits)} ${metric.unit}`}
                  >
                    {pct(change)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="analysis-small-print">各侧片段中位数的变化率</p>
    </section>
  );
}

const Workbench = forwardRef(function Workbench(
  { runs, settings, setSettings, selectedId, setSelectedId, onOpen },
  ref,
) {
  const { target, matched, metricKey, baselineId, days, surface } = settings;
  const analysis = useMemo(
    () => analyzeHistory(runs, { target, matched, days, surface }),
    [runs, target, matched, days, surface],
  );
  const baseline = analysis.find((run) => run.id === baselineId) ?? analysis[0];
  const selected =
    analysis.find((run) => run.id === selectedId) ?? analysis.at(-1);
  const metric = METRICS.find((value) => value.key === metricKey);
  const rows = useMemo(
    () => longitudinalRows(analysis, baseline, metricKey, true),
    [analysis, baseline, metricKey],
  );
  const [picker, setPicker] = useState(null);
  const [loaded, setLoaded] = useState(null);
  const [error, setError] = useState("");
  const [showCurrent, setShowCurrent] = useState(true);
  const [showBaseline, setShowBaseline] = useState(true);
  const [left, setLeft] = useState(true),
    [right, setRight] = useState(true);
  const [mirror, setMirror] = useState(false);
  const [camera, setCamera] = useState({ name: "3d", revision: 0 });
  const change = (key, value) =>
    setSettings((previous) => ({ ...previous, [key]: value }));
  const key = selected && baseline ? `${selected.id}:${baseline.id}` : "";
  const onFreeView = useCallback(
    () => setCamera((previous) => ({ ...previous, name: "free" })),
    [],
  );
  useImperativeHandle(
    ref,
    () => ({ exportCsv: () => historyCsv(analysis, baseline) }),
    [analysis, baseline],
  );
  useEffect(() => {
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected?.id, selectedId]);
  useEffect(() => {
    let active = true;
    setError("");
    if (key)
      Promise.all([loadRunData(selected), loadRunData(baseline)])
        .then(([current, before]) => {
          if (active) setLoaded({ key, current, before });
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [key]);
  const comparison = useMemo(() => {
    if (!key || loaded?.key !== key) return null;
    const value = buildComparison(
      loaded.current,
      loaded.before,
      selected.eligible,
      baseline.eligible,
    );
    const segments = value.segments.filter((segment) =>
      segment.comparisonRole === "current" ? showCurrent : showBaseline,
    );
    return {
      ...value,
      segments,
      pointCount: segments.reduce((n, s) => n + s.points.length, 0),
    };
  }, [loaded, key, selected, baseline, showCurrent, showBaseline]);
  const range = `${fmt(target * 0.95, 2)}–${fmt(target * 1.05, 2)} m/s`;
  const comparable = rows.filter(
    (row) => Number.isFinite(row.left) || Number.isFinite(row.right),
  ).length;
  return (
    <main
      className="analysis-workbench"
      data-testid="analysis-workbench"
      data-run-count={analysis.length}
      data-current={selected?.id}
      data-baseline={baseline?.id}
    >
      <div className="analysis-heading">
        <h2>Footpath 分析</h2>
        <p>
          {number(runs.length)} 次跑步 · {dateText(runs[0].start)}—
          {dateText(runs.at(-1).start)}
        </p>
      </div>
      <div className="analysis-layout">
        <aside className="analysis-activities" aria-label="对比活动">
          <h2>对比活动</h2>
          {selected && baseline && (
            <>
              <RunCard
                role="current"
                run={selected}
                visible={showCurrent}
                onVisibility={setShowCurrent}
                onChoose={() => setPicker("current")}
              />
              <RunCard
                role="baseline"
                run={baseline}
                visible={showBaseline}
                onVisibility={setShowBaseline}
                onChoose={() => setPicker("baseline")}
              />
              <button
                className="swap-runs"
                onClick={() => {
                  change("baselineId", selected.id);
                  setSelectedId(baseline.id);
                }}
              >
                交换当前与基准
              </button>
            </>
          )}
          <section className="analysis-filters">
            <label className="analysis-check">
              <input
                type="checkbox"
                checked={matched}
                onChange={(e) => change("matched", e.target.checked)}
              />
              固定速度范围
            </label>
            <select
              aria-label="分析目标速度"
              disabled={!matched}
              value={target.toFixed(2)}
              onChange={(e) => change("target", Number(e.target.value))}
            >
              {Array.from({ length: 71 }, (_, i) =>
                (2 + i * 0.05).toFixed(2),
              ).map((value) => (
                <option value={value} key={value}>
                  {value} m/s ±5%
                </option>
              ))}
            </select>
            <p className="analysis-filter-note">
              {matched ? (
                <>
                  相同速度下比较跑姿
                  <br />
                  <span>{range}</span>
                </>
              ) : (
                "全部速度 · 速度差异可能影响形状"
              )}
            </p>
            <label htmlFor="analysis-surface">路面</label>
            <select
              id="analysis-surface"
              value={surface}
              onChange={(e) => change("surface", e.target.value)}
            >
              <option value="all">所有路面</option>
              {[
                ...new Set(
                  runs.map((run) => run.activity?.surface_type || "unknown"),
                ),
              ].map((value) => (
                <option key={value} value={value}>
                  {surfaceLabel(value)}
                </option>
              ))}
            </select>
          </section>
          {selected && (
            <button
              className="analysis-open-run"
              onClick={() => onOpen(selected, "trends")}
            >
              查看单次分析 <span aria-hidden="true">→</span>
            </button>
          )}
        </aside>
        <div className="analysis-center">
          <section
            className="analysis-plot-panel"
            aria-label="跨次三维轨迹对比"
          >
            <div className="analysis-plot-toolbar">
              <h2>三维轨迹对比</h2>
              <div className="analysis-plot-controls">
                <label className="analysis-check left-check">
                  <input
                    type="checkbox"
                    checked={left}
                    onChange={(e) => setLeft(e.target.checked)}
                  />
                  左脚
                </label>
                <label className="analysis-check right-check">
                  <input
                    type="checkbox"
                    checked={right}
                    onChange={(e) => setRight(e.target.checked)}
                  />
                  右脚
                </label>
                <label className="analysis-check">
                  <input
                    type="checkbox"
                    checked={mirror}
                    onChange={(e) => {
                      setMirror(e.target.checked);
                      setCamera((previous) => ({
                        name: "3d",
                        revision: previous.revision + 1,
                      }));
                    }}
                  />
                  镜像对齐
                </label>
                <div
                  className="analysis-views"
                  role="group"
                  aria-label="对比视角"
                >
                  {[
                    ["3d", "3D"],
                    ["side", "侧视"],
                    ["back", "后视"],
                    ["top", "俯视"],
                  ].map(([name, label]) => (
                    <button
                      key={name}
                      aria-pressed={camera.name === name}
                      onClick={() =>
                        setCamera((previous) => ({
                          name,
                          revision: previous.revision + 1,
                        }))
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            {error ? (
              <div className="analysis-canvas-message" role="alert">
                轨迹读取失败：{error}
              </div>
            ) : !key ? (
              <div className="analysis-canvas-message" role="status">
                没有符合条件的跑步，请调整筛选。
              </div>
            ) : !comparison ? (
              <div className="analysis-canvas-message" role="status">
                正在读取三维轨迹…
              </div>
            ) : !comparison.segments.length ? (
              <div className="analysis-canvas-message" role="status">
                {!showCurrent && !showBaseline
                  ? "开启当前或基准跑步以显示轨迹"
                  : "当前速度范围内片段不足，请调整速度筛选。"}
              </div>
            ) : (
              <ComparisonCanvas
                data={comparison}
                mirror={mirror}
                left={left}
                right={right}
                camera={camera}
                onFreeView={onFreeView}
              />
            )}
            <footer className="analysis-plot-footer">
              <span>
                <i className="legend-solid" />
                实线 当前 <i className="legend-dashed" />
                虚线 基准
              </span>
              <span>代表片段 · 拖动旋转 · 滚轮缩放</span>
            </footer>
          </section>
          <section className="analysis-history" aria-label="长期变化">
            <div className="analysis-history-heading">
              <h2>长期变化</h2>
              <div
                className="analysis-metric-tabs"
                role="group"
                aria-label="对比趋势指标"
              >
                {displayMetrics.map((value) => (
                  <button
                    key={value.key}
                    aria-pressed={metricKey === value.key}
                    onClick={() => change("metricKey", value.key)}
                  >
                    {metricLabel(value)}
                  </button>
                ))}
              </div>
              <select
                aria-label="分析日期范围"
                value={days}
                onChange={(e) => change("days", Number(e.target.value))}
              >
                <option value={0}>全部日期</option>
                <option value={60}>最近 60 天</option>
                <option value={30}>最近 30 天</option>
              </select>
            </div>
            {analysis.length ? (
              <HistoryChart
                rows={rows}
                baseline={baseline}
                selected={selected}
                metric={metric}
                relative={true}
                spread={false}
                rolling={true}
                onSelect={setSelectedId}
              />
            ) : (
              <p className="analysis-canvas-message">当前筛选没有可用数据</p>
            )}
            <div className="analysis-history-footer">
              <span>点击日期点选择跑步 · 5 次滚动中位数</span>
              <span>
                可比 {comparable} / {analysis.length} 次
              </span>
            </div>
          </section>
        </div>
        <aside className="analysis-inspector" aria-label="对比结果">
          {baseline && selected && (
            <>
              <ComparisonTable
                baseline={baseline}
                selected={selected}
                metricKey={metricKey}
                onMetric={(value) => change("metricKey", value)}
              />
              <section className="analysis-samples">
                <h2>样本与条件</h2>
                <table data-testid="analysis-samples">
                  <thead>
                    <tr>
                      <th>条件</th>
                      <th>当前</th>
                      <th>基准</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th>左脚片段</th>
                      <td>{selected.summary[1].n}</td>
                      <td>{baseline.summary[1].n}</td>
                    </tr>
                    <tr>
                      <th>右脚片段</th>
                      <td>{selected.summary[2].n}</td>
                      <td>{baseline.summary[2].n}</td>
                    </tr>
                    <tr>
                      <th>保留比例</th>
                      <td>{fmt(selected.retained * 100, 0)}%</td>
                      <td>{fmt(baseline.retained * 100, 0)}%</td>
                    </tr>
                    <tr>
                      <th>速度中位数</th>
                      <td>{fmt(selected.summary.speed.median, 2)}</td>
                      <td>{fmt(baseline.summary.speed.median, 2)}</td>
                    </tr>
                    <tr>
                      <th>路面类型</th>
                      <td>{surfaceLabel(selected.activity?.surface_type)}</td>
                      <td>{surfaceLabel(baseline.activity?.surface_type)}</td>
                    </tr>
                  </tbody>
                </table>
                <p className="analysis-small-print">
                  速度单位 m/s · 每侧至少 {MIN_SAMPLES} 段
                </p>
              </section>
            </>
          )}
          <p className="analysis-interpretation">
            数值变化不代表好坏，结合跑步条件观察持续趋势。
          </p>
          <details className="analysis-notes">
            <summary>数据说明</summary>
            <p>
              三维图展示各侧最接近 X/Y/Z
              幅度中位数的真实片段，虚线表示基准跑步。可在“三维细节”查看当前活动的全部原始片段。
            </p>
            <p>
              X/Y/Z
              为原始坐标，未另行标定单位；幅度不等同于人体步幅或身体垂直振幅。三轴等比例绘制，镜像只翻转左脚
              Y 轴。
            </p>
            <p>
              趋势图为相对基准的变化百分比。每点为一次跑步，粗线为 5
              次有效跑步的滚动中位数。每侧少于 3
              段时不计算变化率，不把缺失值记为零。
            </p>
            <p>鞋、路面、坡度、速度以及传感器佩戴可能影响结果。</p>
          </details>
        </aside>
      </div>
      {picker && (
        <RunPicker
          runs={analysis}
          role={picker}
          selectedId={picker === "current" ? selected?.id : baseline?.id}
          onClose={() => setPicker(null)}
          onSelect={(id) => {
            if (picker === "current") setSelectedId(id);
            else change("baselineId", id);
            setPicker(null);
          }}
        />
      )}
    </main>
  );
});

export default Workbench;
