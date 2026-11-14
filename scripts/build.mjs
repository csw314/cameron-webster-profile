import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "dist");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const item of ["index.html", "assets", "data", "projects"]) {
  await cp(path.join(root, item), path.join(output, item), { recursive: true });
}
console.log("Static site built in dist/. Predictions use the separately configured model API.");
