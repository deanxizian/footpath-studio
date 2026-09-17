import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { loadRunData } from "./history-model.js";
import { FootpathScene } from "./scene.js";
import {
  baselineTrajectories,
  comparisonTrajectories,
  runTrajectories,
  trajectoryBounds,
} from "./trajectory-model.js";

const referenceUrl = import.meta.env.VITE_TRAJECTORY_REFERENCE_URL;
let referencePromise;
function loadReferences() {
  referencePromise ??= fetch(referenceUrl)
    .then(async (response) => {
      if (!response.ok) throw new Error("基准轨迹加载失败");
      const data = await response.json();
      if (data.format !== "footpath-trajectory-references-v1" || !data.runs)
        throw new Error("基准轨迹格式无效");
      return data.runs;
    })
    .catch((error) => {
      referencePromise = null;
      throw error;
    });
  return referencePromise;
}

function TrajectoryCanvas({ data, mirror, sides, view, onFreeView }) {
  const host = useRef(null),
    scene = useRef(null);
  const [error, setError] = useState("");
  useEffect(() => {
    try {
      scene.current = new FootpathScene(host.current, onFreeView);
    } catch {
      setError("三维视图需要支持 WebGL 2 的浏览器。");
    }
    return () => {
      scene.current?.dispose();
      scene.current = null;
    };
  }, [onFreeView]);
  useEffect(() => {
    if (!scene.current || !data.segments.length) return;
    scene.current.setData(data, mirror, true);
    scene.current.setSelected(data.segments.map((_, i) => i));
  }, [data, mirror]);
  useEffect(() => {
    scene.current?.setDisplay(sides, "single", 0);
  }, [data, sides]);
  useEffect(() => {
    if (view !== "free") scene.current?.setView(view);
  }, [view]);
  return (
    <div
      ref={host}
      className="trajectory-canvas"
      data-testid="trajectory-canvas"
      data-view={view}
      data-mirror={mirror}
      data-current-curves={
        data.segments.filter((s) => s.comparisonRole === "current").length
      }
      data-baseline-curves={
        data.segments.filter((s) => s.comparisonRole === "baseline").length
      }
      data-curve-signature={data.segments
        .filter((s) => s.comparisonRole === "current")
        .map((s) => s.points[50].join(","))
        .join(";")}
    >
      {error && (
        <p className="trajectory-message" role="alert">
          {error}
        </p>
      )}
      {!sides[1] && !sides[2] && (
        <p className="trajectory-message">选择左脚或右脚显示轨迹</p>
      )}
    </div>
  );
}

export default function TrajectoryPanel({
  selected,
  baseline,
  allRuns,
  stage,
  children,
}) {
  const [loaded, setLoaded] = useState(null);
  const [references, setReferences] = useState(null);
  const [errors, setErrors] = useState({});
  const [retry, setRetry] = useState(0);
  const [view, setView] = useState("3d");
  const [mirror, setMirror] = useState(false);
  const [sides, setSides] = useState({ 1: true, 2: true });
  const onFreeView = useCallback(() => setView("free"), []);
  useEffect(() => {
    let active = true;
    setErrors((previous) => ({ ...previous, current: "" }));
    loadRunData(selected)
      .then((data) => {
        if (active) setLoaded({ id: selected.id, data });
      })
      .catch((error) => {
        if (active)
          setErrors((previous) => ({ ...previous, current: error.message }));
      });
    return () => {
      active = false;
    };
  }, [selected, retry]);
  useEffect(() => {
    let active = true;
    setErrors((previous) => ({ ...previous, reference: "" }));
    const promise = referenceUrl
      ? loadReferences()
      : Promise.resolve(
          Object.fromEntries(
            allRuns.map((run) => [
              run.id,
              runTrajectories(run.data, run.eligible, run.summary),
            ]),
          ),
        );
    promise
      .then((value) => {
        if (active) setReferences(value);
      })
      .catch((error) => {
        if (active)
          setErrors((previous) => ({ ...previous, reference: error.message }));
      });
    return () => {
      active = false;
    };
  }, [allRuns, retry]);
  const data = loaded?.id === selected.id ? loaded.data : null;
  const whole = useMemo(
    () =>
      data ? runTrajectories(data, selected.eligible, selected.summary) : null,
    [data, selected],
  );
  const current = useMemo(
    () =>
      data
        ? stage.rows === selected.eligible
          ? whole
          : runTrajectories(data, stage.rows, selected.summary)
        : null,
    [data, stage, selected, whole],
  );
  const reference = useMemo(
    () => (references ? baselineTrajectories(baseline.runs, references) : null),
    [baseline, references],
  );
  const bounds = useMemo(
    () => trajectoryBounds(whole, reference),
    [whole, reference],
  );
  const comparison = useMemo(
    () => comparisonTrajectories(current, reference, bounds, mirror),
    [current, reference, bounds, mirror],
  );
  const count = reference ? `${reference[1].n} / ${reference[2].n}` : "…";
  const error = errors.current || errors.reference;
  return (
    <section
      className="studio-trajectory studio-panel"
      aria-label="三维轨迹对比"
    >
      <div className="panel-heading trajectory-heading">
        <h2>三维轨迹</h2>
        <div className="view-controls" role="group" aria-label="轨迹视角">
          {[
            ["3d", "3D"],
            ["side", "侧面"],
            ["back", "后方"],
            ["top", "俯视"],
          ].map(([key, label]) => (
            <button
              key={key}
              aria-pressed={view === key}
              onClick={() => setView(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="trajectory-options">
        <div className="trajectory-feet">
          {[1, 2].map((side) => (
            <label
              key={side}
              className={side === 1 ? "foot-left" : "foot-right"}
            >
              <input
                type="checkbox"
                checked={sides[side]}
                onChange={(event) =>
                  setSides((previous) => ({
                    ...previous,
                    [side]: event.target.checked,
                  }))
                }
              />
              {side === 1 ? "左脚" : "右脚"}
            </label>
          ))}
        </div>
        <label className="mirror-option">
          <input
            type="checkbox"
            checked={mirror}
            onChange={(event) => setMirror(event.target.checked)}
          />
          镜像左脚
        </label>
      </div>
      <div className="trajectory-plot" aria-busy={!data || !references}>
        {comparison.segments.length > 0 && (
          <TrajectoryCanvas
            key={selected.id}
            data={comparison}
            mirror={mirror}
            sides={sides}
            view={view}
            onFreeView={onFreeView}
          />
        )}
        {!data && !error && (
          <p className="trajectory-message" role="status">
            正在加载本次轨迹…
          </p>
        )}
        {data && !current?.[1]?.points && !current?.[2]?.points && (
          <p className="trajectory-message" role="status">
            此阶段没有足够的轨迹片段
          </p>
        )}
        {error && (
          <div className="trajectory-message" role="alert">
            {error}
            <button onClick={() => setRetry((n) => n + 1)}>重试</button>
          </div>
        )}
      </div>
      <div className="trajectory-legend">
        <span>
          <i />
          本次平均轨迹
        </span>
        <span title={`基准有效跑步：左 / 右 ${count} 次`}>
          <i className="dashed" />
          最近 {baseline.label}均值{!references && !error ? " · 加载中" : ""}
        </span>
      </div>
      {children}
    </section>
  );
}
