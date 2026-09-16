import {
  defaultTarget,
  mergeRuns,
  ROW_FIELDS,
  runFromRaw,
} from "./history-model.js";

export const MAX_FILE_BYTES = 128 * 1024 * 1024;
export const MAX_BATCH_BYTES = 256 * 1024 * 1024;

export function createSession(runs, source = "imported") {
  if (!runs.length) throw new Error("请至少选择一份 Footpath JSON。");
  const ordered = mergeRuns([], runs);
  return {
    source,
    history: {
      format: "footpath-studio-collection-v1",
      defaultSpeed: defaultTarget(ordered),
      runs: ordered.map((run) => ({
        ...run,
        rows: run.rows.map((row) => ROW_FIELDS.map((field) => row[field])),
      })),
    },
    initialData: ordered.at(-1).data,
  };
}

export async function readRunFiles(files) {
  const selected = Array.from(files);
  if (!selected.length) throw new Error("请至少选择一份 Footpath JSON。");
  if (selected.some((file) => file.size > MAX_FILE_BYTES))
    throw new Error("单个文件请控制在 128 MB 以内。");
  if (selected.reduce((sum, file) => sum + file.size, 0) > MAX_BATCH_BYTES)
    throw new Error("一次导入的文件总大小请控制在 256 MB 以内。");
  const runs = [];
  for (const file of selected) {
    let raw;
    try {
      raw = JSON.parse(await file.text());
    } catch {
      throw new Error(`${file.name} 不是有效的 JSON 文件。`);
    }
    runs.push(runFromRaw(raw, file.name));
  }
  return runs;
}
