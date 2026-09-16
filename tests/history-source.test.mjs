import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchPublishedHistory,
  repositoryFromRemote,
  resolveRepository,
  validateSourceManifest,
} from "../scripts/history-source.mjs";

const hash = "a".repeat(64);
const repository = "owner/repo";
const asset = (name) => ({
  url: `https://github.com/owner/repo/releases/download/footpath-2026-09/${name}-${hash}.tar`,
  sha256: hash,
  bytes: 1024,
  fileCount: 2,
});
const manifest = {
  format: "footpath-studio-monthly-history-v2",
  timeZone: "Asia/Shanghai",
  latestMonth: "2026-09",
  runCount: 1,
  fileCount: 3,
  revision: hash,
  catalog: asset("footpath-catalog"),
  months: [
    {
      ...asset("footpath-2026-09"),
      month: "2026-09",
      runCount: 1,
      fileCount: 3,
      revision: hash,
    },
  ],
};

test("current repository resolves the latest complete snapshot and retries alias replacement", async () => {
  let calls = 0;
  const value = await fetchPublishedHistory(
    repository,
    async (url, options) => {
      assert.match(
        url,
        /\/releases\/latest\/download\/published-history\.json\?refresh=\d+$/,
      );
      assert.equal(options.cache, "no-store");
      calls++;
      return calls === 1
        ? { ok: false, status: 404 }
        : { ok: true, text: async () => JSON.stringify(manifest) };
    },
    async () => {},
  );
  assert.equal(calls, 2);
  assert.deepEqual(value, manifest);
});

test("public discovery refuses other repositories, credential drafts, and mismatched months", () => {
  for (const url of [
    manifest.catalog.url.replace("/owner/", "/other/"),
    manifest.catalog.url.replace("footpath-2026-09/", "stryd-sync-state/"),
  ])
    assert.throws(() =>
      validateSourceManifest(
        { ...manifest, catalog: { ...manifest.catalog, url } },
        repository,
      ),
    );
  assert.throws(() =>
    validateSourceManifest({ ...manifest, latestMonth: "2026-10" }, repository),
  );
});

test("cloud builds use their own repository, including a fork, without reading local Git", () => {
  const readOrigin = () => {
    throw new Error("Local Git must not be read");
  };
  assert.equal(
    resolveRepository({
      env: {
        VERCEL: "1",
        VERCEL_GIT_PROVIDER: "github",
        VERCEL_GIT_REPO_OWNER: "fork-owner",
        VERCEL_GIT_REPO_SLUG: "my-studio",
        GITHUB_REPOSITORY: "original/studio",
      },
      readOrigin,
    }),
    "fork-owner/my-studio",
  );
  assert.equal(
    resolveRepository({
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REPOSITORY: "fork-owner/my-studio",
      },
      readOrigin,
    }),
    "fork-owner/my-studio",
  );
  for (const env of [
    { VERCEL: "1" },
    { VERCEL_GIT_REPO_OWNER: "owner" },
    {
      VERCEL: "1",
      VERCEL_GIT_PROVIDER: "gitlab",
      VERCEL_GIT_REPO_OWNER: "owner",
      VERCEL_GIT_REPO_SLUG: "repo",
    },
    {
      VERCEL: "1",
      VERCEL_GIT_REPO_OWNER: "owner",
      VERCEL_GIT_REPO_SLUG: "../other",
    },
    { GITHUB_ACTIONS: "true" },
    { GITHUB_REPOSITORY: "owner/repo/../../other" },
    { GITHUB_REPOSITORY: "owner/.." },
  ])
    assert.throws(() =>
      resolveRepository({
        env,
        readOrigin: () => "https://github.com/fallback/repo.git",
      }),
    );
});

test("local repository discovery supports GitHub remotes and omits credentials from errors", async () => {
  for (const remote of [
    "https://github.com/owner/repo.git",
    "https://github.com/owner/repo/",
    "git@github.com:owner/repo.git",
    "ssh://git@github.com/owner/repo.git",
  ])
    assert.equal(repositoryFromRemote(remote), repository);
  for (const remote of [
    "https://secret@github.com/owner/repo.git",
    "https://github.com.evil/owner/repo.git",
    "git@gitlab.com:owner/repo.git",
    "https://github.com/owner/..",
    "https://github.com/owner/repo?secret=value",
    "/private/secret.git",
  ])
    assert.throws(
      () => repositoryFromRemote(remote),
      (error) => !error.message.includes("secret"),
    );
  assert.throws(
    () =>
      resolveRepository({
        env: {},
        readOrigin: () => {
          throw new Error("secret in Git error");
        },
      }),
    (error) => !error.message.includes("secret"),
  );
  const directory = await mkdtemp(join(tmpdir(), "footpath-origin-"));
  try {
    execFileSync("git", ["init", "--quiet", directory]);
    execFileSync("git", [
      "-C",
      directory,
      "remote",
      "add",
      "origin",
      "git@github.com:owner/repo.git",
    ]);
    assert.equal(resolveRepository({ env: {}, cwd: directory }), repository);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
