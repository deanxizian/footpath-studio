import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchPublishedHistory,
  validateHistorySource,
  validateSourceManifest,
} from "../scripts/history-source.mjs";

const hash = "a".repeat(64);
const source = {
  format: "footpath-studio-history-source-v1",
  repository: "owner/repo",
};
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

test("stable source resolves the latest complete snapshot and retries alias replacement", async () => {
  let calls = 0;
  const value = await fetchPublishedHistory(
    source,
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
  assert.throws(() =>
    validateHistorySource({ ...source, repository: "owner/repo/../../secret" }),
  );
  for (const url of [
    manifest.catalog.url.replace("/owner/", "/other/"),
    manifest.catalog.url.replace("footpath-2026-09/", "stryd-sync-state/"),
  ])
    assert.throws(() =>
      validateSourceManifest(
        { ...manifest, catalog: { ...manifest.catalog, url } },
        source.repository,
      ),
    );
  assert.throws(() =>
    validateSourceManifest(
      { ...manifest, latestMonth: "2026-10" },
      source.repository,
    ),
  );
});
