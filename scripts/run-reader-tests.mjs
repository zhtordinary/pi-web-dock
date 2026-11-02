import { spawnSync } from "node:child_process";
import { availableParallelism } from "node:os";
import { statSync } from "node:fs";
import { resolve } from "node:path";

const TEST_PATTERNS = [
  "app/**/*.test.mjs",
  "components/**/*.test.mjs",
  "hooks/**/*.test.mjs",
  "lib/**/*.test.mjs",
  "public/**/*.test.mjs",
  "scripts/**/*.test.mjs",
  "packages/**/*.test.mjs",
];
const DEFAULT_CONCURRENCY = String(Math.min(4, availableParallelism()));
const MAX_CONCURRENCY = 32;

function readConcurrency(value, source) {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${source} must be a positive integer`);
  }
  const concurrency = Number(value);
  if (!Number.isSafeInteger(concurrency) || concurrency > MAX_CONCURRENCY) {
    throw new Error(`${source} must be between 1 and ${MAX_CONCURRENCY}`);
  }
  return concurrency;
}

function resolveConcurrency(extraArgs) {
  let explicit;
  const passthrough = [];
  for (let index = 0; index < extraArgs.length; index += 1) {
    const argument = extraArgs[index];
    if (argument === "--test-concurrency") {
      const value = extraArgs[index + 1];
      if (value === undefined) {
        throw new Error("--test-concurrency requires a value");
      }
      explicit = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--test-concurrency=")) {
      explicit = argument.slice("--test-concurrency=".length);
      continue;
    }
    passthrough.push(argument);
  }
  const value = explicit ?? process.env.PI_READER_TEST_CONCURRENCY ?? DEFAULT_CONCURRENCY;
  return { concurrency: readConcurrency(value, "test concurrency"), passthrough };
}

const extraArgs = process.argv.slice(2);
const separator = extraArgs.indexOf("--");
const testFiles = separator < 0 ? TEST_PATTERNS : extraArgs.slice(separator + 1);
let resolved;
try {
  if (testFiles.length === 0) throw new Error("-- requires at least one test file");
  if (separator >= 0) {
    for (const file of testFiles) {
      if (!statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`Explicit test file does not exist: ${file}`);
    }
  }
  resolved = resolveConcurrency(separator < 0 ? extraArgs : extraArgs.slice(0, separator));
} catch (error) {
  console.error(`Reader test configuration error: ${error.message}`);
  process.exitCode = 2;
  process.exit();
}

// Node expands CLI test arguments as globs; parameter-route names must stay literal.
const patterns = separator < 0 ? testFiles : testFiles.map((file) => resolve(file).replace(/[*?\[\]{}()]/g, (char) => `[${char}]`));
const child = spawnSync(process.execPath, [
  "--experimental-strip-types",
  "--test",
  `--test-concurrency=${resolved.concurrency}`,
  ...resolved.passthrough,
  "--",
  ...patterns,
], { stdio: "inherit" });

if (child.error) {
  console.error(`Reader test runner failed to start: ${child.error.message}`);
  process.exitCode = 1;
} else if (child.signal) {
  process.kill(process.pid, child.signal);
} else {
  process.exitCode = child.status ?? 1;
}
