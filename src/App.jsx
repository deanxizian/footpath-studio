import React, {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { FootpathScene } from "./scene";
import {
  clockTime,
  dateText,
  elapsed,
  footName,
  metric,
  normalizeData,
  number,
  pairedIndices,
} from "./model";
import Trends from "./Trends.jsx";
import LongTerm from "./LongTerm.jsx";
import Workbench from "./Workbench.jsx";
import {
  defaultTarget,
  expandHistory,
  loadRunData,
  mergeRuns,
  signature,
} from "./history-model.js";
import { readRunFiles } from "./session.js";

const initialTrendSettings = {
  matched: true,
  minutes: 5,
  metricKey: "ySpan",
  selectedId: "third-2",
  relative: true,
  spread: false,
};

function Icon({ name, size = 20 }) {
  const shapes = {
    upload: (
      <>
        <path d="M12 16V3m-4 4 4-4 4 4" />
        <path d="M4 14v6h16v-6" />
      </>
    ),
    download: (
      <>
        <path d="M12 3v13m-4-4 4 4 4-4" />
        <path d="M4 17v4h16v-4" />
      </>
    ),
    reset: (
      <>
        <path d="M4 9a8 8 0 1 1 0 6" />
        <path d="M4 3v6h6" />
      </>
    ),
    play: <path d="m8 4 12 8-12 8Z" fill="currentColor" stroke="none" />,
    pause: (
      <>
        <path
          d="M7 5h3v14H7zM14 5h3v14h-3z"
          fill="currentColor"
          stroke="none"
        />
      </>
    ),
    previous: (
      <>
        <path d="M5 5v14" />
        <path d="m18 5-10 7 10 7Z" fill="currentColor" stroke="none" />
      </>
    ),
    next: (
      <>
        <path d="M19 5v14" />
        <path d="m6 5 10 7-10 7Z" fill="currentColor" stroke="none" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {shapes[name]}
    </svg>
  );
}

const Plot = memo(
  forwardRef(function Plot(
    {
      data,
      selected,
      mirror,
      left,
      right,
      mode,
      opacity,
      phase,
      cameraRequest,
      onFreeView,
      onError,
    },
    ref,
  ) {
    const host = useRef(null);
    const scene = useRef(null);
    useImperativeHandle(
      ref,
      () => ({ saveImage: (subtitle) => scene.current?.saveImage(subtitle) }),
      [],
    );
    useEffect(() => {
      try {
        scene.current = new FootpathScene(host.current, onFreeView);
      } catch (error) {
        onError(
          `三维视图未能启动：${error.message}。请使用支持 WebGL 2 的浏览器。`,
        );
      }
      return () => {
        scene.current?.dispose();
        scene.current = null;
      };
    }, []);
    useEffect(() => {
      scene.current?.setData(data, mirror);
    }, [data, mirror]);
    useEffect(() => {
      scene.current?.setSelected(selected);
    }, [data, selected, mirror]);
    useEffect(() => {
      scene.current?.setDisplay({ 1: left, 2: right }, mode, opacity);
    }, [data, left, right, mode, opacity, mirror]);
    useEffect(() => {
      scene.current?.setPhase(phase);
    }, [phase]);
    useEffect(() => {
      if (cameraRequest.name !== "free")
        scene.current?.setView(cameraRequest.name);
    }, [cameraRequest]);
    return (
      <div
        ref={host}
        className="plot-host"
        data-testid="plot"
        data-point-count={data.pointCount}
        data-segment-count={data.segments.length}
        data-mirror={mirror}
        data-mode={mode}
        data-left={left}
        data-right={right}
      />
    );
  }),
);

function Toggle({ checked, onChange, children, side, disabled = false }) {
  return (
    <label className={`toggle ${side ?? ""}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{children}</span>
    </label>
  );
}

const Inspector = memo(function Inspector({
  data,
  segment,
  left,
  right,
  mirror,
  mode,
  opacity,
  setLeft,
  setRight,
  setMirror,
  setMode,
  setOpacity,
}) {
  return (
    <aside className="inspector" aria-label="轨迹控制与片段信息">
      <section className="inspector-section controls-section">
        <h2>轨迹显示</h2>
        <div className="toggles">
          <Toggle
            checked={left}
            onChange={setLeft}
            side="left"
            disabled={!data.leftCount}
          >
            左脚
          </Toggle>
          <Toggle
            checked={right}
            onChange={setRight}
            side="right"
            disabled={!data.rightCount}
          >
            右脚
          </Toggle>
          <Toggle checked={mirror} onChange={setMirror}>
            左右镜像对齐
          </Toggle>
        </div>
        <div className="mode-switch" role="group" aria-label="显示模式">
          <button
            aria-pressed={mode === "overlay"}
            onClick={() => setMode("overlay")}
          >
            叠加
          </button>
          <button
            aria-pressed={mode === "single"}
            title="仅显示选中片段及邻近的另一只脚片段"
            onClick={() => setMode("single")}
          >
            单段
          </button>
        </div>
        <label className="opacity-row" htmlFor="opacity">
          <span>轨迹透明度</span>
          <output>{Math.round(opacity * 100)}%</output>
        </label>
        <input
          id="opacity"
          aria-label="轨迹透明度"
          type="range"
          min="1"
          max="35"
          value={Math.round(opacity * 100)}
          onChange={(e) => setOpacity(Number(e.target.value) / 100)}
          disabled={mode === "single"}
          style={{ "--progress": `${(opacity / 0.35) * 100}%` }}
        />
      </section>
      <section className="inspector-section">
        <h2>当前片段</h2>
        <dl className="metric-list">
          <div>
            <dt>片段</dt>
            <dd
              className={segment.side === 1 ? "left-text" : "right-text"}
              data-testid="selected-segment"
            >
              {number(segment.index + 1)}{" "}
              <span>· {footName(segment.side)}</span>
            </dd>
          </div>
          <div>
            <dt>时间</dt>
            <dd>{clockTime(segment.time)}</dd>
          </div>
          <div>
            <dt>速度</dt>
            <dd>{metric(segment.speed, "m/s", 2)}</dd>
          </div>
          <div>
            <dt>功率</dt>
            <dd>{metric(segment.power, "W")}</dd>
          </div>
          <div>
            <dt>触地时间</dt>
            <dd>{metric(segment.groundContactTime, "ms")}</dd>
          </div>
          <div>
            <dt>周期时间</dt>
            <dd>{metric(segment.strideTime, "ms")}</dd>
          </div>
        </dl>
      </section>
      <section className="inspector-section overview-section">
        <h2>数据概览</h2>
        <dl className="metric-list">
          <div>
            <dt>轨迹片段</dt>
            <dd>{number(data.segments.length)}</dd>
          </div>
          <div>
            <dt>坐标点</dt>
            <dd>{number(data.pointCount)}</dd>
          </div>
        </dl>
        <p className="foot-counts">
          <span className="left-text">左 {number(data.leftCount)}</span>
          <span className="right-text">右 {number(data.rightCount)}</span>
        </p>
      </section>
      <details className="data-notes">
        <summary>坐标与数据说明</summary>
        <div>
          <p>
            显示 positions 中的原始 X、Y、Z 数值，Z
            朝上，三轴使用相同比例。坐标单位沿用原始数据，此页面未另行标定。
          </p>
          <p>
            各片段独立绘制。深色曲线为当前片段，以及时间相差不超过 1.5
            秒的最近异侧片段。默认保留全部轨迹。
          </p>
          <p>镜像对齐只将左脚的 Y 取反，方便比较形状。</p>
          <p>
            播放按点序缓慢演示单个周期。两脚各自按 0–100%
            进度显示；时间戳仍属于各自片段。
          </p>
          <p>
            “打开 JSON”支持 Stryd 的 foot_data_list 格式，文件在浏览器本地读取。
          </p>
        </div>
      </details>
      <p className="inspector-footer">数据保留片段边界</p>
    </aside>
  );
});

function Timeline({
  data,
  index,
  navigation,
  phase,
  playing,
  setIndex,
  setPhase,
  setPlaying,
}) {
  const selected = data.segments[index];
  const ordinal = Math.max(0, navigation.indexOf(index));
  const progress = (ordinal / Math.max(1, navigation.length - 1)) * 100;
  return (
    <div className="timeline" aria-label="片段与周期浏览">
      <div className="transport">
        <button
          className="play-button"
          aria-label={playing ? "暂停周期播放" : "播放周期"}
          title="按点序慢速播放周期"
          onClick={() => setPlaying(!playing)}
        >
          <Icon name={playing ? "pause" : "play"} size={23} />
        </button>
        <button
          className="icon-button"
          aria-label="上一个片段"
          onClick={() => setIndex(navigation[ordinal - 1])}
          disabled={ordinal === 0}
        >
          <Icon name="previous" />
        </button>
        <button
          className="icon-button"
          aria-label="下一个片段"
          onClick={() => setIndex(navigation[ordinal + 1])}
          disabled={ordinal === navigation.length - 1}
        >
          <Icon name="next" />
        </button>
      </div>
      <div className="timeline-sliders">
        <div className="slider-row">
          <label htmlFor="segment-range">片段浏览</label>
          <input
            id="segment-range"
            aria-label="片段浏览"
            type="range"
            min="0"
            max={navigation.length - 1}
            value={ordinal}
            onChange={(e) => setIndex(navigation[Number(e.target.value)])}
            style={{ "--progress": `${progress}%` }}
          />
          <output>
            {number(index + 1)} / {number(data.segments.length)}
          </output>
        </div>
        <div className="time-ticks">
          <span>00:00</span>
          <span>{elapsed(selected.time - data.start)}</span>
          <span>{elapsed(data.end - data.start)}</span>
        </div>
        <div className="slider-row phase-row">
          <label htmlFor="phase-range">周期进度</label>
          <input
            id="phase-range"
            aria-label="周期进度"
            type="range"
            min="0"
            max="100"
            step="0.1"
            value={phase * 100}
            onChange={(e) => {
              setPlaying(false);
              setPhase(Number(e.target.value) / 100);
            }}
            style={{ "--progress": `${phase * 100}%` }}
          />
          <output>{Math.round(phase * 100)}%</output>
        </div>
      </div>
    </div>
  );
}

export default function App({
  history,
  initialData,
  source: initialSource = "archive",
  onReset,
}) {
  const [source, setSource] = useState(initialSource);
  const [data, setData] = useState(() => initialData);
  const [runs, setRuns] = useState(() => expandHistory(history));
  const [selectedRunId, setSelectedRunId] = useState(
    () => history.runs.at(-1).id,
  );
  const [historySettings, setHistorySettings] = useState(() => ({
    target: history.defaultSpeed,
    matched: true,
    metricKey: "ySpan",
    relative: true,
    spread: false,
    rolling: true,
    baselineId: (history.runs.at(-2) ?? history.runs[0]).id,
    days: 0,
    surface: "all",
  }));
  const [screen, setScreen] = useState("workbench");
  const [trendSettings, setTrendSettings] = useState(initialTrendSettings);
  const [index, setIndex] = useState(0);
  const [left, setLeft] = useState(true);
  const [right, setRight] = useState(true);
  const [mirror, setMirror] = useState(false);
  const [mode, setMode] = useState("overlay");
  const [opacity, setOpacity] = useState(0.08);
  const [phase, setPhase] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [cameraRequest, setCameraRequest] = useState({
    name: "3d",
    revision: 0,
  });
  const [notice, setNotice] = useState(null);
  const [importing, setImporting] = useState(false);
  const plot = useRef(null);
  const trends = useRef(null);
  const longterm = useRef(null);
  const workbench = useRef(null);
  const fileInput = useRef(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const selected = useMemo(() => pairedIndices(data, index), [data, index]);
  const navigation = useMemo(
    () =>
      data.segments
        .filter((s) => (!left && !right) || (s.side === 1 ? left : right))
        .map((s) => s.index),
    [data, left, right],
  );
  const segment = data.segments[index];

  function changeSide(side, checked) {
    const nextLeft = side === 1 ? checked : left;
    const nextRight = side === 2 ? checked : right;
    if (side === 1) setLeft(checked);
    else setRight(checked);
    if (
      (nextLeft || nextRight) &&
      !(segment.side === 1 ? nextLeft : nextRight)
    ) {
      let nearest = null;
      for (const s of data.segments) {
        if (!(s.side === 1 ? nextLeft : nextRight)) continue;
        if (
          !nearest ||
          Math.abs(s.time - segment.time) <
            Math.abs(nearest.time - segment.time)
        )
          nearest = s;
      }
      if (nearest) setIndex(nearest.index);
    }
  }

  useEffect(() => {
    if (!playing) return;
    const begin = performance.now() - phaseRef.current * 2400;
    let frame;
    let last = 0;
    function tick(now) {
      if (now - last > 30) {
        setPhase(((now - begin) % 2400) / 2400);
        last = now;
      }
      frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  function view(name) {
    setCameraRequest((previous) => ({ name, revision: previous.revision + 1 }));
  }
  async function importFile(event) {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;
    setImporting(true);
    setPlaying(false);
    try {
      const incoming = await readRunFiles(files);
      const newPersonalSession = source === "demo" || source === "published";
      const existing = newPersonalSession ? [] : runs;
      const merged = mergeRuns(existing, incoming);
      const selectedRun = merged.find(
        (run) => signature(run) === signature(incoming.at(-1)),
      );
      const nextData = await loadRunData(selectedRun);
      setRuns(merged);
      setSelectedRunId(selectedRun.id);
      setScreen("workbench");
      setSource("imported");
      setData(nextData);
      setIndex(0);
      setPhase(0);
      setLeft(nextData.leftCount > 0);
      setRight(nextData.rightCount > 0);
      setMirror(false);
      setHistorySettings((previous) => ({
        ...previous,
        days: 0,
        surface: "all",
        ...(newPersonalSession
          ? {
              target: defaultTarget(merged),
              baselineId: (merged.at(-2) ?? merged[0]).id,
            }
          : {}),
      }));
      setNotice({
        type: "success",
        text: `新增 ${merged.length - existing.length} 次跑步，跳过 ${incoming.length - (merged.length - existing.length)} 份重复记录；当前共 ${merged.length} 次。文件仅在浏览器中处理，刷新后需重新导入。`,
      });
    } catch (error) {
      setNotice({ type: "error", text: `无法读取 JSON：${error.message}` });
    } finally {
      setImporting(false);
      event.target.value = "";
    }
  }
  async function activateRun(run, nextScreen, nextIndex = 0) {
    if (!run) return;
    setImporting(true);
    setPlaying(false);
    try {
      const nextData = await loadRunData(run);
      setData(nextData);
      setSelectedRunId(run.id);
      setIndex(nextIndex);
      setPhase(0);
      setMirror(false);
      setLeft(nextData.leftCount > 0);
      setRight(nextData.rightCount > 0);
      setMode(nextScreen === "detail" ? "single" : "overlay");
      setTrendSettings(initialTrendSettings);
      view("3d");
      setScreen(nextScreen);
    } catch (error) {
      setNotice({ type: "error", text: `轨迹读取失败：${error.message}` });
    } finally {
      setImporting(false);
    }
  }
  function saveImage() {
    plot.current?.saveImage(
      `${dateText(data.start)} · 片段 ${index + 1} · ${mirror ? "左右镜像对齐" : "原始坐标"}`,
    );
    setNotice({ type: "success", text: "图片已生成，可在浏览器下载中查看。" });
  }
  function exportStats() {
    const csv =
      screen === "workbench"
        ? workbench.current?.exportCsv()
        : screen === "longterm"
          ? longterm.current?.exportCsv()
          : trends.current?.exportCsv();
    if (!csv) return;
    const a = document.createElement("a");
    a.href = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
    a.download =
      screen === "longterm" || screen === "workbench"
        ? "footpath-longterm.csv"
        : `footpath-trends-${dateText(data.start).replaceAll("/", "-")}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setNotice({
      type: "success",
      text: "统计文件已生成，可在浏览器下载中查看。包含当前筛选下的分段统计和计算口径。",
    });
  }
  function inspectSegment(value) {
    setIndex(value);
    setLeft(data.leftCount > 0);
    setRight(data.rightCount > 0);
    setMode("single");
    setPlaying(false);
    setScreen("detail");
  }
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <h1>Footpath Studio</h1>
          <div className="subtitle">
            Stryd Duo ·{" "}
            {screen === "longterm" ? "长期跑姿趋势" : dateText(data.start)}{" "}
            <span>
              {screen === "longterm"
                ? `${runs.length} 次跑步`
                : data.title.replace(/^\d{4}-\d{2}-\d{2} · /, "")}
            </span>
          </div>
        </div>
        <div className="header-actions">
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            multiple
            onChange={importFile}
            hidden
            aria-label="选择 Footpath JSON 文件"
          />
          <button
            className="button secondary"
            aria-label="导入 JSON"
            title={
              source === "demo" || source === "published"
                ? "用自己的 Footpath JSON 开始分析"
                : "追加一份或多份 Footpath JSON"
            }
            onClick={() => fileInput.current.click()}
            disabled={importing}
          >
            <Icon name="upload" />
            <span>{importing ? "读取中…" : "导入 JSON"}</span>
          </button>
          <button
            className="button primary"
            onClick={screen === "detail" ? saveImage : exportStats}
          >
            <Icon name="download" />
            <span>{screen === "detail" ? "保存图片" : "导出统计"}</span>
          </button>
        </div>
      </header>
      <nav className="screen-nav" aria-label="浏览模式">
        <button
          aria-pressed={screen === "workbench"}
          onClick={() => {
            setPlaying(false);
            setScreen("workbench");
          }}
        >
          Footpath 分析
        </button>
        <button
          aria-pressed={screen === "longterm"}
          onClick={() => {
            setPlaying(false);
            setScreen("longterm");
          }}
        >
          长期趋势
        </button>
        <button
          disabled={importing}
          aria-pressed={screen === "trends"}
          onClick={() =>
            screen === "detail"
              ? setScreen("trends")
              : activateRun(
                  runs.find((run) => run.id === selectedRunId),
                  "trends",
                )
          }
        >
          单次分析
        </button>
        <button
          disabled={importing}
          aria-pressed={screen === "detail"}
          onClick={() =>
            screen === "trends"
              ? setScreen("detail")
              : activateRun(
                  runs.find((run) => run.id === selectedRunId),
                  "detail",
                )
          }
        >
          三维细节
        </button>
      </nav>
      <div className="data-source-notice" data-testid="data-source">
        <span>
          {source === "demo"
            ? "合成演示数据 · 导入 JSON 开始分析自己的跑姿"
            : source === "published"
              ? "公开历史数据 · 导入 JSON 开始你自己的分析"
              : "本地数据 · 文件在浏览器中分析，导入内容不上传"}
        </span>
        <button onClick={onReset} disabled={importing}>
          重新开始
        </button>
      </div>
      {notice && (
        <div
          className={`notice ${notice.type}`}
          role={notice.type === "error" ? "alert" : "status"}
        >
          <span>{notice.text}</span>
          <button
            className="icon-button"
            aria-label="关闭提示"
            onClick={() => setNotice(null)}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      )}
      {screen === "workbench" ? (
        <Workbench
          ref={workbench}
          runs={runs}
          settings={historySettings}
          setSettings={setHistorySettings}
          selectedId={selectedRunId}
          setSelectedId={setSelectedRunId}
          onOpen={activateRun}
        />
      ) : screen === "longterm" ? (
        <LongTerm
          ref={longterm}
          runs={runs}
          settings={historySettings}
          setSettings={setHistorySettings}
          selectedId={selectedRunId}
          setSelectedId={setSelectedRunId}
          onOpen={activateRun}
        />
      ) : screen === "trends" ? (
        <Trends
          ref={trends}
          data={data}
          settings={trendSettings}
          setSettings={setTrendSettings}
          onInspect={inspectSegment}
        />
      ) : (
        <main className="workspace">
          <section className="visualization" aria-label="三维轨迹视图">
            <div className="plot-region">
              <div className="plot-toolbar">
                <div className="plot-title">
                  <h2>三维轨迹</h2>
                  <div className="legend">
                    <span className={!left ? "muted" : ""}>
                      <i className="left-line" />
                      左脚
                    </span>
                    <span className={!right ? "muted" : ""}>
                      <i className="right-line" />
                      右脚
                    </span>
                  </div>
                </div>
                <div
                  className="camera-controls"
                  role="group"
                  aria-label="相机视角"
                >
                  {[
                    ["3d", "3D"],
                    ["side", "侧视"],
                    ["back", "后视"],
                    ["top", "俯视"],
                  ].map(([name, label]) => (
                    <button
                      key={name}
                      aria-pressed={cameraRequest.name === name}
                      onClick={() => view(name)}
                    >
                      {label}
                    </button>
                  ))}
                  <button
                    className="reset-view"
                    aria-label="重置视角"
                    title="重置视角"
                    onClick={() => view("3d")}
                  >
                    <Icon name="reset" />
                  </button>
                </div>
              </div>
              <Plot
                ref={plot}
                data={data}
                selected={selected}
                mirror={mirror}
                left={left}
                right={right}
                mode={mode}
                opacity={opacity}
                phase={phase}
                cameraRequest={cameraRequest}
                onFreeView={() =>
                  setCameraRequest((previous) => ({
                    ...previous,
                    name: "free",
                  }))
                }
                onError={(text) => setNotice({ type: "error", text })}
              />
              {!left && !right && (
                <div className="empty-overlay">勾选左脚或右脚以显示轨迹</div>
              )}
              <div className="plot-hint">拖动旋转 · 滚轮缩放 · 右键平移</div>
            </div>
            <Timeline
              data={data}
              index={index}
              navigation={navigation}
              phase={phase}
              playing={playing}
              setIndex={setIndex}
              setPhase={setPhase}
              setPlaying={setPlaying}
            />
          </section>
          <Inspector
            data={data}
            segment={segment}
            left={left}
            right={right}
            mirror={mirror}
            mode={mode}
            opacity={opacity}
            setLeft={(checked) => changeSide(1, checked)}
            setRight={(checked) => changeSide(2, checked)}
            setMirror={setMirror}
            setMode={setMode}
            setOpacity={setOpacity}
          />
        </main>
      )}
    </div>
  );
}
