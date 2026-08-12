import { inspect } from "node:util";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

declare const credentialBrand: unique symbol;

export interface DeepSeekCredential {
  readonly [credentialBrand]: "DeepSeekCredential";
}

export type CredentialErrorCode =
  | "missing"
  | "invalid"
  | "unsafe_file"
  | "tracked_file";

export class CredentialError extends Error {
  constructor(
    readonly code: CredentialErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CredentialError";
  }
}

export interface CredentialLoadOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly projectRoot?: string;
}

export type DeepSeekCredentialState = Readonly<{
  readonly credential: DeepSeekCredential | null;
  readonly credentialPresent: boolean;
  readonly loadedEnvironmentNames:
    | readonly []
    | readonly ["DEEPSEEK_API_KEY"];
  readonly canonicalEnvPath: string;
}>;

const secrets = new WeakMap<object, string>();

function credentialGitEnvironment(projectRoot: string): NodeJS.ProcessEnv {
  const inheritedPath = process.env["PATH"];
  const path = inheritedPath !== undefined && !inheritedPath.includes("\0")
    ? inheritedPath
    : ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"].join(delimiter);
  const environment = Object.assign(Object.create(null) as NodeJS.ProcessEnv, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    HOME: projectRoot,
    LANG: "C",
    LC_ALL: "C",
    NO_COLOR: "1",
    PATH: path,
  });
  if (process.platform === "win32") {
    for (const name of ["ComSpec", "PATHEXT", "SystemRoot", "TEMP", "TMP"] as const) {
      const value = process.env[name];
      if (value !== undefined && !value.includes("\0")) environment[name] = value;
    }
  }
  return Object.freeze(environment);
}

/** Wrap a validated secret. The value stays in a module-private WeakMap. */
export function credentialFromSecret(secret: string): DeepSeekCredential {
  return createCredential(validateSecret(secret));
}

function createCredential(secret: string): DeepSeekCredential {
  const credential = Object.freeze({
    toString: () => "[DeepSeekCredential REDACTED]",
    toJSON: () => "[DeepSeekCredential REDACTED]",
    [inspect.custom]: () => "[DeepSeekCredential REDACTED]",
  }) as unknown as DeepSeekCredential;
  secrets.set(credential, secret);
  return credential;
}

function validateSecret(value: string): string {
  if (value.length === 0 || !/^[\x21-\x7e]+$/u.test(value)) {
    throw new CredentialError("invalid", "DEEPSEEK_API_KEY is empty or malformed");
  }
  return value;
}

function parseEnvFile(contents: string): string {
  let found: string | undefined;
  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = /^DEEPSEEK_API_KEY=(.*)$/u.exec(line);
    if (match === null) continue;
    if (found !== undefined) {
      throw new CredentialError("invalid", "DEEPSEEK_API_KEY is duplicated");
    }
    let value = match[1] ?? "";
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    found = validateSecret(value);
  }
  if (found === undefined) {
    throw new CredentialError("missing", "DEEPSEEK_API_KEY is missing");
  }
  return found;
}

function rejectTrackedEnv(projectRoot: string): void {
  const tracked = spawnSync(
    "git",
    ["-C", projectRoot, "ls-files", "--error-unmatch", "--", ".env"],
    { env: credentialGitEnvironment(projectRoot), stdio: "ignore" },
  );
  if (tracked.status === 0) {
    throw new CredentialError("tracked_file", ".env must not be tracked by Git");
  }
  if (tracked.error !== undefined) {
    throw new CredentialError("unsafe_file", "cannot determine whether .env is tracked");
  }
  const ignored = spawnSync(
    "git",
    ["-C", projectRoot, "check-ignore", "--quiet", "--no-index", "--", ".env"],
    { env: credentialGitEnvironment(projectRoot), stdio: "ignore" },
  );
  if (ignored.status === 1) {
    throw new CredentialError("tracked_file", ".env must be ignored by Git");
  }
  if (ignored.status !== 0) {
    throw new CredentialError("unsafe_file", "cannot determine whether .env is ignored");
  }
}

function inspectEnvFile(
  projectRoot: string,
  readCredential: boolean,
): Readonly<{
  readonly path: string;
  readonly secret: string | undefined;
}> {
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(resolve(projectRoot));
  } catch (error) {
    throw new CredentialError("unsafe_file", "cannot resolve the project root safely");
  }
  const envPath = join(canonicalRoot, ".env");
  let metadata: Stats;
  try {
    metadata = lstatSync(envPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return Object.freeze({ path: envPath, secret: undefined });
    }
    throw new CredentialError("unsafe_file", "cannot inspect .env safely");
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    (metadata.mode & 0o777) !== 0o600
  ) {
    throw new CredentialError(
      "unsafe_file",
      ".env must be a regular non-symlink mode-0600 file",
    );
  }
  rejectTrackedEnv(canonicalRoot);

  let descriptor: number | undefined;
  try {
    descriptor = openSync(envPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino ||
      (opened.mode & 0o777) !== 0o600 ||
      opened.size !== metadata.size
    ) {
      throw new CredentialError("unsafe_file", ".env changed during validation");
    }
    const secret = readCredential
      ? parseEnvFile(readFileSync(descriptor, "utf8"))
      : undefined;
    const after = fstatSync(descriptor);
    if (
      !after.isFile() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      (after.mode & 0o777) !== 0o600 ||
      after.size !== opened.size
    ) {
      throw new CredentialError("unsafe_file", ".env changed while open");
    }
    return Object.freeze({ path: envPath, secret });
  } catch (error) {
    if (error instanceof CredentialError) throw error;
    throw new CredentialError("unsafe_file", "cannot read .env safely");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}


/** Where `flashcoder login` stores the key, outside any repository. */
export function userCredentialPath(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const home = environment["HOME"];
  if (home === undefined || home.length === 0) {
    throw new CredentialError("missing", "HOME is not set");
  }
  return join(home, ".config", "flashcoder", "credentials");
}

/**
 * Where the key was stored while this was called SimpleDSH.
 *
 * Read-only, and only when the current path holds nothing: an upgrade should
 * not make someone log in again, and it should not silently keep writing to a
 * directory named after another project's command either.
 */
export function legacyUserCredentialPath(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const home = environment["HOME"];
  if (home === undefined || home.length === 0) return null;
  return join(home, ".config", "dsh", "credentials");
}

/**
 * Read the user-level credentials file with the same strictness as `.env`:
 * regular non-symlink file, mode 0600, unchanged across the open.
 *
 * It lives outside the repository, so the Git-tracking check does not apply.
 */
function readUserCredential(path: string): string | undefined {
  let metadata: Stats;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new CredentialError("unsafe_file", "cannot inspect the credentials file");
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    (metadata.mode & 0o777) !== 0o600
  ) {
    throw new CredentialError(
      "unsafe_file",
      "credentials must be a regular non-symlink mode-0600 file",
    );
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino ||
      (opened.mode & 0o777) !== 0o600
    ) {
      throw new CredentialError("unsafe_file", "credentials changed during validation");
    }
    return parseEnvFile(readFileSync(descriptor, "utf8"));
  } catch (error) {
    if (error instanceof CredentialError) throw error;
    throw new CredentialError("unsafe_file", "cannot read credentials safely");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function loadDeepSeekCredentialState(
  options: CredentialLoadOptions = {},
): DeepSeekCredentialState {
  const environment = options.environment ?? process.env;
  const inherited = environment["DEEPSEEK_API_KEY"];
  const inheritedSecret =
    inherited === undefined || inherited.length === 0
      ? undefined
      : validateSecret(inherited);
  const inspected = inspectEnvFile(
    options.projectRoot ?? process.cwd(),
    inheritedSecret === undefined,
  );
  // Precedence: process environment, then the repository .env, then the
  // user-level file written by `flashcoder login`.
  let secret = inheritedSecret ?? inspected.secret;
  if (secret === undefined) {
    secret = readUserCredential(userCredentialPath(environment));
  }
  if (secret === undefined) {
    // Written under the old name. Read but never written, so `logout` and the
    // next `login` move the key across on their own.
    const legacy = legacyUserCredentialPath(environment);
    if (legacy !== null) secret = readUserCredential(legacy);
  }
  const credential = secret === undefined ? null : createCredential(secret);
  return Object.freeze({
    credential,
    credentialPresent: credential !== null,
    loadedEnvironmentNames: credential === null
      ? Object.freeze([] as const)
      : Object.freeze(["DEEPSEEK_API_KEY"] as const),
    canonicalEnvPath: inspected.path,
  });
}

export function loadDeepSeekCredential(
  options: CredentialLoadOptions = {},
): DeepSeekCredential {
  const state = loadDeepSeekCredentialState(options);
  if (state.credential === null) {
    throw new CredentialError("missing", "DEEPSEEK_API_KEY is missing");
  }
  return state.credential;
}

export function authorizationHeaderForDeepSeekTransport(
  credential: DeepSeekCredential,
): string {
  const secret = secrets.get(credential);
  if (secret === undefined) {
    throw new CredentialError("invalid", "invalid DeepSeek credential handle");
  }
  return `Bearer ${secret}`;
}

export function redactDeepSeekHeaders(
  headers: Readonly<Record<string, string | number | readonly string[] | undefined>>,
): Readonly<Record<string, string | number | readonly string[]>> {
  const redacted: Record<string, string | number | readonly string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    redacted[name] = name.toLowerCase() === "authorization" ? "[REDACTED]" : value;
  }
  return Object.freeze(redacted);
}
