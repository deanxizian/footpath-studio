import { defineConfig } from "vite";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { buildTrajectoryReferences } from "./scripts/trajectory-references.mjs";
import { TRAJECTORY_VERSION } from "./src/trajectory-model.js";

export default defineConfig(async ({ command, mode }) => {
  const localArchive = command === "serve" && mode === "local-archive";
  const publishedHistory = command === "build" && mode === "public-history";
  const root = fileURLToPath(new URL("./", import.meta.url));
  const directory = join(
    root,
    localArchive ? "private-data/data" : "public-history/data",
  );
  let referencePath = null;
  let referencePromise;
  if (localArchive || publishedHistory) {
    const version = JSON.parse(
      await readFile(join(directory, "version.json"), "utf8"),
    );
    if (!/^[a-f0-9]{64}\.bin$/.test(version.index))
      throw new Error("Invalid history index");
    referencePath = `assets/trajectory-v${TRAJECTORY_VERSION}-${version.index.slice(0, -4)}.json`;
  }
  const references = () => {
    referencePromise ??= buildTrajectoryReferences(
      directory,
      join(root, ".cache/trajectory-references"),
    ).catch((error) => {
      referencePromise = null;
      throw error;
    });
    return referencePromise;
  };
  return {
    // Only an explicitly fetched, owner-approved release can enter a history build.
    publicDir: publishedHistory ? "public-history" : false,
    define: {
      "import.meta.env.VITE_LOCAL_ARCHIVE": JSON.stringify(localArchive),
      "import.meta.env.VITE_PUBLISHED_HISTORY":
        JSON.stringify(publishedHistory),
      "import.meta.env.VITE_TRAJECTORY_REFERENCE_URL": JSON.stringify(
        referencePath ? "/" + referencePath : null,
      ),
    },
    plugins: [
      ...(referencePath
        ? [
            {
              name: "trajectory-references",
              async buildStart() {
                if (publishedHistory)
                  this.emitFile({
                    type: "asset",
                    fileName: referencePath,
                    source: await references(),
                  });
              },
              configureServer(server) {
                server.middlewares.use(async (req, res, next) => {
                  if (
                    req.url !== "/" + referencePath ||
                    !["GET", "HEAD"].includes(req.method)
                  )
                    return next();
                  try {
                    const bytes = gzipSync(await references());
                    res.setHeader("Content-Type", "application/json");
                    res.setHeader("Content-Encoding", "gzip");
                    res.setHeader("Content-Length", bytes.length);
                    res.setHeader("Cache-Control", "no-cache");
                    res.end(req.method === "HEAD" ? undefined : bytes);
                  } catch {
                    res.statusCode = 500;
                    res.end("Trajectory references could not be prepared");
                  }
                });
              },
            },
          ]
        : []),
      ...(localArchive
        ? [
            {
              name: "local-archive",
              configureServer(server) {
                server.middlewares.use(async (req, res, next) => {
                  if (!["GET", "HEAD"].includes(req.method)) return next();
                  const match = req.url?.match(
                    /^\/data\/(version\.json|[a-f0-9]{64}\.bin)$/,
                  );
                  if (!match) return next();
                  const path = join(directory, match[1]);
                  try {
                    const info = await stat(path);
                    if (!info.isFile()) return next();
                    res.setHeader(
                      "Content-Type",
                      match[1] === "version.json"
                        ? "application/json"
                        : "application/octet-stream",
                    );
                    res.setHeader("Cache-Control", "no-store");
                    res.setHeader("Content-Length", info.size);
                    if (req.method === "HEAD") return res.end();
                    const stream = createReadStream(path);
                    stream.on("error", () => res.destroy());
                    stream.pipe(res);
                  } catch {
                    res.statusCode = 404;
                    res.end("Local archive not found");
                  }
                });
              },
            },
          ]
        : []),
    ],
  };
});
