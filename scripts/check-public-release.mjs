import { readdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { verifyHistory } from "./history-files.mjs";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "dist");
const history = process.argv.includes("--history");
const entries = await readdir(dist, { withFileTypes: true });
const allowed = new Set(["index.html", "assets", ...(history ? ["data"] : [])]);
if (entries.some((entry) => !allowed.has(entry.name) || entry.isSymbolicLink()))
  throw new Error("Unexpected file in public build");
if (!entries.some((entry) => entry.name === "index.html"))
  throw new Error("Missing app entry point");
if (history)
  await verifyHistory(
    join(dist, "data"),
    JSON.parse(
      await readFile(join(root, ".cache/published-history.json"), "utf8"),
    ),
  );
let tracked = [];
try {
  tracked = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
    .split("\0")
    .filter(Boolean);
} catch {}
const prohibited =
  /(^|\/)(?:private-data|public-history|sync-state|\.cache|\.vercel|node_modules|dist)(\/|$)|(^|\/)\.env(?:\.|$)|\.(?:bin|tar|gz|key|pem)$|(?:session|cookies|storage-state).*\.json$/i;
if (tracked.some((path) => prohibited.test(path)))
  throw new Error(
    "Local data or credentials must not enter the source repository",
  );
console.log(
  `Public build verified (${history ? "verified monthly Release snapshot" : "synthetic demo"}).`,
);
