import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";

const source = await readFile(new URL("./TalkMapOverlay.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const { talkMapSubprojectFrameHeight } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("../lib/talk-map-layout.ts");

function between(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1);
  return source.slice(startIndex, endIndex);
}

test("Talk Map rejects stale activity snapshots after a board or peer request changes", () => {
  assert.match(source, /const activityRequestRef = useRef\(0\)/);
  assert.match(source, /activityRequestRef\.current \+= 1/);
  assert.match(source, /requestId !== boardRequestRef\.current \|\| activityRequestId !== activityRequestRef\.current/);
  assert.match(source, /boardRequestAtActivity === boardRequestRef\.current/);
});

test("Talk Map derives project subprojects from activity data", () => {
  assert.match(source, /activityBody\?\.subprojects/);
  assert.match(source, /projectKeysMatch\(subproject\.projectKey, mapProjectKey\)/);
  assert.doesNotMatch(source, /data-talk-map-subproject-filter/);
  assert.match(source, /className="talk-map-subproject-name"[\s\S]*?data-talk-map-subproject-open/);
  assert.match(source, /UNCLASSIFIED_SUBPROJECT_ID/);
});

test("Talk Map moves sessions through existing subproject API without board mutation", () => {
  assert.match(source, /SessionSubprojectMenu/);
  assert.match(source, /sessions\/\$\{encodeURIComponent\(session\.id\)\}\/subproject/);
  assert.match(source, /method: "PATCH"/);
  assert.match(source, /body: JSON\.stringify\(\{ projectKey: session\.projectKey, subprojectId \}\)/);
  assert.doesNotMatch(source, /persistMutation\(\{[^}]*subprojectId/);
});

test("Talk Map reorders subproject modules through the shared custom order", () => {
  assert.match(source, /orderedSubprojectIds/);
  assert.match(source, /reorderSubprojectIds/);
  assert.match(source, /data-talk-map-subproject-reorder-handle/);
  assert.match(source, /apiPathForPeer\(remotePeer, "subprojects"\)/);
  assert.match(source, /method: "PUT"/);
  assert.match(source, /JSON\.stringify\(\{ projectKey: mapProjectKey, mode: "custom", order \}\)/);
  assert.match(source, /subprojectSortSetting\?\.mode \?\? "custom"/);
  assert.match(source, /setSubprojectSortSettings/);
});

test("Talk Map keeps subproject controls available before definitions exist", () => {
  assert.doesNotMatch(source, /ownedSubprojects\.length > 0 &&/);
  assert.match(source, /\{layoutMode === "subprojects" && \(/);
  assert.match(source, /data-talk-map-no-subprojects/);
});

test("Talk Map card controls are hover-only and compact", () => {
  assert.match(source, /const CARD_MIN_HEIGHT = 120/);
  assert.match(source, /new ResizeObserver/);
  assert.match(source, /data-talk-map-card-id/);
  assert.doesNotMatch(source, /WebkitLineClamp/);
  assert.doesNotMatch(source, /height: CARD_HEIGHT/);
  assert.match(source, /buildTalkMapSubprojectLayout/);
  assert.match(source, /data-talk-map-subproject-frame/);
  assert.match(source, /filterTalkMapSessions/);
  assert.match(source, /data-talk-map-layout/);
  assert.match(source, /data-talk-map-card-sort/);
  assert.match(source, /reorderTalkMapSessionOrder/);
  assert.match(source, /const \[canHover, setCanHover\]/);
  assert.match(source, /matchMedia\("\(hover: hover\)"\)/);
  assert.match(source, /onMouseEnter=\{\(\) => setHoveredCardId\(session\.id\)\}/);
  assert.match(source, /display: actionsVisible \? "flex" : "none"/);
  assert.match(source, /height: 24, padding: "0 6px", fontSize: 10/);
  assert.match(source, /currentSubprojectId=\{session\.subprojectId\}[\s\S]*compact/);
});

test("Talk Map card header exposes one recap toggle", () => {
  const cardSource = source.slice(source.indexOf("function TalkMapCard"));
  assert.equal((cardSource.match(/data-talk-map-recap-toggle(?!-)/g) ?? []).length, 1);
});

test("Talk Map card header aligns controls without a spacer", () => {
  const cardStart = source.indexOf("const recapText = sessionRecapDisplay");
  const cardEnd = source.indexOf("data-talk-map-card-footer", cardStart);
  assert.ok(cardStart >= 0 && cardEnd > cardStart);
  const cardSource = source.slice(cardStart, cardEnd);
  assert.match(cardSource, /display: "flex", alignItems: "center", gap: 6/);
  assert.match(cardSource, /flex: "1 1 auto", minWidth: 0/);
  assert.match(cardSource, /marginLeft: "auto"/);
  assert.doesNotMatch(cardSource, /alignItems: "flex-start"/);
  assert.doesNotMatch(cardSource, /<strong style=\{\{ flex: 1,/);
});

test("Talk Map card copy uses hover preview line spacing and formats questions", () => {
  const recapCompStart = source.indexOf("function TalkMapCardRecap(");
  const recapCompEnd = source.indexOf("export function TalkMapOverlay", recapCompStart);
  assert.ok(recapCompStart >= 0 && recapCompEnd > recapCompStart);
  assert.match(source.slice(recapCompStart, recapCompEnd), /fontFamily: "var\(--font-mono\)"[\s\S]{0,40}fontSize: 11,[\s\S]{0,40}lineHeight: 1\.45/);

  const cardStart = source.indexOf("const recapText = sessionRecapDisplay");
  const cardEnd = source.indexOf("data-talk-map-card-footer", cardStart);
  assert.ok(cardStart >= 0 && cardEnd > cardStart);
  const cardSource = source.slice(cardStart, cardEnd);
  assert.match(cardSource, /<TalkMapCardQuestions[\s\S]*?expanded=\{recapExpanded\}/);
  assert.match(source, /loadUserQuestions: true/);
  assert.match(source, /\.slice\(\)\n    \.reverse\(\)/);
  assert.match(source, /formatUserQuestion\(question, 5\)/);
  assert.match(source, /const displayFirstMessage = stripHiddenUserQuestion\(skillExpansionToCommand\(session\.firstMessage\) \?\? session\.firstMessage\)/);
  assert.match(source, /stripHiddenUserQuestion/);
  assert.match(source, /const visibleQuestions = expanded \? displayQuestions : displayQuestions\.slice\(0, 1\)/);
  assert.doesNotMatch(source, /data-talk-map-questions-expand/);
  assert.match(source, /data-talk-map-question-icon="heroicons-chat-bubble-oval-left-ellipsis"/);
  assert.match(source, /<path d="M8\.625 12a\.375\.375/);
  assert.match(source, /<svg[\s\S]*?viewBox="0 0 24 24"[\s\S]*?strokeWidth=\{1\.5\}/);
  assert.doesNotMatch(source, /const \[showAllQuestions, setShowAllQuestions\]/);
  assert.match(source, /setExpandedRecapIds\(\(current\) =>/);
  assert.match(source, /session\.copied/);
  assert.match(source, /data-talk-map-questions-content[\s\S]*?visibleQuestions\.map/);
  assert.doesNotMatch(source, />\n\s*›\n/);

  const ghostStart = source.indexOf("data-talk-map-ghost-card");
  const ghostEnd = source.indexOf("data-talk-map-delete-ghost", ghostStart);
  assert.ok(ghostStart >= 0 && ghostEnd > ghostStart);
  assert.match(source.slice(ghostStart, ghostEnd), /fontSize: 11, lineHeight: 1\.65/);
});


test("Talk Map lock pans the canvas without disabling card interactions", () => {
  assert.match(source, /const layoutSubprojects = useMemo\([\s\S]*?openedSubprojectId[\s\S]*?visibleSubprojects\.filter/);
  assert.match(source, /subprojects: layoutSubprojects/);
  assert.match(source, /className="talk-map-toolbar-top"/);
  assert.match(source, /data-talk-map-refresh-area[\s\S]*?data-talk-map-time-range[\s\S]*?data-talk-map-refresh/);
  assert.match(source, /data-talk-map-subproject-panel-toggle[\s\S]*?data-talk-map-layout/);
  assert.doesNotMatch(source, /className="talk-map-primary-action"/);
  assert.match(source, /layoutMode === "free" \? "var\(--accent\)"/);
  assert.match(source, /layoutMode === "subprojects" \? "var\(--accent\)"/);
  assert.match(source, /data-talk-map-lock/);
  assert.match(source, /data-talk-map-add-ghost/);
  assert.match(source, /data-talk-map-add-edge/);
  const addEdgeStart = source.lastIndexOf("data-talk-map-add-edge");
  const relationToggleStart = source.indexOf("data-talk-map-relations-toggle", addEdgeStart);
  assert.ok(addEdgeStart >= 0 && relationToggleStart > addEdgeStart);
  const addEdgeButton = source.slice(addEdgeStart, relationToggleStart);
  assert.match(addEdgeButton, /edgeMode \? \{[\s\S]*background: "var\(--bg-selected\)"/);
  assert.doesNotMatch(addEdgeButton, /board && !edgeSaving \? "var\(--accent\)"/);
  assert.match(source, /data-talk-map-edge-toggle/);
  assert.match(source, /data-talk-map-reset/);
  assert.match(source, /data-talk-map-fit/);
  assert.match(source, /className="talk-map-layout-toggle"[^>]*style=\{\{/);
  assert.doesNotMatch(source, /moreOptions/);
  assert.doesNotMatch(source, /handleMoreAction/);
  assert.match(source, /setMapLocked/);
  assert.match(source, /!mapLocked && target\.closest\("\[data-talk-map-card\]"\)/);
  assert.match(source, /if \(mapLocked\) \{[\s\S]*?if \(edgeMode\) event\.stopPropagation\(\);[\s\S]*?return;/);
  assert.match(source, /target\.closest\("button, a, input, textarea, select"\)/);
  assert.match(source, /event\.button !== 0 \|\| edgeMode \|\| mapLocked/);
  assert.match(source, /Math\.hypot\(deltaX, deltaY\) < 6/);
  assert.match(source, /captured: false/);
  assert.match(source, /onDoubleClick=\{\(event\) => \{ event\.stopPropagation\(\); if \(!edgeMode\) onOpenSession\(session\); \}\}/);
});

test("Talk Map automatic card sorts keep the card body clickable and reserve the handle for drag", () => {
  assert.match(source, /const canDragCards = !isSubprojectView \|\| talkMapLayout\.sort === "manual";/);
  const pointerDown = between(source, "const handleCardPointerDown", "const handleCardDragHandlePointerDown");
  assert.match(pointerDown, /event\.button !== 0 \|\| !canDragCards/);
  assert.match(pointerDown, /beginCardDrag\(event, sessionId, x, y\)/);
  assert.doesNotMatch(pointerDown, /setPointerCapture/);
  assert.match(pointerDown, /target\.closest\("button, a, input, textarea, select, \[data-talk-map-card-drag-handle\]"\)/);

  const pointerMove = between(source, "const handleCardPointerMove", "const handleCardPointerUp");
  assert.match(pointerMove, /Math\.hypot\(event\.clientX - drag\.startX, event\.clientY - drag\.startY\) < TALK_MAP_CARD_DRAG_THRESHOLD/);
  assert.match(pointerMove, /event\.currentTarget\.setPointerCapture/);

  const pointerUp = between(source, "const handleCardPointerUp", "const deleteSelectedEdge");
  assert.match(pointerUp, /if \(!drag\.active\) \{[\s\S]*?setDragPreview\(null\);[\s\S]*?return;/);

  const cardDrop = between(source, "const drop = pendingCardDrop", "  }, [board, cardHeights");
  assert.match(cardDrop, /setPendingCardDrop\(null\);/);
  assert.match(cardDrop, /if \(!ok \|\| talkMapLayout\.sort !== "manual" \|\| !nextLayout\) return;/);
  assert.doesNotMatch(cardDrop, /sort: "manual" as TalkMapLayoutSort/);
});

test("Talk Map subproject cards expose a dedicated drag handle for every sort", () => {
  assert.match(source, /const handleCardDragHandlePointerDown = useCallback\(/);
  const handleDown = between(source, "const handleCardDragHandlePointerDown", "const handleCardPointerMove");
  assert.match(handleDown, /if \(event\.button !== 0 \|\| edgeMode \|\| mapLocked\) return;/);
  assert.match(handleDown, /event\.currentTarget\.setPointerCapture\(event\.pointerId\)/);
  assert.match(handleDown, /beginCardDrag\(event, sessionId, x, y\)/);
  assert.doesNotMatch(handleDown, /canDragCards/);
  assert.match(source, /data-talk-map-card-drag-handle/);
  assert.match(source, /\{isSubprojectView && <span[\s\S]*?handleCardDragHandlePointerDown/);
  assert.match(source, /aria-label=\{t\("talkMap\.dragCard"\)\}/);
});

test("Talk Map paints an active subproject card in a stage-level drag overlay", () => {
  assert.match(source, /const \[activeCardDragId, setActiveCardDragId\] = useState<string \| null>\(null\)/);
  const pointerMove = between(source, "const handleCardPointerMove", "const handleCardPointerUp");
  assert.match(pointerMove, /setActiveCardDragId\(activeDrag\.sessionId\)/);
  const cardSource = between(source, "const renderSessionCard", "const subprojectClientCenter");
  assert.match(cardSource, /module\?: TalkMapSubprojectModule, overlay = false/);
  assert.match(cardSource, /data-talk-map-drag-overlay=\{overlay \? "true" : undefined\}/);
  assert.match(cardSource, /visibility: isActiveDrag && module && !overlay \? "hidden" : undefined/);
  assert.match(cardSource, /pointerEvents: overlay \? "none" : undefined/);
  assert.match(cardSource, /zIndex: overlay \? 100/);
  assert.match(cardSource, /const position = module && isActiveDrag[\s\S]*?subprojectLayout\.positions\[session\.id\]/);
  assert.match(cardSource, /inert=\{overlay \? true : undefined\}/);
  assert.match(source, /const draggingSubprojectSession = isSubprojectView && activeCardDragId/);
  assert.match(source, /renderSessionCard\(draggingSubprojectSession, undefined, true\)/);
});

test("Talk Map drag overlay uses visible geometry and follows stage scrolling", () => {
  const beginDrag = between(source, "const beginCardDrag", "const handleCardPointerDown");
  assert.match(beginDrag, /closest<HTMLElement>\("\[data-talk-map-card\]"\)\?\.getBoundingClientRect\(\)/);
  assert.match(beginDrag, /pointerOffset: cardRect \? \{ x: event\.clientX - cardRect\.left, y: event\.clientY - cardRect\.top \}/);
  const coordinates = between(source, "const subprojectDragPosition", "const handleSubprojectStagePointerDown");
  assert.match(coordinates, /x: clientX - rect\.left \+ stage\.scrollLeft - pointerOffset\.x/);
  assert.match(coordinates, /y: clientY - rect\.top \+ stage\.scrollTop - pointerOffset\.y/);
  assert.match(coordinates, /subprojectDragPosition\(drag\.lastX, drag\.lastY, drag\.pointerOffset\)/);
  const pointerMove = between(source, "const handleCardPointerMove", "const handleCardPointerUp");
  assert.match(pointerMove, /subprojectDragPosition\(event\.clientX, event\.clientY, activeDrag\.pointerOffset\)/);
});

test("Talk Map cancellation restores the card without persisting a drop", () => {
  const pointerUp = between(source, "const handleCardPointerUp", "const deleteSelectedEdge");
  assert.match(pointerUp, /setActiveCardDragId\(null\)/);
  assert.match(pointerUp, /if \(event\.type !== "pointercancel"\) \{[\s\S]*?setPendingCardDrop[\s\S]*?persistMutation/);
  assert.match(pointerUp, /setDragPreview\(null\)/);
  assert.match(pointerUp, /releasePointerCapture/);
});

test("Talk Map card drag suppresses stray text selection and stray clicks", () => {
  assert.match(source, /const TALK_MAP_CARD_DRAGGING_CLASS = "talk-map-card-pointer-dragging";/);
  assert.match(source, /function clearCardTextSelection\(\): void \{/);
  assert.match(source, /window\.getSelection\(\)\?\.removeAllRanges\(\)/);
  const pointerMove = between(source, "const handleCardPointerMove", "const handleCardPointerUp");
  assert.match(pointerMove, /clearCardTextSelection\(\);[\s\S]*?event\.preventDefault\(\);[\s\S]*?clearCardTextSelection\(\);/);
  assert.match(pointerMove, /document\.body\.classList\.add\(TALK_MAP_CARD_DRAGGING_CLASS\)/);
  const pointerUp = between(source, "const handleCardPointerUp", "const deleteSelectedEdge");
  assert.match(pointerUp, /document\.body\.classList\.remove\(TALK_MAP_CARD_DRAGGING_CLASS\)/);
  assert.match(pointerUp, /clearCardTextSelection\(\)/);
  assert.match(pointerMove, /setSubprojectDragOverId\(subprojectAtPoint\(event\.clientX, event\.clientY\)\?\.id \?\? null\)/);
  assert.match(pointerUp, /if \(isSubprojectView\) setSubprojectDragOverId\(null\)/);
  assert.match(source, /if \(cardDragClickRef\.current\) \{/);
  assert.match(styles, /body\.talk-map-card-pointer-dragging \{\s*user-select: none;\s*cursor: grabbing;/s);
});

test("Talk Map subproject scrollbars stay visually narrow", () => {
  assert.match(source, /className="talk-map-subproject-scroll"/);
  assert.match(styles, /\.talk-map-overlay ::-webkit-scrollbar \{[^}]*width: 4px;[^}]*height: 4px;/s);
  assert.match(styles, /\.talk-map-subproject-scroll \{[^}]*scrollbar-width: thin;/s);
  assert.match(styles, /@supports selector\(::-webkit-scrollbar\) \{[\s\S]*?\.talk-map-subproject-scroll \{[^}]*scrollbar-width: auto;/s);
  assert.match(styles, /\.talk-map-subproject-scroll::-webkit-scrollbar \{[^}]*width: 4px;/s);
});

test("Talk Map exposes only transient save feedback", () => {
  assert.match(source, /\{saving && \(/);
  assert.match(source, /data-talk-map-save-status/);
  assert.doesNotMatch(source, /talkMap\.(saved|live|snapshot)/);
  assert.doesNotMatch(source, /activityLive/);
});

test("Talk Map subproject stage keeps a persistent bottom scrollbar", () => {
  assert.match(source, /className="talk-map-subproject-stage"/);
  assert.match(styles, /\.talk-map-subproject-stage \{[^}]*scrollbar-width: thin;/s);
  assert.match(styles, /\.talk-map-overlay ::-webkit-scrollbar \{[^}]*width: 4px;[^}]*height: 4px;/s);
  assert.match(styles, /\.talk-map-subproject-stage::-webkit-scrollbar \{[^}]*height: 6px;/s);
  assert.match(styles, /\.talk-map-subproject-stage::-webkit-scrollbar-thumb \{/);
  assert.match(source, /talkMapSubprojectFrameHeight\(height, TALK_MAP_SUBPROJECT_VERTICAL_PADDING, scrollbarGutter\)/);
  assert.match(source, /stage\.offsetHeight - stage\.clientHeight/);
});

test("Talk Map frame height follows measured native scrollbar gutters", () => {
  assert.equal(talkMapSubprojectFrameHeight(640, 24, 0), 592);
  assert.equal(talkMapSubprojectFrameHeight(640, 24, 6), 586);
  assert.equal(talkMapSubprojectFrameHeight(640, 24, 12), 580);
  assert.equal(talkMapSubprojectFrameHeight(640, 24, -4), 592);
});

test("Talk Map keeps project identity separate from toolbar actions", () => {
  assert.match(source, /className="talk-map-toolbar-identity"/);
  assert.doesNotMatch(source, /className="talk-map-heading-label"/);
  assert.match(source, /className="talk-map-toolbar-top-actions"/);
  assert.match(source, /className="talk-map-toolbar-actions"/);
});

test("Talk Map exposes new sessions, floating selectors, and per-subproject visibility", () => {
  assert.match(source, /onNewSession\?: \(subprojectId\?: string, subprojectLabel\?: string\) => void/);
  assert.match(source, /MessageSquarePlus/);
  assert.match(source, /data-talk-map-new-session/);
  assert.match(source, /data-talk-map-subproject-new-session/);
  assert.match(source, /module\.id !== UNCLASSIFIED_SUBPROJECT_ID/);
  assert.match(source, /startNewSession[\s\S]*?onClose\(\)[\s\S]*?onNewSession\?\./);
  assert.match(source, /ReaderFloatingSelect/);
  assert.doesNotMatch(source, /<select/);
  assert.match(source, /data-talk-map-hide-empty-subprojects/);
  assert.match(source, /autoHideEmptySubprojects/);
  assert.match(source, /<span>\{t\("sessionActivity\.autoHideEmptySubprojects"\)\}<\/span>/);
  assert.doesNotMatch(source, /disableAutoHideEmptySubprojects/);
  assert.match(source, /filterSessionsByActivityTime/);
  assert.match(source, /data-talk-map-time-range/);
  assert.match(source, /useSharedActivityFilters/);
  assert.match(source, /data-talk-map-card-meta/);
  assert.match(source, /fontSize: 13, fontWeight: 700, lineHeight: 1\.2/);
  assert.match(source, /talkMapLayout\.mode !== "subprojects"/);
  assert.match(source, /data-talk-map-subproject-strip/);
  assert.match(source, /data-talk-map-subproject-visibility/);
  assert.match(source, /\{isVisible \? <Eye size=\{14\} strokeWidth=\{1\.8\} aria-hidden="true" \/> : <EyeOff size=\{14\} strokeWidth=\{1\.8\} aria-hidden="true" \/>\}/);
  assert.match(source, /color: isVisible \? "var\(--accent\)" : "var\(--text-dim\)"/);
  assert.match(source, /className="talk-map-subproject-name"[\s\S]*?onClick=\{\(\) => openSubproject\(subproject\.id\)\}/);
  assert.match(source, /data-talk-map-subproject-new-session[\s\S]*?disabled=\{!mapProjectKey\}[\s\S]*?startNewSession\(subproject\.id, subproject\.label\)/);
  assert.doesNotMatch(source, /data-talk-map-subproject-open[\s\S]{0,500}?<Maximize2/);
  assert.match(source, /const \[openedSubprojectId, setOpenedSubprojectId\]/);
  assert.match(source, /const openSubproject = useCallback/);
  assert.doesNotMatch(source, /subprojectFilter/);
  assert.doesNotMatch(source, /<strong>\{t\("talkMap\.subprojectVisibility"\)\}<\/strong>/);
  assert.doesNotMatch(source, /talk-map-subproject-sidebar-header/);
  assert.match(source, /isSubprojectView \? \([\s\S]*?subprojectLayout\.modules\.map/);
  assert.match(source, /data-talk-map-subproject-stage[\s\S]*?module\.height/);
  assert.match(source, /data-talk-map-subproject-stage[\s\S]*?overflowY: "hidden"/);
  assert.match(source, /frameHeight: subprojectFrameHeight/);
  assert.match(source, /handleSubprojectStagePointerDown/);
  assert.match(source, /handleSubprojectStageWheel/);
  assert.match(source, /data-talk-map-subproject-scroll[\s\S]*?overflowY: "auto"/);
  assert.match(source, /board && !isSubprojectView && <div className="talk-map-canvas-controls"/);
  assert.match(source, /!openedSubprojectId && Object\.entries\(board\?\.ghosts/);
  assert.match(source, /const fitNodeCount =/);
  assert.match(source, /return displayableSessions\.filter\(\(session\) => session\.subprojectId === openedSubprojectId\)/);
  assert.match(source, /toggleSubprojectVisibility/);
  assert.match(source, /setAutoHideEmptySubprojectsOverride/);
  assert.match(source, /data-talk-map-hide-empty-subprojects[\s\S]*?controlStyle\(!mapProjectKey \|\| subprojectVisibilityBusy\)/);
  assert.match(source, /data-talk-map-hide-empty-subprojects[\s\S]*?alignItems: "center", justifyContent: "center", textAlign: "center"/);
  assert.match(source, /color: autoHideEmptySubprojects \? "var\(--text-dim\)" : "var\(--accent\)"/);
  assert.doesNotMatch(source, /data-talk-map-hide-empty-subprojects[\s\S]*?controlStyle\(!board \|\| subprojectVisibilityBusy\)/);
  assert.match(source, /clearSessionActivityCache/);
  assert.match(source, /automaticallyHidden/);
  assert.match(source, /className="talk-map-selected-card-title"/);
  assert.match(source, /hiddenSubprojectIds/);
  assert.match(source, /filterTalkMapSessions\(timeFilteredSessions, hiddenSubprojectIds\)/);
  assert.match(source, /autoHideEmptySubprojects \? <EyeOff size=\{14\} strokeWidth=\{1\.8\} aria-hidden="true" \/> : <Eye size=\{14\} strokeWidth=\{1\.8\} aria-hidden="true" \/>/);
  assert.match(source, /color: !board \|\| visibleCardIds\.length === 0 \? "var\(--text-dim\)" : allRecapsExpanded \? "var\(--accent\)" : "var\(--text-dim\)"/);
  assert.match(source, /color: edgeMode \? "var\(--text-dim\)" : recapExpanded \? "var\(--accent\)" : "var\(--text-dim\)"/);
  assert.match(source, /EyeOff/);
  assert.match(source, /Eye size=\{14\}/);
  assert.match(source, /id="talk-map-subproject-sidebar"/);
  assert.match(source, /className="talk-map-subproject-sidebar-item"/);
  assert.match(source, /overflowWrap: "anywhere"/);
  assert.match(source, /className="talk-map-canvas-controls"/);
  assert.match(source, /talkMap\.filteredEmpty/);
  assert.match(source, /data-talk-map-selected-card-title/);
  assert.match(source, /setSelectedCardId\(sessionId\)/);
  assert.match(source, /module\.id === UNCLASSIFIED_SUBPROJECT_ID \? undefined : module\.id/);
  assert.match(source, /startNewSession\(subprojectId, subprojectId \? module\.label : undefined\)/);
  assert.match(source, /groupBySubproject\([\s\S]*?mode: subprojectSortSetting\?\.mode \?\? "custom"[\s\S]*?customOrder: subprojectSortSetting\?\.order/);
  assert.match(source, /compareBySort\(leftActivity, rightActivity, sharedFilters\.sort\)/);
});

test("Talk Map resolves initial focus before paint and after subproject positions exist", () => {
  assert.match(source, /useLayoutEffect/);
  assert.match(source, /useLayoutEffect\(\(\) => \{\s*if \(!open \|\| !board \|\| !canvasRef\.current \|\| !focusSessionId/);
  assert.match(source, /talkMapLayout\.mode === "subprojects" && !subprojectLayout\.positions\[focusSessionId\]/);
});

test("Talk Map opens in fit view without overwriting saved camera", () => {
  assert.match(source, /const initialFitDoneRef = useRef\(false\)/);
  assert.match(source, /initialFitDoneRef\.current = false/);
  assert.match(source, /const fitView = useCallback\(\(persist = true\)/);
  assert.match(source, /initialFitDoneRef\.current = true;\s*fitView\(false\)/);
  assert.match(source, /onClick=\{\(\) => fitView\(\)\}/);
});

test("Talk Map cards use the wider requested footprint", () => {
  assert.match(source, /const CARD_WIDTH = 470;/);
});

test("Talk Map canvas double-click triggers fitView without text selection", () => {
  assert.match(source, /const handleCanvasDoubleClick = useCallback/);
  assert.match(source, /onDoubleClick=\{handleCanvasDoubleClick\}/);
  assert.match(source, /touchAction: "none",\s*userSelect: "none",/);
});

test("Talk Map automatically enters in fit mode and stays fitted until user interaction", () => {
  assert.match(source, /const userInteractedRef = useRef\(false\)/);
  assert.match(source, /userInteractedRef\.current = false/);
  assert.match(source, /if \(userInteractedRef\.current\) return/);
  assert.match(source, /new ResizeObserver\(\(entries\) => \{[\s\S]*?width >= 100 && height >= 100 && !userInteractedRef\.current[\s\S]*?fitView\(false\)/);
});


test("Talk Map focus card keeps an explicit blue highlight border", () => {
  assert.match(source, /const isFocused = focusSessionId === session\.id/);
  assert.match(source, /data-talk-map-focused=\{isFocused \? "true" : undefined\}/);
  assert.match(source, /border: isFocused \? "2px solid #2563eb" : "1px solid var\(--border\)"/);
  assert.match(source, /outline: isFocused \? "3px solid #2563eb"/);
});

test("Talk Map layout switches leave an opened subproject view", () => {
  assert.match(source, /const selectLayoutMode = useCallback\(\(mode: TalkMapLayoutState\["mode"\]\) => \{\s*setOpenedSubprojectId\(null\);\s*updateTalkMapLayout\(\{ mode \}\);/);
  assert.match(source, /onClick=\{\(\) => selectLayoutMode\("free"\)\}/);
});


test("Talk Map converts placeholders into sessions and detects subproject drops", () => {
  assert.match(source, /onConvertGhost\?: \(ghostId: string, ghost: TalkMapGhostCardState, subprojectId\?: string\) => void/);
  assert.match(source, /data-talk-map-convert-ghost/);
  assert.match(source, /isSubprojectView && onConvertGhost/);
  assert.match(source, /onConvertGhost\(drag\.ghostId, ghost, target\.id\)/);
  assert.match(source, /onConvertGhost\(ghostId, ghost\)/);
});

test("Talk Map card selection reports sidebar highlight without opening chat", () => {
  assert.match(source, /onSelectCard\?: \(session: SessionInfo \| null\) => void/);
  assert.match(source, /setSelectedCardId\(sessionId\);[\s\S]*?const selectedSession = sessions\.find/);
  assert.match(source, /if \(selectedSession\) onSelectCard\?\.\(selectedSession\)/);
  assert.doesNotMatch(source, /onSelectCard\?\.\(selectedSession\)[\s\S]*?onOpenSession\(selectedSession\)/);
});

test("Talk Map cards expose archive and delete actions", () => {
  assert.match(source, /onArchiveSession\?: \(session: SessionInfo\) => Promise<void>/);
  assert.match(source, /onDeleteSession\?: \(session: SessionInfo\) => Promise<void>/);
  assert.match(source, /data-talk-map-archive/);
  assert.match(source, /data-talk-map-delete/);
  assert.match(source, /window\.confirm\(t\("talkMap\.deleteConfirm"/);
  assert.match(source, /archiveCardSession/);
  assert.match(source, /deleteCardSession/);
});

test("Talk Map card actions are icon-only with native tooltips", () => {
  const actions = between(source, "data-talk-map-fork", "<SessionSubprojectMenu");
  assert.match(source, /<GitFork size=\{12\} strokeWidth=\{1\.8\} aria-hidden="true" \/>/);
  assert.match(source, /<FileInput size=\{12\} strokeWidth=\{1\.8\} aria-hidden="true" \/>/);
  assert.match(actions, /aria-label=\{actionKey === `fork:\$\{session\.id\}` \? t\("talkMap\.forking"\) : t\("talkMap\.fork"\)\}/);
  assert.match(actions, /title=\{actionKey === `fork:\$\{session\.id\}` \? t\("talkMap\.forking"\) : t\("talkMap\.fork"\)\}/);
  assert.match(actions, /aria-busy=\{actionKey === `fork:\$\{session\.id\}`\}/);
  assert.match(actions, /aria-label=\{t\("talkMap\.injectContext"\)\}/);
  assert.match(actions, /title=\{t\("talkMap\.injectContext"\)\}/);
  assert.match(actions, /<Archive size=\{12\}/);
  assert.match(actions, /<Trash2 size=\{12\}/);
  assert.doesNotMatch(actions, /<span>/);
});

test("Talk Map composes selected title inline and places layout switch after subproject controls", () => {
  assert.match(source, /className="talk-map-toolbar-names"/);
  assert.match(source, /talk-map-toolbar-layout-center/);
  assert.match(source, /data-talk-map-refresh-area/);
  assert.match(source, /data-talk-map-subproject-panel-toggle[\s\S]*?data-talk-map-layout/);
  assert.doesNotMatch(source, /data-talk-map-visible-count/);
  assert.doesNotMatch(source, /session\.firstMessage\?\.trim\(\)\.split\("\\n"\)\[0\]\?\.slice\(0, 100\)/);
});

test("Talk Map frames reuse rendered subproject list order", () => {
  assert.match(source, /subprojectDisplayOrder: layoutSubprojects\.map\(\(subproject\) => subproject\.id\)/);
});

test("Talk Map projects live run status before snapshot refresh", () => {
  assert.match(source, /applySessionActivityItemsEvent/);
  assert.match(source, /setActivities\(\(current\) =>/);
});


test("Talk Map recap section collapses per card without hiding questions or card controls", () => {
  assert.match(source, /function TalkMapCardRecap\(/);
  assert.doesNotMatch(source, /data-talk-map-recap-toggle-section/);
  assert.match(source, /expanded: boolean/);
  assert.match(source, /data-talk-map-recap-content/);
  assert.match(source, /<TalkMapCardRecap[\s\S]*?expanded=\{recapExpanded\}/);
  assert.match(source, /const \[expandedRecapIds, setExpandedRecapIds\]/);
  assert.match(source, /setExpandedRecapIds\(new Set\(\)\)/);
  assert.match(source, /data-talk-map-recap-toggle-all/);
  assert.match(source, /\{allRecapsExpanded \? <Eye size=\{14\} strokeWidth=\{1\.8\} aria-hidden="true" \/> : <EyeOff size=\{14\} strokeWidth=\{1\.8\} aria-hidden="true" \/>\}/);
  assert.match(source, /const toggleAllRecaps = useCallback/);
  assert.match(source, /data-talk-map-recap-toggle/);
  assert.match(source, /\{recapExpanded \? <Eye size=\{13\} strokeWidth=\{1\.8\} aria-hidden="true" \/> : <EyeOff size=\{13\} strokeWidth=\{1\.8\} aria-hidden="true" \/>\}/);
  assert.match(source, /aria-expanded=\{recapExpanded\}/);
  assert.match(source, /const recapExpanded = expandedRecapIds\.has\(session\.id\)/);
  assert.match(source, /minHeight: CARD_MIN_HEIGHT/);
  assert.doesNotMatch(source, /data-talk-map-questions-toggle/);
  assert.match(source, /data-talk-map-user-questions/);
  assert.match(source, /className="talk-map-canvas-controls"[\s\S]*?data-talk-map-fit[\s\S]*?data-talk-map-reset/);
});

test("Talk Map withholds list metadata until its activity snapshot is ready", () => {
  assert.match(source, /const \[activitySnapshotReady, setActivitySnapshotReady\] = useState\(false\)/);
  assert.match(source, /setActivitySnapshotReady\(true\)/);
  assert.match(source, /activitySnapshotReady \? \([\s\S]*?<SessionListMeta session=\{session\}/);
});

test("Talk Map renders the board without waiting for activity metadata", () => {
  const loadBoardStart = source.indexOf("const loadBoard = useCallback");
  const loadBoardEnd = source.indexOf("\n  useEffect(() => {\n    if (!open || !projectRoot) return;", loadBoardStart);
  const loadBoard = source.slice(loadBoardStart, loadBoardEnd);
  assert.match(loadBoard, /void fetchActivities\(options\.forceActivity === true\)\.then/);
  assert.doesNotMatch(loadBoard, /await activityPromise/);
  assert.ok(loadBoard.indexOf("setBoard(nextBoard)") < loadBoard.indexOf("finally"));
});

test("Talk Map keeps full activity metadata in the bottom-right footer", () => {
  const cardStart = source.indexOf("const activity = activityBySession.get(session.id)");
  const footerStart = source.indexOf("data-talk-map-card-footer", cardStart);
  assert.ok(cardStart >= 0 && footerStart > cardStart);
  const cardHeader = source.slice(cardStart, footerStart);
  const footerEnd = source.indexOf("const subprojectClientCenter", footerStart);
  assert.ok(footerEnd > footerStart);
  const footer = source.slice(footerStart, footerEnd);

  assert.doesNotMatch(cardHeader, /<SessionActivityMeta/);
  assert.doesNotMatch(cardHeader, /<SessionListMeta/);
  assert.match(footer, /data-talk-map-card-meta/);
  assert.match(footer, /data-talk-map-card-meta style=\{\{[^}]*justifyContent: "flex-end"[^}]*marginLeft: "auto"/);
  assert.match(footer, /<SessionActivityMeta item=\{activity\} sort=\{sharedFilters\.sort\}/);
  assert.match(source, /data-talk-map-copy-session-info/);
  assert.match(source, /onCopySessionInfo\?: \(item: SessionActivityItem\) => void \| Promise<void>/);
  assert.match(source, /Promise\.resolve\(\)[\s\S]*?onCopySessionInfo\(activity\)[\s\S]*?\.catch\(\(\) =>/);
  assert.doesNotMatch(footer, /showStatus=\{false\}/);
  assert.doesNotMatch(footer, /data-talk-map-status-label/);
});

test("Talk Map does not claim a layout mode before the board resolves", () => {
  assert.match(source, /const layoutMode = board \? talkMapLayout\.mode : null/);
  assert.match(source, /const isSubprojectView = layoutMode === "subprojects"/);
  assert.doesNotMatch(source, /talkMapLayout\.mode === "free"/);
  assert.match(source, /previousLayoutModeRef\.current = board \? talkMapLayout\.mode : null/);
});

test("Talk Map free-canvas chrome waits for the persisted layout", () => {
  assert.match(source, /backgroundImage: board \? "radial-gradient\(circle, color-mix\(in srgb, var\(--text-dim\) 22%, transparent\) 1px, transparent 1px\)" : undefined/);
  assert.match(source, /backgroundSize: board \? "24px 24px" : undefined/);
  assert.match(source, /\{!board && <div style=\{\{ position: "absolute", inset: 0,[\s\S]*?t\("talkMap\.loading"\)/);
  assert.doesNotMatch(source, /\{loading && !board &&/);
});

test("Talk Map invalidates the previous project board before loading a new one", () => {
  const projectReset = between(
    source,
    "  useEffect(() => {\n    // 切项目时先作废旧 board",
    "  }, [open, projectRoot, remotePeer]);",
  );
  assert.match(source, /const \[rawBoard, setBoard\] = useState<TalkMapBoard \| null>\(null\)/);
  assert.match(source, /const board = rawBoard && projectKeysMatch\(rawBoard\.projectRoot, projectRoot \?\? undefined\) \? rawBoard : null/);
  assert.match(projectReset, /boardRequestRef\.current \+= 1/);
  assert.match(projectReset, /setBoard\(null\)/);
  assert.match(projectReset, /sessionsRef\.current = \[\]/);
  assert.match(source, /const requestId = boardRequestRef\.current/);
  assert.match(source, /if \(requestId !== boardRequestRef\.current\) return/);
});
