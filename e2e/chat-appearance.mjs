import assert from "node:assert/strict";

// General settings sit in the unified settings dialog; its sidebar entries open it on their own tab.
// The app keeps event streams and status polls open, so the network never idles; wait for the composer instead.
async function reloadApp(page) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".chat-input-textarea").waitFor();
}

async function openGeneralSettings(page) {
  await page.getByRole("button", { name: "Models", exact: true }).first().click();
  await page.getByRole("button", { name: "General", exact: true }).click();
}

export async function checkChatAppearanceReset(page) {
  const width = page.getByRole("slider", { name: "Chat content width", exact: true });
  const resetWidth = page.getByRole("button", { name: "Reset chat content width", exact: true });
  await width.press("End");
  assert.equal(await width.inputValue(), "100");
  await resetWidth.click();
  assert.equal(await width.inputValue(), "90");
  assert.deepEqual(await page.evaluate(() => ({
    width: localStorage.getItem("pi-chat-content-width"),
    appliedWidth: document.documentElement.style.getPropertyValue("--chat-content-max-width"),
  })), { width: "90", appliedWidth: "90%" });
  await reloadApp(page);
  const showSidebar = page.getByRole("button", { name: "Show sidebar", exact: true });
  if (await showSidebar.isVisible()) await showSidebar.click();
  await openGeneralSettings(page);
  assert.equal(await width.inputValue(), "90");
  assert.equal(await resetWidth.isDisabled(), true);
}

export async function checkChatAppearance(page) {
  await page.setViewportSize({ width: 2560, height: 1100 });
  await page.evaluate(() => localStorage.setItem("pi-chat-content-font-size", "24"));
  await reloadApp(page);
  const textarea = page.locator(".chat-input-textarea");
  const openSettings = () => openGeneralSettings(page);
  const closeSettings = () => page.keyboard.press("Escape");
  const width = page.getByRole("slider", { name: "Chat content width", exact: true });
  const font = (locator) => locator.evaluate((el) => getComputedStyle(el).fontSize);
  const fittedHeight = async () => {
    await page.waitForFunction(() => {
      const input = document.querySelector(".chat-input-textarea");
      return input && (input.scrollHeight <= input.clientHeight + 1 || input.clientHeight >= 199);
    });
    return textarea.evaluate((el) => el.clientHeight);
  };

  assert.equal(await font(textarea), "14px", "Stored font overrides must not change typography");
  await openSettings();
  assert.equal(await page.getByRole("slider", { name: "Chat font size", exact: true }).count(), 0);
  assert.equal(await width.inputValue(), "90");
  await width.press("End");
  await closeSettings();
  const draft = "Existing drafts resize when the available width changes. ".repeat(6);
  await textarea.fill(draft);
  const wideHeight = await fittedHeight();
  await openSettings();
  await width.press("Home");
  await closeSettings();
  const narrowHeight = await fittedHeight();
  assert.ok(narrowHeight > wideHeight, "Narrowing must grow the draft without another keystroke");

  await openSettings();
  await width.press("End");
  await closeSettings();
  assert.equal(await textarea.inputValue(), draft);
  assert.ok(await fittedHeight() < narrowHeight, "Widening must shrink the existing draft");
  await reloadApp(page);
  assert.equal(await font(textarea), "14px");

  await openSettings();
  assert.equal(await width.inputValue(), "100");
  await checkChatAppearanceReset(page);
  for (const viewport of [{ width: 1280, height: 600 }, { width: 320, height: 568 }]) {
    await page.setViewportSize(viewport);
    const lastLanguage = page.locator("#general-sec-language button:last-child");
    await lastLanguage.scrollIntoViewIfNeeded();
    assert.equal(await lastLanguage.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    }), true, "Every language option must remain reachable in a short settings panel");
  }
  await closeSettings();
  assert.equal(await font(textarea), "16px", "Mobile inputs retain the focus-zoom minimum");
  await textarea.fill("A mobile draft wraps and resizes within the available space.");
  await fittedHeight();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.evaluate(() => localStorage.removeItem("pi-chat-content-font-size"));
  console.log("PASS: chat width persistence, fixed typography, draft resizing, and short settings panels");
}
