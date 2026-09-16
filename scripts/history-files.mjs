import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

export const DATA_FILE = /^(?:version\.json|[a-f0-9]{64}\.bin)$/;
export async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function verifyHistory(directory, expected = {}) {
  const files = (await readdir(directory)).sort();
  if (!files.length || files.some((file) => !DATA_FILE.test(file)))
    throw new Error("Unexpected file in history directory");
  for (const file of files) {
    if (!(await lstat(join(directory, file))).isFile())
      throw new Error(`History must contain regular files: ${file}`);
    if (
      file.endsWith(".bin") &&
      (await sha256(join(directory, file))) !== file.slice(0, -4)
    )
      throw new Error(`History checksum mismatch: ${file}`);
  }
  const version = JSON.parse(
    await readFile(join(directory, "version.json"), "utf8"),
  );
  if (
    version.format !== "footpath-studio-public-v1" ||
    !/^[a-f0-9]{64}\.bin$/.test(version.index)
  )
    throw new Error("Unsupported history version");
  const history = JSON.parse(
    gunzipSync(await readFile(join(directory, version.index)), {
      maxOutputLength: 256 * 1024 * 1024,
    }),
  );
  if (
    history.format !== "footpath-studio-collection-v1" ||
    !history.runs?.length
  )
    throw new Error("Invalid history collection");
  const referenced = new Set(["version.json", version.index]);
  for (const run of history.runs) {
    if (!/^\/data\/[a-f0-9]{64}\.bin$/.test(run.packedUrl))
      throw new Error("History contains an unsupported data URL");
    referenced.add(run.packedUrl.slice("/data/".length));
  }
  if (
    files.length !== referenced.size ||
    files.some((file) => !referenced.has(file))
  )
    throw new Error("History files and index disagree");
  if (expected.runCount != null && history.runs.length !== expected.runCount)
    throw new Error("History run count mismatch");
  if (expected.fileCount != null && files.length !== expected.fileCount)
    throw new Error("History file count mismatch");
  if (expected.revision && version.revision !== expected.revision)
    throw new Error("History revision mismatch");
  return {
    files,
    runCount: history.runs.length,
    fileCount: files.length,
    revision: version.revision,
  };
}

export function validateArchiveEntries(names, verbose, expectedCount) {
  if (
    names.length !== expectedCount ||
    new Set(names).size !== names.length ||
    names.some(
      (name) => !/^data\/(?:version\.json|[a-f0-9]{64}\.bin)$/.test(name),
    )
  )
    throw new Error("Unsafe or unexpected history archive paths");
  if (
    verbose.length !== names.length ||
    verbose.some((line) => !line.startsWith("-"))
  )
    throw new Error("History archive must contain regular files only");
}
