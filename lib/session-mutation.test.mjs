import assert from "node:assert/strict";
import test from "node:test";
import { assertSessionMutationOk } from "./session-mutation.ts";
import { getLocalePlugin } from "./i18n/registry.ts";

test("preserves server mutation errors for the UI", async () => {
  await assert.rejects(
    () => assertSessionMutationOk({
      ok: false,
      status: 409,
      json: async () => ({ error: "Session was modified recently", code: "session_recently_modified" }),
    }),
    /Session was modified recently/,
  );
});

test("shows the Side Ask archive refusal in the interface language without hiding unknown errors", async () => {
  const previous = globalThis.document;
  const known = getLocalePlugin("zh-CN").messages["sessionActivity.sideAskPreventsArchive"];
  try {
    for (const locale of ["en", "zh-CN", "zh-TW"]) {
      globalThis.document = { documentElement: { lang: locale } };
      const response = { ok: false, status: 409, json: async () => ({ error: `Error: ${known}` }) };
      await assert.rejects(() => assertSessionMutationOk(response), (error) =>
        error.message === getLocalePlugin(locale).messages["sessionActivity.sideAskPreventsArchive"]);
    }
    const unknown = "custom remote error";
    await assert.rejects(() => assertSessionMutationOk({ ok: false, status: 409, json: async () => ({ error: unknown }) }),
      (error) => error.message === unknown);
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});

test("localizes child lifecycle refusal in the interface language", async () => {
  const previous = globalThis.document;
  try {
    for (const locale of ["en", "zh-CN", "zh-TW"]) {
      globalThis.document = { documentElement: { lang: locale } };
      await assert.rejects(
        () => assertSessionMutationOk({
          ok: false,
          status: 409,
          json: async () => ({ error: "child lifecycle", code: "session_child_lifecycle_requires_parent" }),
        }),
        (error) => error.message === getLocalePlugin(locale).messages["sessionActivity.subagentLifecycleRequiresParent"],
      );
    }
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});

test("accepts successful mutation responses without requiring JSON", async () => {
  await assert.doesNotReject(() => assertSessionMutationOk({ ok: true, status: 204 }));
});
