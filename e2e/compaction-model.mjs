import assert from "node:assert/strict";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const locales = {
  en: (await jiti.import("../lib/i18n/messages/en.ts")).enLocale,
  "zh-CN": (await jiti.import("../lib/i18n/messages/zh-CN.ts")).zhCNLocale,
  "zh-TW": (await jiti.import("../lib/i18n/messages/zh-TW.ts")).zhTWLocale,
};

export async function checkCompactionModelSettings(page, artifacts) {
  const viewport = page.viewportSize();
  const locale = await page.evaluate(() => localStorage.getItem("pi-locale") ?? "en");
  const t = (key) => (locales[locale] ?? locales.en).messages[key];
  const originalTheme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  const writes = [], thinkingWrites = [], pluginWrites = [];
  let model = null, thinkingLevel = null;
  const provider = "fixture-provider";
  let plugins = [
    { id: "fixture-recap", label: "Recap", revision: "1", model: null, thinking: "low", thinkingAutoBehavior: "session", thinkingOptions: ["auto", "off", "low", "high"] },
    { id: "fixture-suggester", label: "Suggester", revision: "1", model: null, thinking: "session-default", thinkingAutoBehavior: "model", thinkingOptions: ["session-default", "auto", "off", "low", "high"] },
  ];
  const route = async (request) => {
    if (request.request().method() === "PUT") {
      const body = request.request().postDataJSON();
      model = body.model; thinkingLevel = body.thinkingLevel;
      writes.push(model); thinkingWrites.push(body);
      return request.fulfill({ json: { model, thinkingLevel } });
    }
    return request.fulfill({ json: { model, thinkingLevel, models: [
      { provider, modelId: "compressor", name: "Fixture compressor", contextWindow: 128000, thinkingLevels: ["off", "low", "high", "xhigh", "max"], thinkingLevelMap: { xhigh: "high", max: "max" } },
      { provider, modelId: "second", name: "Fixture second", contextWindow: 64000, thinkingLevels: ["off", "low", "high", "xhigh", "max"], thinkingLevelMap: { xhigh: "high", max: "max" } },
      { provider, modelId: "limited", name: "Limited model", contextWindow: 64000, thinkingLevels: ["off", "low"], thinkingLevelMap: { max: null } },
    ] } });
  };
  const pluginRoute = async (request) => {
    if (request.request().method() === "PUT") {
      const body = request.request().postDataJSON();
      pluginWrites.push(body);
      plugins = plugins.map((row) => row.id === body.id ? { ...row, ...("model" in body ? { model: body.model } : {}),
        ...("thinking" in body ? { thinking: body.thinking } : {}), revision: String(Number(row.revision) + 1) } : row);
      return request.fulfill({ json: { row: plugins.find((row) => row.id === body.id) } });
    }
    return request.fulfill({ json: { rows: plugins } });
  };
  await page.route("**/api/compaction-model", route);
  await page.route("**/api/plugin-models", pluginRoute);
  try {
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const sidebar = page.getByRole("button", { name: t("sidebar.show"), exact: true });
      if (await sidebar.isVisible()) await sidebar.click();
      await page.getByRole("button", { name: t("common.models"), exact: true }).first().click();
      const settings = page.getByRole("dialog", { name: t("settings.title"), exact: true });
      await settings.getByRole("button", { name: t("models.tabPluginModels"), exact: true }).click();
      const label = t("compactionModel.name");
      const providerSelect = settings.getByRole("button", { name: `${label} ${t("modelRouting.provider")}`, exact: true });
      const modelSelect = settings.getByRole("button", { name: `${label} ${t("modelRouting.model")}`, exact: true });
      await providerSelect.waitFor();
      await providerSelect.click();
      await page.getByRole("option", { name: provider, exact: true }).click();
      assert.match(await modelSelect.textContent(), /Fixture compressor/);
      assert.match(await modelSelect.getAttribute("title"), /128,000/);
      const compactionStrength = settings.getByRole("button", { name: `${label} ${t("pluginModels.thinking")}`, exact: true });
      await compactionStrength.click();
      await page.getByRole("option", { name: "max", exact: true }).click();
      const before = writes.length;
      await settings.getByRole("button", { name: t("models.tabMain"), exact: true }).click();
      await settings.getByRole("button", { name: t("models.tabPluginModels"), exact: true }).click();
      assert.match(await modelSelect.textContent(), /Fixture compressor/);
      assert.equal(writes.length, before, "tab switches preserve the unsaved selection");
      const save = settings.getByRole("button", { name: t("i18n.save"), exact: true });
      await save.click();
      await settings.getByRole("button", { name: t("i18n.saved"), exact: true }).waitFor();
      assert.deepEqual(writes.at(-1), { provider, modelId: "compressor" });
      assert.equal(thinkingWrites.at(-1).thinkingLevel, "max");
      assert.ok("expected" in thinkingWrites.at(-1));
      for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
        const bounds = await modelSelect.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, "model selector fits the viewport");
        assert.ok(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth));
        await page.screenshot({ path: join(artifacts, `plugin-models-${locale}-${width}-${theme}.png`) });
      }
      if (width === 1280) {
        for (const plugin of ["Recap", "Suggester"]) {
          const p = settings.getByRole("button", { name: `${plugin} ${t("modelRouting.provider")}`, exact: true });
          const m = settings.getByRole("button", { name: `${plugin} ${t("modelRouting.model")}`, exact: true });
          const strength = settings.getByRole("button", { name: `${plugin} ${t("pluginModels.thinking")}`, exact: true });
          assert.ok(Math.abs((await p.boundingBox()).y - (await m.boundingBox()).y) < 2, `${plugin} controls are in one row`);
          await strength.click();
          const autoLabel = plugin === "Recap" ? "pluginModels.followSession" : "pluginModels.modelDefault";
          await page.getByRole("option", { name: `auto (${t(autoLabel)})`, exact: true }).waitFor();
          assert.equal(await page.getByRole("option", { name: "max", exact: true }).count(), 0);
          await page.keyboard.press("Escape");
          await p.click(); await page.getByRole("option", { name: provider, exact: true }).click();
          await m.click(); await page.getByRole("option", { name: "Fixture second · second", exact: true }).click();
          await strength.click();
          await page.getByRole("option", { name: `auto (${t(autoLabel)})`, exact: true }).waitFor();
          await page.getByRole("option", { name: "high (xhigh)", exact: true }).waitFor();
          await page.getByRole("option", { name: "max", exact: true }).click();
        }
        await save.click();
        await settings.getByRole("button", { name: t("i18n.saved"), exact: true }).waitFor();
        assert.deepEqual(pluginWrites.map((item) => item.id), ["fixture-recap", "fixture-suggester"]);
        assert.ok(pluginWrites.every((item) => item.model.modelId === "second" && item.thinking === "max"));
        const recapModel = settings.getByRole("button", { name: `Recap ${t("modelRouting.model")}`, exact: true });
        const recapStrength = settings.getByRole("button", { name: `Recap ${t("pluginModels.thinking")}`, exact: true });
        await recapModel.click(); await page.getByRole("option", { name: "Limited model · limited", exact: true }).click();
        await recapStrength.click();
        assert.equal(await page.getByRole("option", { name: "max", exact: true }).count(), 0);
        await page.getByRole("option", { name: "low", exact: true }).click();
        await save.click();
        await settings.getByRole("button", { name: t("i18n.saved"), exact: true }).waitFor();
      }
      await providerSelect.click();
      await page.getByRole("option", { name: t("compactionModel.follow"), exact: true }).click();
      assert.equal(await modelSelect.isDisabled(), true);
      await compactionStrength.click();
      await page.getByRole("option", { name: `session-default (${t("pluginModels.followSession")})`, exact: true }).click();
      await save.click();
      await settings.getByRole("button", { name: t("i18n.saved"), exact: true }).waitFor();
      assert.equal(writes.at(-1), null);
      assert.equal(thinkingWrites.at(-1).thinkingLevel, null);
      await page.keyboard.press("Escape");
      await settings.waitFor({ state: "hidden" });
      console.log(`PASS: ${width}px plugin model rows, preserved drafts, independent save, light/dark`);
    }
  } finally {
    await page.unroute("**/api/compaction-model", route);
    await page.unroute("**/api/plugin-models", pluginRoute);
    await page.evaluate((theme) => {
      if (theme) document.documentElement.setAttribute("data-theme", theme);
      else document.documentElement.removeAttribute("data-theme");
    }, originalTheme);
    await page.setViewportSize(viewport);
  }
}
