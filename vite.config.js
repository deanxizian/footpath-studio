import { defineConfig } from "vite";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export default defineConfig(({ command, mode }) => {
  const localArchive = command === "serve" && mode === "local-archive";
  const publishedHistory = command === "build" && mode === "public-history";
  return {
    // Only an explicitly fetched, owner-approved release can enter a history build.
    publicDir: publishedHistory ? "public-history" : false,
    define: {
      "import.meta.env.VITE_LOCAL_ARCHIVE": JSON.stringify(localArchive),
      "import.meta.env.VITE_PUBLISHED_HISTORY":
        JSON.stringify(publishedHistory),
    },
    plugins: localArchive
      ? [
          {
            name: "local-archive",
            configureServer(server) {
              const directory = fileURLToPath(
                new URL("./private-data/data/", import.meta.url),
              );
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
      : [],
  };
});
