#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const enginePath = fs.existsSync(path.join(__dirname, "genai-prices-engine.cjs"))
  ? path.join(__dirname, "genai-prices-engine.cjs")
  : path.join(__dirname, "engine.cjs");
const { priceJsonRecord, state, refreshPriceData } = require(enginePath);

function readInput() {
  const input = process.argv[2] && process.argv[2] !== "-"
    ? fs.readFileSync(process.argv[2], "utf8")
    : fs.readFileSync(0, "utf8");
  return JSON.parse(input);
}

async function main() {
  const command = process.argv[2];
  if (command === "state") {
    process.stdout.write(`${JSON.stringify(state())}\n`);
    return;
  }
  if (command === "refresh") {
    const refreshed = await refreshPriceData();
    process.stdout.write(`${JSON.stringify(refreshed)}\n`);
    return;
  }
  const payload = readInput();
  const records = Array.isArray(payload) ? payload : [payload];
  process.stdout.write(`${JSON.stringify(records.map(priceJsonRecord))}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
