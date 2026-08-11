import { spawnSync } from "node:child_process";
import {
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { lstatIfPresent } from "./env-metadata.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function fail(message) {
  failures.push(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(projectRoot, path), "utf8"));
}

function filesWithSuffix(relativeDirectory, suffix) {
  const entries = readdirSync(resolve(projectRoot, relativeDirectory), {
    withFileTypes: true,
  });
  return entries.flatMap((entry) => {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    return entry.isDirectory()
      ? filesWithSuffix(relativePath, suffix)
      : entry.isFile() && entry.name.endsWith(suffix)
        ? [relativePath]
        : [];
  });
}

function sameRecord(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} must equal ${JSON.stringify(expected)}`);
  }
}

const manifest = readJson("package.json");
const shrinkwrap = readJson("npm-shrinkwrap.json");

const expectedDependencies = {
  "get-east-asian-width": "1.6.0",
  marked: "18.0.5",
  "smol-toml": "1.7.1",
};
const expectedDevDependencies = {
  "@types/node": "22.20.1",
  typescript: "6.0.3",
};
const expectedBlockedScripts = {
  "test:security": "Stage 08",
  "test:release": "Stage 12",
};
const expectedReadyScripts = {
  "test:protocol":
    "npm run build --silent && node scripts/run-node-tests.mjs dist/test/protocol",
  "test:journal":
    "npm run build --silent && node scripts/run-node-tests.mjs dist/test/journal",
  "test:context":
    "npm run build --silent && node scripts/run-node-tests.mjs dist/test/context",
  "test:effects":
    "npm run build --silent && node scripts/run-node-tests.mjs dist/test/effects",
  "test:session":
    "npm run build --silent && node scripts/run-node-tests.mjs dist/test/session dist/test/cli",
  "test:recovery":
    "npm run build --silent && node scripts/run-node-tests.mjs dist/test/recovery dist/test/cost",
  "test:acceptance": "node test/tasks/run.mjs --check",
  "test:live:protocol":
    "npm run build --silent && node --test dist/test/live/protocol.test.js",
  "test:live:acceptance": "npm run build --silent && node test/tasks/run.mjs",
};

if (manifest.name !== "simpledsh") fail("package name must be simpledsh");
if (manifest.version !== "0.1.0-rc.0") fail("bootstrap version must be 0.1.0-rc.0");
if (manifest.private !== true) fail("bootstrap package must remain private");
if (manifest.type !== "module") fail("package type must be module");
if (manifest.license !== "UNLICENSED") fail("bootstrap license must be UNLICENSED");
if (manifest.engines?.node !== ">=22") fail("Node engine floor must be >=22");
if (manifest.bin?.simpledsh !== "dist/src/cli.js") fail("simpledsh bin path is not canonical");
sameRecord(
  manifest.files,
  ["dist/src/", "README.md", "LICENSE.pi"],
  "package files",
);
sameRecord(manifest.dependencies, expectedDependencies, "runtime dependencies");
sameRecord(manifest.devDependencies, expectedDevDependencies, "dev dependencies");

for (const [script, stage] of Object.entries(expectedBlockedScripts)) {
  const expected = `node scripts/blocked-stage.mjs \"${stage}\"`;
  if (manifest.scripts?.[script] !== expected) {
    fail(`${script} must fail through ${stage}`);
  }
}
for (const [script, command] of Object.entries(expectedReadyScripts)) {
  if (manifest.scripts?.[script] !== command) {
    fail(`${script} must equal ${command}`);
  }
}

for (const retired of [
  "test:live:cache",
  "test:diagnostic:cache-v10",
  "test:live:pi-baseline",
  "test:live:pi-baseline-v2",
  "test:diagnostic:pi-cold-start",
]) {
  if (manifest.scripts?.[retired] !== undefined) {
    fail(`retired acceptance entrypoint must be absent: ${retired}`);
  }
}

for (const lifecycle of [
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepack",
  "postpack",
]) {
  if (manifest.scripts?.[lifecycle] !== undefined) {
    fail(`root lifecycle script is forbidden: ${lifecycle}`);
  }
}

if (shrinkwrap.lockfileVersion !== 3) fail("npm shrinkwrap lockfileVersion must be 3");
if (shrinkwrap.name !== manifest.name || shrinkwrap.version !== manifest.version) {
  fail("shrinkwrap root identity must match package.json");
}
sameRecord(
  shrinkwrap.packages?.[""]?.dependencies,
  expectedDependencies,
  "shrinkwrap runtime dependencies",
);
sameRecord(
  shrinkwrap.packages?.[""]?.devDependencies,
  expectedDevDependencies,
  "shrinkwrap dev dependencies",
);

const installedEntries = Object.entries(shrinkwrap.packages ?? {}).filter(
  ([path]) => path.startsWith("node_modules/"),
);
// Raised from 4 to 6 on 2026-08-10 for the ported TUI: get-east-asian-width
// (terminal cell width) and marked (markdown). Still a ratchet — it may only
// go down from here.
const dependencyCountBaseline = 6;
if (installedEntries.length > dependencyCountBaseline) {
  fail(
    `dependency count ${installedEntries.length} exceeds ratchet ${dependencyCountBaseline}`,
  );
}
for (const [path, entry] of installedEntries) {
  if (entry.hasInstallScript === true) fail(`${path} has an install lifecycle script`);
  if (typeof entry.integrity !== "string" || !entry.integrity.startsWith("sha512-")) {
    fail(`${path} lacks a sha512 registry integrity`);
  }
  if (typeof entry.resolved !== "string" || !entry.resolved.startsWith("https://")) {
    fail(`${path} lacks an HTTPS registry resolution`);
  }
}

const gitignore = readFileSync(resolve(projectRoot, ".gitignore"), "utf8");
for (const line of [
  ".env",
  ".env.*",
  "!.env.example",
  ".dsh/",
  "node_modules/",
  "dist/",
  "*.tgz",
]) {
  if (!gitignore.split("\n").includes(line)) fail(`.gitignore missing ${line}`);
}

const envExample = readFileSync(resolve(projectRoot, ".env.example"), "utf8");
if (envExample !== "DEEPSEEK_API_KEY=\n") {
  fail(".env.example must be the value-free canonical template");
}

const sourceInventory = filesWithSuffix("src", ".ts");
const jsonParseAllowlist = new Set([
  "src/bytes/tool-result.ts",
  "src/bytes/view.ts",
  "src/ds/sse.ts",
  // Provider-visible Responses API parsing for the official web search tool.
  // Read-only, invariant-shape extraction of the search response, same class
  // of site as src/ds/sse.ts.
  "src/ds/web-search.ts",
  "src/journal/recovery.ts",
  "src/journal/schema.ts",
  "src/bytes/tool-arguments.ts",
  "src/session/reconcile.ts",
  // Display only: reads one field out of a tool call to label a line. The exact
  // argument bytes stay frozen in the assistant blob and are never rebuilt from
  // this, which is what the rule protects.
  "src/cli/transcript.ts",
]);
const httpsRequestImportAllowlist = new Set(["src/ds/transport.ts"]);
for (const path of sourceInventory) {
  const source = readFileSync(resolve(projectRoot, path), "utf8");
  if (/JSON\.parse\s*\(/u.test(source) && !jsonParseAllowlist.has(path)) {
    fail(`JSON.parse is outside an approved read-only/invariant path: ${path}`);
  }
  if (/\bfetch\s*\(/u.test(source)) {
    fail(`global fetch is forbidden in the DeepSeek-native runtime: ${path}`);
  }
  if (
    /import\s*\{[^}]*\brequest\s+as\s+httpsRequest\b[^}]*\}\s*from\s*["']node:https["']/su.test(source) &&
    !httpsRequestImportAllowlist.has(path)
  ) {
    fail(`official node:https request import is outside transport: ${path}`);
  }
  if (/\b(?:Provider|Backend)(?:Factory|Registry|Router|Adapter)\b/u.test(source)) {
    fail(`provider abstraction is forbidden: ${path}`);
  }
  if (
    !path.startsWith("src/tool/") &&
    !path.startsWith("src/session/") &&
    /\.{2}\/tool\//u.test(source)
  ) {
    fail(`only session may depend on the upper tool layer: ${path}`);
  }
}

const transportSource = readFileSync(
  resolve(projectRoot, "src/ds/transport.ts"),
  "utf8",
);
if (
  !/import\s*\{[^}]*\brequest\s+as\s+httpsRequest\b[^}]*\}\s*from\s*["']node:https["']/su.test(
    transportSource,
  )
) {
  fail("Stage 06 official transport must value-import node:https request");
}
if (!/export function runDeepSeekOfficialWithRetry\s*\(/u.test(transportSource)) {
  fail("Stage 06 official transport entry is missing");
}

const runtimeNetworkModules = [
  "http",
  "https",
  "http2",
  "net",
  "tls",
  "dgram",
  "dns",
  "dns/promises",
].flatMap((name) => [name, `node:${name}`]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function runtimeNetworkReferences(source) {
  const references = [];
  for (const moduleName of runtimeNetworkModules) {
    const literal = `["']${escapeRegExp(moduleName)}["']`;
    const patterns = [
      [
        "static",
        new RegExp(
          `\\b(?:import|export)\\s+(?:(?!;).)*?\\bfrom\\s*${literal}`,
          "gsu",
        ),
      ],
      ["side-effect", new RegExp(`\\bimport\\s*${literal}`, "gu")],
      ["dynamic", new RegExp(`\\bimport\\s*\\(\\s*${literal}\\s*\\)`, "gu")],
      ["require", new RegExp(`\\brequire\\s*\\(\\s*${literal}\\s*\\)`, "gu")],
    ];
    for (const [kind, pattern] of patterns) {
      for (const match of source.matchAll(pattern)) {
        references.push({ kind, moduleName, text: match[0] });
      }
    }
  }
  return references;
}

const networkReferenceFixtures = [
  ["namespace import", 'import * as https from "node:https";'],
  ["alternate alias", 'import { request as send } from "https";'],
  ["side-effect import", 'import "node:net";'],
  ["dynamic import", 'await import("node:tls");'],
  ["direct require", 'const dns = require("dns/promises");'],
  ["re-export", 'export { connect } from "node:net";'],
];
for (const [label, fixture] of networkReferenceFixtures) {
  if (runtimeNetworkReferences(fixture).length !== 1) {
    fail(`built runtime network-import checker misses ${label} fixture`);
  }
}
for (const fixture of [
  'const label = "node:https";',
  'const value = importValue("node:net");',
]) {
  if (runtimeNetworkReferences(fixture).length !== 0) {
    fail("built runtime network-import checker rejects a non-import fixture");
  }
}

const builtSourceInventory = filesWithSuffix("dist/src", ".js");
let allowedBuiltNetworkImports = 0;
for (const path of builtSourceInventory) {
  const source = readFileSync(resolve(projectRoot, path), "utf8");
  const references = runtimeNetworkReferences(source);
  for (const reference of references) {
    const isOfficialTransportImport =
      path === "dist/src/ds/transport.js" &&
      reference.kind === "static" &&
      reference.moduleName === "node:https" &&
      reference.text ===
        'import { request as httpsRequest, } from "node:https"';
    if (isOfficialTransportImport) {
      allowedBuiltNetworkImports += 1;
    } else {
      fail(
        `runtime network import ${reference.moduleName} is outside the exact built transport boundary: ${path}`,
      );
    }
  }
  if (/\bfetch\s*\(/u.test(source)) {
    fail(`global fetch is forbidden in built production runtime: ${path}`);
  }
  if (/\b(?:new\s+)?(?:WebSocket|EventSource)\s*\(/u.test(source)) {
    fail(`global streaming network primitive is forbidden in built production runtime: ${path}`);
  }
}
if (allowedBuiltNetworkImports !== 1) {
  fail(
    `built production runtime must contain exactly one official transport network import; found ${allowedBuiltNetworkImports}`,
  );
}

const sourcePriceBook = readFileSync(
  resolve(projectRoot, "src/cost/flash-prices-v1.toml"),
);
const builtPriceBook = readFileSync(
  resolve(projectRoot, "dist/src/cost/flash-prices-v1.toml"),
);
if (!sourcePriceBook.equals(builtPriceBook)) {
  fail("built Flash price book must be byte-identical to its dated source asset");
}

const forbiddenBashRuntimePatterns = [
  [/\blimactl\b/iu, "Lima control path"],
  [/\bnerdctl\b/iu, "nerdctl runtime path"],
  [/\bcontainerd\b/iu, "containerd runtime path"],
  [/\brunc\b/iu, "runc runtime path"],
  [/\brootlesskit\b/iu, "RootlessKit runtime path"],
  [/\bAdmittedBash\w*/u, "admitted bash capability"],
  [/\bCredentialShield\w*/u, "Credential Shield capability"],
  [/\bDescendantSupervisor\w*/u, "descendant supervisor capability"],
  [/alpine@sha256/iu, "pinned bash image"],
  [/external-required/iu, "external runtime capability state"],
];
for (const path of sourceInventory) {
  const source = readFileSync(resolve(projectRoot, path), "utf8");
  for (const [pattern, label] of forbiddenBashRuntimePatterns) {
    if (pattern.test(source)) fail(`${label} is forbidden in production source: ${path}`);
  }
}

// The ported TUI probes terminal capabilities from the environment. That is not
// credential access, but the exemption is a fixed allowlist rather than a blanket
// pass for the directory: reading anything else there still fails.
const terminalEnvironmentNames = new Set([
  "COLORTERM", "GHOSTTY_RESOURCES_DIR", "ITERM_SESSION_ID", "KITTY_WINDOW_ID",
  "LC_ALL", "LC_CTYPE", "LANG", "PI_HARDWARE_CURSOR", "TERM", "TERMINAL_EMULATOR",
  "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TMUX", "VTE_VERSION", "WARP_SESSION_ID",
  "WARP_TERMINAL_SESSION_UUID", "WEZTERM_PANE", "WT_SESSION", "SSH_TTY", "NO_COLOR",
  "FORCE_COLOR", "CI", "TERMUX_VERSION",
  // Pi's own debug switches. Harmless, and kept verbatim so the port stays a
  // faithful copy that upstream diffs still apply to.
  "PI_DEBUG_REDRAW", "PI_TUI_DEBUG", "PI_CLEAR_ON_SHRINK", "PI_CODING_AGENT_DIR",
  "PI_TUI_WRITE_LOG", "COLUMNS", "LINES", "SSH_CLIENT", "SSH_CONNECTION",
]);

function environmentNamesRead(source) {
  const names = new Set();
  for (const match of source.matchAll(/process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*"([^"]+)"\s*\])/gu)) {
    names.add(match[1] ?? match[2]);
  }
  return names;
}

for (const path of sourceInventory) {
  if (path === "src/ds/credential.ts") continue;
  const source = readFileSync(resolve(projectRoot, path), "utf8");
  // The interactive layer also probes terminal capabilities; hold it to the
  // same allowlist rather than exempting it.
  if (
    path.startsWith("src/tui/") ||
    path === "src/cli/theme.ts" ||
    path === "src/cli/banner.ts"
  ) {
    if (/readFileSync\([^\n]*\.env/u.test(source)) {
      fail(`terminal layer must not read .env: ${path}`);
    }
    for (const name of environmentNamesRead(source)) {
      if (!terminalEnvironmentNames.has(name)) {
        fail(`terminal layer reads a non-terminal environment variable ${name}: ${path}`);
      }
    }
    continue;
  }
  if (/process\.env|readFileSync\([^\n]*\.env/u.test(source)) {
    fail(`credential source access is outside CredentialLoader: ${path}`);
  }
}

const envPath = resolve(projectRoot, ".env");
const envInfo = lstatIfPresent(envPath);
if (envInfo !== undefined) {
  if (envInfo.isSymbolicLink() || !envInfo.isFile()) {
    fail(".env must be a regular non-symlink file");
  }
  if ((envInfo.mode & 0o777) !== 0o600) fail(".env mode must be 0600");
}
const ignored = spawnSync("git", ["check-ignore", "--quiet", "--no-index", ".env"], {
  cwd: projectRoot,
  stdio: "ignore",
});
if (ignored.status !== 0) fail(".env must be ignored by Git");
const tracked = spawnSync("git", ["ls-files", "--error-unmatch", ".env"], {
  cwd: projectRoot,
  stdio: "ignore",
});
if (tracked.status === 0) fail(".env must not be tracked by Git");
if (tracked.status !== 0 && tracked.status !== 1) {
  fail("cannot determine whether .env is tracked by Git");
}

const packed = spawnSync(
  "npm",
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  { cwd: projectRoot, encoding: "utf8" },
);
if (packed.error !== undefined || packed.status !== 0) {
  fail(`npm pack --dry-run failed: ${packed.stderr.trim()}`);
} else {
  try {
    const result = JSON.parse(packed.stdout);
    // npm 12 reports --json as an object keyed by package name; older npm
    // reported an array. Accept both shapes without weakening the assertions.
    const entries = Array.isArray(result) ? result : Object.values(result);
    const paths = entries[0]?.files?.map((file) => file.path) ?? [];
    for (const required of [
      "package.json",
      "dist/src/cli.js",
      "dist/src/cost/flash-prices-v1.toml",
      "README.md",
      "LICENSE.pi",
    ]) {
      if (!paths.includes(required)) fail(`packed files missing ${required}`);
    }
    for (const path of paths) {
      if (
        path === ".env" ||
        path.startsWith(".env.") ||
        path.startsWith(".dsh/") ||
        path.startsWith("node_modules/") ||
        path.startsWith("src/") ||
        path.startsWith("test/") ||
        path.startsWith("scripts/")
      ) {
        fail(`forbidden packed path: ${path}`);
      }
    }
  } catch (error) {
    fail(`cannot parse npm pack JSON: ${String(error)}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`check-package: ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `check-package: ok dependencies=${installedEntries.length} lifecycle=0\n`,
  );
}
