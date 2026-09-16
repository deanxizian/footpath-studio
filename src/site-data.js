export async function fetchDataBytes(url) {
  const target = new URL(url, window.location.href);
  if (
    target.origin !== window.location.origin ||
    !/^\/data\/[a-f0-9]{64}\.bin$/.test(target.pathname) ||
    target.search ||
    target.hash
  )
    throw new Error("数据地址不正确。");
  const response = await fetch(target.href);
  if (!response.ok)
    throw new Error(`数据下载失败 (${response.status})，请稍后再试。`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const digest = Array.from(hash, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (digest !== target.pathname.slice("/data/".length, -".bin".length))
    throw new Error("数据校验失败，请刷新重试。");
  return bytes;
}

export async function readDataJson(url) {
  const bytes = await fetchDataBytes(url);
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}

export async function loadHistory() {
  const response = await fetch("/data/version.json", { cache: "no-store" });
  if (!response.ok) throw new Error("暂时无法获取数据版本，请刷新重试。");
  const version = await response.json();
  if (version.format !== "footpath-studio-public-v1")
    throw new Error("数据版本不受支持。");
  const history = await readDataJson("/data/" + version.index);
  if (
    history.format !== "footpath-studio-collection-v1" ||
    !Array.isArray(history.runs) ||
    !history.runs.length
  )
    throw new Error("还没有可用的 Footpath 数据。");
  return history;
}
