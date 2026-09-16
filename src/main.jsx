import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { loadHistory } from "./site-data.js";
import { clearRunCache, loadRunData } from "./history-model.js";
import { createSession, readRunFiles } from "./session.js";
import { createDemoSession } from "./demo.js";
import "./styles.css";
import "./trends.css";
import "./history.css";
import "./loading.css";
import "./analysis.css";

function Studio() {
  const [loaded, setLoaded] = useState(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(true);
  const fileInput = useRef(null);
  useEffect(() => {
    let active = true;
    async function load() {
      setError("");
      setBusy(true);
      try {
        if (
          import.meta.env.VITE_LOCAL_ARCHIVE ||
          import.meta.env.VITE_PUBLISHED_HISTORY
        ) {
          const history = await loadHistory();
          const initialData = await loadRunData(history.runs.at(-1));
          if (active)
            setLoaded({
              history,
              initialData,
              source: import.meta.env.VITE_PUBLISHED_HISTORY
                ? "published"
                : "archive",
            });
        } else if (active) setLoaded(createDemoSession());
      } catch (e) {
        clearRunCache();
        if (active) setError(e.message || "数据加载失败，请重试。");
      } finally {
        if (active) setBusy(false);
      }
    }
    load();
    return () => {
      active = false;
    };
  }, [attempt]);
  async function importFiles(event) {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;
    setBusy(true);
    setError("");
    try {
      setLoaded(createSession(await readRunFiles(files)));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      event.target.value = "";
    }
  }
  if (loaded)
    return (
      <App
        {...loaded}
        onReset={() => {
          clearRunCache();
          setLoaded(null);
          setError("");
        }}
      />
    );
  return (
    <main className="loading-shell">
      <div className="loading-brand">
        FOOTPATH <span>STUDIO</span>
      </div>
      <section className="loading-card">
        <p className="loading-eyebrow">你的跑姿，随时间展开</p>
        <h1>Footpath Studio</h1>
        {busy ? (
          <p role="status">正在加载跑姿数据…</p>
        ) : (
          <>
            <p className="welcome-copy">
              导入自己的 Footpath JSON，比较三维轨迹与长期变化。
            </p>
            <p className="welcome-privacy">
              文件仅在当前浏览器中处理，不上传。刷新后需要重新导入。
            </p>
            {error && <p role="alert">{error}</p>}
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              multiple
              hidden
              onChange={importFiles}
              aria-label="选择 Footpath JSON 文件"
            />
            <div className="welcome-actions">
              <button onClick={() => fileInput.current.click()}>
                导入 JSON
              </button>
              <button
                className="welcome-secondary"
                onClick={() => {
                  setError("");
                  setLoaded(createDemoSession());
                }}
              >
                查看演示
              </button>
            </div>
            {(import.meta.env.VITE_LOCAL_ARCHIVE ||
              import.meta.env.VITE_PUBLISHED_HISTORY) && (
              <button
                className="welcome-secondary"
                onClick={() => setAttempt((value) => value + 1)}
              >
                打开历史档案
              </button>
            )}
          </>
        )}
      </section>
    </main>
  );
}
createRoot(document.getElementById("root")).render(<Studio />);
