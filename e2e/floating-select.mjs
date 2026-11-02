import assert from "node:assert/strict";

export async function checkFloatingSelectLayout(page) {
  const viewport = page.viewportSize();
  const devices = page.getByRole("button", { name: /^(Switch device|切换设备)$/ });
  await devices.click();
  const menu = page.getByRole("listbox", { name: /^(Switch device|切换设备)$/ });
  await menu.waitFor({ state: "visible" });
  const geometry = () => menu.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const rows = [...element.querySelectorAll('[role="option"]')];
    return {
      top: rect.top,
      bottom: rect.bottom,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      lastBottom: rows.at(-1).getBoundingClientRect().bottom,
      count: rows.length,
      viewportHeight: innerHeight,
    };
  });
  try {
    const full = await geometry();
    assert.ok(full.count >= 8, "Exercise the full device, collection, and management menu");
    assert.equal(full.scrollHeight, full.clientHeight, "All device menu options must fit without scrolling on desktop");
    assert.ok(full.lastBottom <= full.bottom, "The final management option must be visible");

    await page.setViewportSize({ width: viewport.width, height: 260 });
    await page.waitForFunction(() => {
      const menu = document.querySelector('[role="listbox"]');
      const rect = menu?.getBoundingClientRect();
      return rect && rect.top >= 8 && rect.bottom <= innerHeight - 8;
    });
    const short = await geometry();
    assert.equal(short.count, full.count, "A short viewport must not drop options");
    assert.ok(short.scrollHeight > short.clientHeight, "Only viewport overflow should require scrolling");
    assert.ok(short.top >= 8 && short.bottom <= short.viewportHeight - 8);
    await menu.getByRole("option").last().scrollIntoViewIfNeeded();
    const scrolled = await geometry();
    assert.ok(scrolled.lastBottom <= scrolled.bottom, "The final option must remain reachable in a short viewport");
  } finally {
    await page.keyboard.press("Escape");
    await page.setViewportSize(viewport);
  }

  await page.getByRole("button", { name: /^(Sort sessions|会话排序)$/ }).click();
  const sort = page.getByRole("listbox", { name: /^(Sort sessions|会话排序)$/ });
  await sort.waitFor({ state: "visible" });
  try {
    const gaps = await sort.evaluate((element) => [...element.querySelectorAll('[role="option"]')].map((row) => {
      const range = document.createRange();
      range.selectNodeContents(row.children[1].firstElementChild);
      const text = range.getBoundingClientRect();
      const box = row.getBoundingClientRect();
      return { textWidth: text.width, left: text.left - box.left, right: box.right - text.right };
    }));
    const longest = gaps.sort((a, b) => b.textWidth - a.textWidth)[0];
    assert.ok(Math.abs(longest.left - longest.right) <= 1, "The longest label must have symmetric checkmark gutters, not a stretched right side");
  } finally {
    await page.keyboard.press("Escape");
  }
  console.log("PASS: content-sized dropdown widths, complete option list, and viewport-only scrolling");
}
