import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
const require=createRequire(import.meta.url); const lock=require("./session-wait-lock.cjs");
test("Darwin start identity prevents PID reuse while missing ps identity fails safe", () => { const runPs=(_cmd,args)=> args.includes("42") ? "Mon Sep 30 10:00:00 2026\n" : "Mon Sep 30 10:01:00 2026\n"; const token=lock.startIdentity(42,"darwin",runPs); assert.equal(token,"darwin:Mon Sep 30 10:00:00 2026"); assert.equal(lock.startIdentity(42,"darwin",runPs),token); assert.notEqual(token,"darwin:Mon Sep 30 10:01:00 2026"); assert.equal(lock.startIdentity(42,"darwin",()=>{throw new Error("missing")}),null); });
