import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareExplorerEntries,
  DEFAULT_EXPLORER_FILTER,
  explorerFilterToQuery,
  explorerFilterFromSearchParams,
  normalizeExplorerFilter,
} from "./explorer-filter.ts";

const entry = (name, isDir, modified = "") => ({ name, isDir, modified });

test("compareExplorerEntries: dirs first, then name asc (default)", () => {
  const list = [entry("b.txt", false), entry("a-dir", true), entry("a.txt", false)];
  const sorted = [...list].sort((a, b) => compareExplorerEntries(a, b, "name", "asc"));
  assert.deepEqual(sorted.map((e) => e.name), ["a-dir", "a.txt", "b.txt"]);
});

test("compareExplorerEntries: name desc reverses only inside groups", () => {
  const list = [entry("b.txt", false), entry("a-dir", true), entry("z-dir", true), entry("a.txt", false)];
  const sorted = [...list].sort((a, b) => compareExplorerEntries(a, b, "name", "desc"));
  assert.deepEqual(sorted.map((e) => e.name), ["z-dir", "a-dir", "b.txt", "a.txt"]);
});

test("compareExplorerEntries: modified desc puts newest first inside groups", () => {
  const list = [
    entry("old.txt", false, "2026-01-01T00:00:00.000Z"),
    entry("new.txt", false, "2026-08-09T00:00:00.000Z"),
    entry("new-dir", true, "2026-08-09T00:00:00.000Z"),
    entry("old-dir", true, "2026-01-01T00:00:00.000Z"),
  ];
  const sorted = [...list].sort((a, b) => compareExplorerEntries(a, b, "modified", "desc"));
  assert.deepEqual(sorted.map((e) => e.name), ["new-dir", "old-dir", "new.txt", "old.txt"]);
});

test("compareExplorerEntries: missing modified sorts last in asc, first in desc", () => {
  const list = [entry("no-ts.txt", false, ""), entry("with-ts.txt", false, "2026-08-09T00:00:00.000Z")];
  const asc = [...list].sort((a, b) => compareExplorerEntries(a, b, "modified", "asc"));
  assert.deepEqual(asc.map((e) => e.name), ["no-ts.txt", "with-ts.txt"]);
  const desc = [...list].sort((a, b) => compareExplorerEntries(a, b, "modified", "desc"));
  assert.deepEqual(desc.map((e) => e.name), ["with-ts.txt", "no-ts.txt"]);
});

test("default filter keeps name/asc; query round-trips sort params", () => {
  assert.equal(DEFAULT_EXPLORER_FILTER.hideGitIgnored, false);
  assert.equal(DEFAULT_EXPLORER_FILTER.sortBy, "name");
  assert.equal(DEFAULT_EXPLORER_FILTER.sortOrder, "asc");
  const q = explorerFilterToQuery({ ...DEFAULT_EXPLORER_FILTER, sortBy: "modified", sortOrder: "desc" });
  assert.ok(q.includes("sortBy=modified"));
  assert.ok(q.includes("sortOrder=desc"));
  assert.ok(q.includes("hideGitIgnored=0"));
  const roundTrip = explorerFilterFromSearchParams(new URLSearchParams(q.replace("hideGitIgnored=0", "hideGitIgnored=1")));
  assert.equal(roundTrip.hideGitIgnored, true);
});

test("normalizeExplorerFilter clamps invalid sort values", () => {
  const n = normalizeExplorerFilter({ sortBy: "bogus", sortOrder: "sideways" });
  assert.equal(n.sortBy, "name");
  assert.equal(n.sortOrder, "asc");
});
