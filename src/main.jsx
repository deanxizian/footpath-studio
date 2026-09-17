import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { loadHistory } from "./site-data.js";
import { createDemoSession } from "./demo.js";
import "./analysis.css";

function Studio() {
  const [loaded, setLoaded] = useState(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError("");
    async function load() {
      try {
        if (
          import.meta.env.VITE_LOCAL_ARCHIVE ||
          import.meta.env.VITE_PUBLISHED_HISTORY
        ) {
          const history = await loadHistory();
          if (active) setLoaded({ history, source: "archive" });
        } else if (active) setLoaded(createDemoSession());
      } catch (e) {
        if (active) setError(e.message || "数据加载失败，请重试。");
      }
    }
    load();
    return () => {
      active = false;
    };
  }, [attempt]);
  if (loaded) return <App history={loaded.history} source={loaded.source} />;
  return (
    <main className="studio-loading">
      <h1>Footpath Studio</h1>
      {error ? (
        <>
          <p role="alert">{error}</p>
          <button onClick={() => setAttempt((n) => n + 1)}>重试</button>
        </>
      ) : (
        <p role="status">正在加载历史数据…</p>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")).render(<Studio />);
