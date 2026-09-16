import { runFromRaw } from "./history-model.js";
import { createSession } from "./session.js";

// Deterministic mathematical fixtures, never derived from a person's recordings.
export function createDemoRun(runIndex) {
  const start = Date.UTC(2024, 0, 6 + runIndex * 7, 8) / 1000;
  const segments = Array.from({ length: 96 }, (_, index) => {
    const side = (index % 2) + 1;
    const variation = 1 + 0.025 * Math.sin(index * 1.7 + runIndex);
    const width =
      (0.036 + 0.002 * Math.sin(runIndex / 3) + runIndex * 0.00025) *
      (side === 1 ? 0.94 : 1.06);
    const height =
      (0.112 - runIndex * 0.0003 + 0.003 * Math.cos(runIndex / 4)) * variation;
    return {
      side,
      timestamp: start + Math.floor(index / 2) * 40,
      timestamp_frac: side === 1 ? 0 : 0.32,
      speed: 3.35 + 0.06 * Math.sin(index / 6),
      power: 225 + (index % 17),
      ground_contact_time: 230 - runIndex * 0.3 + (index % 7),
      stride_time: 670 - runIndex * 0.4 + (index % 11),
      points: Array.from({ length: 65 }, (_, pointIndex) => {
        const phase = (pointIndex / 64) * Math.PI * 2;
        const swing = 1 - Math.cos(phase);
        return [
          -0.42 * swing * variation,
          (side === 1 ? -1 : 1) * width * swing * (1 + 0.09 * Math.sin(phase)),
          height * swing * (1 + 0.62 * Math.sin(phase)),
        ];
      }),
    };
  });
  return {
    format: "footpath-studio-v1",
    title: `合成演示 · 第 ${runIndex + 1} 次跑步`,
    segments,
  };
}

export function createDemoSession() {
  const runs = Array.from({ length: 24 }, (_, index) => {
    const run = runFromRaw(createDemoRun(index), "合成演示");
    return {
      ...run,
      id: `demo-${index + 1}`,
      activity: {
        name: run.title,
        distance: 6400,
        moving_time: 1920,
        surface_type: "road",
      },
    };
  });
  return createSession(runs, "demo");
}
