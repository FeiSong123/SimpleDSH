import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const arguments_ = process.argv.slice(2);
const firstOption = arguments_.findIndex((value) => value.startsWith("-"));
const relativeDirectories = arguments_.slice(
  0,
  firstOption < 0 ? arguments_.length : firstOption,
);
const nodeOptions = firstOption < 0 ? [] : arguments_.slice(firstOption);
if (
  relativeDirectories.length === 0 ||
  relativeDirectories.some((value) => value.length === 0)
) {
  process.stderr.write("run-node-tests: missing compiled test directory\n");
  process.exitCode = 2;
} else {
  const testFiles = relativeDirectories.flatMap((relativeDirectory) => {
    const directory = resolve(relativeDirectory);
    return readdirSync(directory)
      .filter((name) => name.endsWith(".test.js"))
      .sort()
      .map((name) => resolve(directory, name));
  });
  if (testFiles.length === 0) {
    process.stderr.write("run-node-tests: no compiled tests found\n");
    process.exitCode = 2;
  } else {
    const hasNamePattern = nodeOptions.some((option) =>
      option.startsWith("--test-name-pattern="),
    );
    const result = spawnSync(
      process.execPath,
      [
        "--test",
        ...(hasNamePattern ? ["--test-reporter=tap"] : []),
        ...nodeOptions,
        ...testFiles,
      ],
      hasNamePattern
        ? { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
        : { stdio: "inherit" },
    );
    if (result.error !== undefined) throw result.error;
    if (hasNamePattern) {
      process.stdout.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
      const fileNames = new Set(testFiles);
      const subtestNames = Array.from(
        (result.stdout ?? "").matchAll(/^# Subtest: (.+)$/gmu),
        (match) => match[1],
      );
      const matchedRealTest = subtestNames.some(
        (name) => name !== undefined && !fileNames.has(name),
      );
      if (result.status === 0 && !matchedRealTest) {
        process.stderr.write(
          "run-node-tests: test-name-pattern matched no real test\n",
        );
        process.exitCode = 2;
      } else {
        process.exitCode = result.status ?? 1;
      }
    } else {
      process.exitCode = result.status ?? 1;
    }
  }
}
