import assert from "node:assert/strict"
import test from "node:test"
import { createJiti } from "jiti"

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false })
const { canStartSessionSubprojectPointerDrag, isSubprojectReorderDragBlocked } = await jiti.import("./session-subproject-pointer-dnd.ts")

function target({ input = false, actionButton = false, openButton = false } = {}) {
  const self = {
    hasAttribute(name) {
      return name === "data-session-open" && openButton
    },
    closest(selector) {
      if (selector.includes("input") && input) return self
      if (selector.includes("button") && (actionButton || openButton)) return self
      if (selector === "button" && (actionButton || openButton)) return self
      if (selector === "[data-session-open]" && openButton) return self
      return null
    },
  }
  return self
}

test("pointer drag starts from session content and its open-session button, not controls", () => {
  assert.equal(canStartSessionSubprojectPointerDrag(target()), true)
  assert.equal(canStartSessionSubprojectPointerDrag(target({ openButton: true })), true)
  assert.equal(canStartSessionSubprojectPointerDrag(target({ actionButton: true })), false)
  assert.equal(canStartSessionSubprojectPointerDrag(target({ input: true })), false)
})


const pointerSource = await (await import("node:fs/promises")).readFile(new URL("./session-subproject-pointer-dnd.ts", import.meta.url), "utf8")

function between(source, start, end) {
  const startIndex = source.indexOf(start)
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`)
  return source.slice(startIndex, endIndex)
}
test("pointer capture starts only after drag threshold so clicks remain native", () => {
  const pointerDown = between(pointerSource, "const onPointerDown", "const onPointerMove")
  const pointerMove = between(pointerSource, "const onPointerMove", "const onPointerUp")
  assert.doesNotMatch(pointerDown, /setPointerCapture/)
  assert.match(pointerMove, /drag\.owner\.setPointerCapture/)
})

test("entering the drag gesture clears the native text selection it started", () => {
  const activation = between(pointerSource, "if (!drag.active) {", "event.preventDefault()")
  // The browser grows a selection from the press point as soon as the pointer
  // travels, so crossing the threshold must wipe it instead of only freezing it.
  assert.match(activation, /clearTextSelection\(\)/)
  assert.match(activation, /setPointerCapture/)
})

test("committing or cancelling a drag clears any selection left behind", () => {
  const finish = between(pointerSource, "const finish", "const onPointerDown")
  assert.match(finish, /clearTextSelection\(\)/)
  const afterActive = between(finish, "if (!drag.active) return;", "suppressClickRef.current")
  assert.match(afterActive, /clearTextSelection\(\)/)
})

test("selection clearing stays gesture scoped and never disables row text selection", () => {
  const pointerDown = between(pointerSource, "const onPointerDown", "const onPointerMove")
  assert.doesNotMatch(pointerDown, /clearTextSelection/)
  assert.match(pointerSource, /window\.getSelection\(\)\?\.removeAllRanges\(\)/)
  assert.match(pointerSource, /typeof window === "undefined"/)
  assert.doesNotMatch(pointerSource, /userSelect/)
})


test("HTML5 subproject reorder blocks nested interactive origins", () => {
  assert.equal(isSubprojectReorderDragBlocked(target()), false)
  assert.equal(isSubprojectReorderDragBlocked(target({ actionButton: true })), true)
  assert.equal(isSubprojectReorderDragBlocked(target({ openButton: true })), true)
  assert.equal(isSubprojectReorderDragBlocked(target({ input: true })), true)
})
