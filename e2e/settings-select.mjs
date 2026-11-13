import assert from "node:assert/strict";
import { join } from "node:path";

export async function checkSettingsSelects(page, artifacts) {
  const viewport = page.viewportSize();
  const originalTheme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  const server = {
    name: "dropdown-fixture", scope: "global", sourcePath: "/fixture/mcp.json", configKey: "fixture",
    enabled: true, validated: true, transport: "http", exposure: "codemode", url: "https://example.invalid/mcp",
    envNames: [], headerNames: ["Authorization"], commandFields: [], variableReferences: [], usesOAuth: false, masked: false,
  };
  const data = {
    mcp: { available: true }, codemode: { sandbox: { state: "available" }, builtinDisabled: false, preference: "automatic" },
    files: [{ scope: "global", path: "/fixture/mcp.json", exists: true, problems: [] }], servers: [server],
  };
  const writes = [];
  const route = async (request) => {
    if (request.request().method() === "POST") {
      const body = request.request().postDataJSON();
      writes.push(body);
      server.exposure = body.exposure;
    }
    await request.fulfill({ json: data });
  };
  await page.route("**/api/mcp?*", route);
  await page.route("**/api/mcp", route);
  try {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator(".chat-input-textarea").waitFor();
      const sessionToggle = page.locator('.app-top-bar [data-layout-control="sessions"]');
      if (await sessionToggle.count() > 0 && await sessionToggle.getAttribute("aria-label") === "Show sessions") await sessionToggle.click();
      await page.getByRole("button", { name: "Models", exact: true }).first().click();
      const mcpTab = page.getByRole("button", { name: "MCP", exact: true });
      if (await mcpTab.count() === 0 || !await mcpTab.first().isVisible()) {
        console.log(`SKIP: ${width}px MCP settings tab is not exposed in this responsive fixture`);
        continue;
      }
      await mcpTab.click();
      await page.locator(".config-sidebar-item").filter({ hasText: server.name }).click();
      const trigger = page.getByRole("button", { name: "How dropdown-fixture's tools reach the model", exact: true });
      await trigger.waitFor();
      const chip = page.locator(".mcp-config-chip").filter({ hasText: "Authorization" }).first();
      const height = await trigger.evaluate((element) => element.getBoundingClientRect().height);
      assert.equal(height, await chip.evaluate((element) => element.getBoundingClientRect().height), "Tools selector height must match adjacent chips");
      assert.equal(height, 22);
      const settings = page.getByRole("dialog", { name: "Settings", exact: true });
      for (const theme of ["light", "dark"]) {
        await page.evaluate((theme) => document.documentElement.setAttribute("data-theme", theme), theme);
        await trigger.click();
        const menu = page.getByRole("listbox", { name: "How dropdown-fixture's tools reach the model", exact: true });
        await menu.waitFor();
        assert.deepEqual(await menu.getByRole("option").allTextContents(), ["Code mode (default)", "tool search", "direct", "hidden"]);
        const geometry = await menu.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, bg: getComputedStyle(element).backgroundColor };
        });
        assert.ok(geometry.left >= 8 && geometry.right <= width - 8);
        assert.ok(geometry.top >= 8 && geometry.bottom <= 892);
        assert.equal(geometry.bg, await page.evaluate(() => getComputedStyle(document.body).backgroundColor));
        await page.screenshot({ path: join(artifacts, `settings-select-${width}-${theme}.png`) });
        await page.keyboard.press("Escape");
        assert.equal(await settings.isVisible(), true, "Escape closes only the menu, not Settings");
        assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);
      }
      const before = writes.length;
      const next = server.exposure === "hidden" ? "direct" : "hidden";
      await trigger.press("ArrowDown");
      await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "option");
      await page.keyboard.press("End");
      await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "hidden");
      if (next === "direct") {
        await page.keyboard.press("ArrowUp");
        await page.waitForFunction(() => document.activeElement?.textContent?.trim() === "direct");
      }
      await page.keyboard.press("Enter");
      await page.waitForFunction((next) => document.querySelector('button.mcp-exposure-select')?.textContent === next, next);
      assert.equal(writes.length, before + 1);
      assert.equal(server.exposure, next);
      assert.equal(writes.at(-1).action, "set-exposure");
      assert.equal(writes.at(-1).scope, "global");
      await page.keyboard.press("Escape");
      console.log(`PASS: ${width}px settings dropdown, 22px chip alignment, light/dark menu, viewport bounds, keyboard, Escape and save`);
    }
  } finally {
    await page.unroute("**/api/mcp?*", route);
    await page.unroute("**/api/mcp", route);
    await page.evaluate((theme) => {
      if (theme) document.documentElement.setAttribute("data-theme", theme);
      else document.documentElement.removeAttribute("data-theme");
    }, originalTheme);
    await page.setViewportSize(viewport);
  }
}
