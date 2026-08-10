import { chmod, copyFile, mkdir, readFile } from "node:fs/promises";

const source = new URL("../src/cost/flash-prices-v1.toml", import.meta.url);
const targetDirectory = new URL("../dist/src/cost/", import.meta.url);
const target = new URL("flash-prices-v1.toml", targetDirectory);

await mkdir(targetDirectory, { recursive: true });
await copyFile(source, target);

const [sourceBytes, targetBytes] = await Promise.all([
  readFile(source),
  readFile(target),
]);
if (!sourceBytes.equals(targetBytes)) {
  throw new Error("runtime Flash price asset differs from its source bytes");
}

// package.json declares dist/src/cli.js as the `dsh` bin. clean-dist removes it
// on every build and tsc emits it without the exec bit, so a rebuilt tree would
// otherwise leave an installed `dsh` unrunnable until the next npm link.
const cli = new URL("../dist/src/cli.js", import.meta.url);
await chmod(cli, 0o755);
