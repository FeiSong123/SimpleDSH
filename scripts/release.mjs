#!/usr/bin/env node
// Build, verify, and pack the tarball that users install.
//
// The tarball is the release artifact because this package forbids lifecycle
// scripts — see the `prepare` check in check-package.mjs — so `npm i -g
// github:...` cannot build on the user's machine, and should not: running a
// build script during install is exactly the supply-chain shape this project
// refuses elsewhere. Publishing a prebuilt tarball keeps install to unpacking.

import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, rmSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const run = (command, args) =>
  execFileSync(command, args, { stdio: "inherit", encoding: "utf8" });
const capture = (command, args) => {
  try {
    return execFileSync(command, args, { encoding: "utf8" }).trim();
  } catch (error) {
    process.stderr.write(
      `\n${command} ${args.join(" ")} failed (${error.status}):\n${error.stderr ?? ""}\n`,
    );
    throw error;
  }
};

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const tag = `v${manifest.version}`;

run("npm", ["run", "check"]);

const outDir = "release";
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const packed = capture("npm", ["pack", "--silent"]);
const target = join(outDir, packed);
renameSync(packed, target);

// Prove the artifact installs and runs before anyone is told to trust it.
// Outside the repository: npm walks upwards looking for a package root, and
// installing inside our own tree makes it find this one.
const probe = mkdtempSync(join(tmpdir(), "flashcoder-release-"));
// Absolute: npm reads a bare relative path as a git remote, not a file.
run("npm", ["install", "-g", "--prefix", probe, resolve(target)]);
const usage = capture(join(probe, "bin", manifest.name), ["--help"]);
if (!usage.startsWith(`Usage: ${manifest.name}`)) {
  throw new Error("packed CLI does not run");
}
rmSync(probe, { recursive: true, force: true });

process.stdout.write(
  [
    `release: ${target}`,
    `tag: ${tag}`,
    "",
    "Publish it with:",
    `  gh release create ${tag} ${target} --title ${tag} --notes-file <notes>`,
    "",
    "Users then install with:",
    `  curl -fsSL https://github.com/Owen718/FlashCoder/releases/download/${tag}/${packed} -o ${packed}`,
    `  npm install -g ./${packed}`,
    "",
  ].join("\n"),
);
