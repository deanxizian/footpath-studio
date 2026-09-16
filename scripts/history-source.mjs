import { validatePublishedHistory } from "./monthly-history.mjs";

export function validateHistorySource(source) {
  if (
    source?.format !== "footpath-studio-history-source-v1" ||
    !/^[\w.-]+\/[\w.-]+$/.test(source.repository || "")
  )
    throw new Error("Invalid history source configuration");
  return source;
}

export function validateSourceManifest(manifest, repository) {
  validatePublishedHistory(manifest);
  const prefix = `https://github.com/${repository}/releases/download/footpath-`;
  if (
    manifest.format !== "footpath-studio-monthly-history-v2" ||
    [manifest.catalog, ...manifest.months].some(
      (asset) => !asset.url.startsWith(prefix),
    )
  )
    throw new Error(
      "History must use monthly Releases in the configured repository",
    );
  return manifest;
}

export async function fetchPublishedHistory(
  source,
  request = fetch,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  validateHistorySource(source);
  const url = `https://github.com/${source.repository}/releases/latest/download/published-history.json`;
  // GitHub replaces the small discovery asset after immutable packages are ready.
  // Retry its brief replacement window and transient CDN errors without pinning
  // data in Git or requiring an authenticated API request in a public build.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await request(url + `?refresh=${Date.now()}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok)
        throw new Error(`History discovery returned HTTP ${response.status}`);
      const text = await response.text();
      if (text.length > 1024 * 1024)
        throw new Error("History manifest exceeds size limit");
      return validateSourceManifest(JSON.parse(text), source.repository);
    } catch (error) {
      if (attempt === 4) throw error;
      await pause(2000 * 2 ** attempt);
    }
  }
}
