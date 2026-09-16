import { execFileSync } from "node:child_process";
import { validatePublishedHistory } from "./monthly-history.mjs";

function validateRepository(repository) {
  if (
    typeof repository !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(repository) ||
    [".", ".."].includes(repository.split("/")[1])
  )
    throw new Error(
      "Cannot identify a valid GitHub repository for history data",
    );
  return repository;
}

export function repositoryFromRemote(remote) {
  const match = String(remote)
    .trim()
    .match(
      /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/?#]+\/[^/?#]+?)(?:\.git)?\/?$/,
    );
  if (!match)
    throw new Error("The origin remote must identify a GitHub repository");
  return validateRepository(match[1]);
}

export function resolveRepository({
  env = process.env,
  cwd = process.cwd(),
  readOrigin = () =>
    execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
} = {}) {
  // Cloud builds must identify their own repository, including forks. Never
  // silently fall back to a different origin when cloud metadata is incomplete.
  if (
    env.VERCEL === "1" ||
    env.VERCEL_GIT_REPO_OWNER ||
    env.VERCEL_GIT_REPO_SLUG
  ) {
    if (
      (env.VERCEL_GIT_PROVIDER && env.VERCEL_GIT_PROVIDER !== "github") ||
      !env.VERCEL_GIT_REPO_OWNER ||
      !env.VERCEL_GIT_REPO_SLUG
    )
      throw new Error(
        "Enable Vercel system environment variables for the connected GitHub repository",
      );
    return validateRepository(
      `${env.VERCEL_GIT_REPO_OWNER}/${env.VERCEL_GIT_REPO_SLUG}`,
    );
  }
  if (env.GITHUB_ACTIONS === "true" || env.GITHUB_REPOSITORY)
    return validateRepository(env.GITHUB_REPOSITORY);
  let origin;
  try {
    origin = readOrigin();
  } catch {
    throw new Error(
      "Cannot read the Git origin; use a GitHub clone to build history data",
    );
  }
  return repositoryFromRemote(origin);
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
      "History must use monthly Releases in the current repository",
    );
  return manifest;
}

export async function fetchPublishedHistory(
  repository,
  request = fetch,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  validateRepository(repository);
  const url = `https://github.com/${repository}/releases/latest/download/published-history.json`;
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
      return validateSourceManifest(JSON.parse(text), repository);
    } catch (error) {
      if (attempt === 4) throw error;
      await pause(2000 * 2 ** attempt);
    }
  }
}
