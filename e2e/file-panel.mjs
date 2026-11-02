import assert from "node:assert/strict";

export const filePanelFixture = `<!doctype html><html><body style="margin:20px;min-height:2400px">
<label>Notes <input id="notes"></label>
<label>Filter <select id="filter"><option>All</option><option>Pending</option></select></label>
<p>HTML preview state must survive layout changes.</p>
<script>window.previewInstance = Math.random();</script></body></html>`;

export async function checkFilePanel(page, filePath, assertEnglishUi) {
  // Remember the sessions sidebar so the check can leave the layout as it found it.
  const hideSessions = page.getByRole("button", { name: "Hide sessions", exact: true }).first();
  const sidebarWasOpen = await hideSessions.isVisible();
  // The file explorer is a top-bar panel that starts hidden.
  const showExplorer = page.getByRole("button", { name: "Show file explorer", exact: true });
  if (await showExplorer.isVisible()) await showExplorer.click();
  // The DOM title normalizes Windows paths to forward slashes
  // (lib/file-paths.ts normalizeFilePathSlashes), so match in that form.
  await page.getByTitle(filePath.replace(/\\/g, "/"), { exact: true }).click();
  // Opening a file from the explorer switches to reading mode with the file in the file panel.
  // The panel header mirrors the layout toggles; on phones the panel covers the top bar.
  const panel = page.locator("#file-panel");
  const exitReading = panel.getByRole("button", { name: "Exit reading mode", exact: true }).last();
  await exitReading.waitFor();
  assert.equal(await exitReading.getAttribute("aria-pressed"), "true");
  const iframe = page.locator("#file-panel iframe");
  await iframe.waitFor();
  if (page.viewportSize().width < 600) {
    const back = panel.getByRole("button", { name: "Back to the sidebar", exact: true });
    await back.waitFor();
    assert.equal((await back.innerText()).trim(), "Back");
  }
  await assertEnglishUi(page, "#file-panel", `${page.viewportSize().width}px file panel`);
  const frame = await (await iframe.elementHandle()).contentFrame();
  await frame.locator("#notes").fill("Keep this note");
  await frame.locator("#filter").selectOption({ label: "Pending" });
  assert.equal(await frame.locator("#notes").inputValue(), "Keep this note");
  assert.equal(await frame.locator("#filter").inputValue(), "Pending");
  // Leaving reading mode restores the layout from before it and releases the reader toggle.
  await exitReading.click();
  await page.locator("[data-reader-mode-toggle='top-bar'][aria-pressed='false']").waitFor({ state: "attached" });
  const hidePanel = panel.getByRole("button", { name: "Hide file panel", exact: true });
  if (await hidePanel.isVisible()) await hidePanel.click();
  // On phones that layout is the sidebar overlay this check opened; close it to return to the conversation.
  if (!sidebarWasOpen && await hideSessions.isVisible()) await hideSessions.click();
  console.log(`PASS: file explorer opens a live HTML preview in reading mode at ${page.viewportSize().width}px`);
}
