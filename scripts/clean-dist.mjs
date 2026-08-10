import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = resolve(repositoryRoot, "dist");
if (dirname(distRoot) !== repositoryRoot || distRoot === repositoryRoot) {
  throw new Error("refusing to clean an unexpected build-output path");
}
await rm(distRoot, { recursive: true, force: true });
