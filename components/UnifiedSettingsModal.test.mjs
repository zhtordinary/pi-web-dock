import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("UnifiedSettingsModal defines the canonical tabs and keeps MCP after favorites", () => {
  const modalPath = path.join(process.cwd(), "components", "UnifiedSettingsModal.tsx");
  const source = fs.readFileSync(modalPath, "utf8");

  // Order must be: 常规 | 模型 | 技能 | 插件 | 子代理 | 提示词 | 收藏 | MCP
  const generalIdx = source.indexOf("id: \"general\"");
  const modelsIdx = source.indexOf("id: \"models\"");
  const skillsIdx = source.indexOf("id: \"skills\"");
  const pluginsIdx = source.indexOf("id: \"plugins\"");
  const agentsIdx = source.indexOf("id: \"agents\"");
  const mcpIdx = source.indexOf("id: \"mcp\"");
  const promptsIdx = source.indexOf("id: \"prompts\"");
  const favoritesIdx = source.indexOf("id: \"favorites\"");

  assert.ok(generalIdx !== -1, "general tab present");
  assert.ok(modelsIdx !== -1, "models tab present");
  assert.ok(skillsIdx !== -1, "skills tab present");
  assert.ok(pluginsIdx !== -1, "plugins tab present");
  assert.ok(agentsIdx !== -1, "agents tab present");

  assert.ok(generalIdx < modelsIdx, "general precedes models");
  assert.ok(modelsIdx < skillsIdx, "models precedes skills");
  assert.ok(skillsIdx < pluginsIdx, "skills precedes plugins");
  assert.ok(pluginsIdx < agentsIdx, "plugins precedes agents");
  assert.ok(mcpIdx !== -1, "mcp tab present");
  assert.ok(promptsIdx !== -1, "prompts tab present");
  assert.ok(favoritesIdx !== -1, "favorites tab present");
  assert.ok(agentsIdx < promptsIdx, "agents precedes prompts");
  assert.ok(promptsIdx < favoritesIdx, "prompts precedes favorites");
  assert.ok(favoritesIdx < mcpIdx, "favorites precedes mcp");
});

test("Config components accept onOpenFile and embedded props", () => {
  const modelsPath = path.join(process.cwd(), "components", "ModelsConfig.tsx");
  const skillsPath = path.join(process.cwd(), "components", "SkillsConfig.tsx");
  const pluginsPath = path.join(process.cwd(), "components", "PluginsConfig.tsx");
  const agentsPath = path.join(process.cwd(), "components", "AgentsConfig.tsx");
  const favoritesPath = path.join(process.cwd(), "components", "FavoritesConfig.tsx");

  const modelsSource = fs.readFileSync(modelsPath, "utf8");
  const skillsSource = fs.readFileSync(skillsPath, "utf8");
  const pluginsSource = fs.readFileSync(pluginsPath, "utf8");
  const agentsSource = fs.readFileSync(agentsPath, "utf8");
  const favoritesSource = fs.readFileSync(favoritesPath, "utf8");

  assert.ok(modelsSource.includes("onOpenFile"), "ModelsConfig supports onOpenFile");
  assert.ok(modelsSource.includes("embedded"), "ModelsConfig supports embedded");

  assert.ok(skillsSource.includes("onOpenFile"), "SkillsConfig supports onOpenFile");
  assert.ok(skillsSource.includes("embedded"), "SkillsConfig supports embedded");

  assert.ok(pluginsSource.includes("onOpenFile"), "PluginsConfig supports onOpenFile");
  assert.ok(pluginsSource.includes("embedded"), "PluginsConfig supports embedded");

  assert.ok(agentsSource.includes("onOpenFile"), "AgentsConfig supports onOpenFile");
  assert.ok(agentsSource.includes("embedded"), "AgentsConfig supports embedded");

  assert.ok(favoritesSource.includes("onOpenFile"), "FavoritesConfig supports onOpenFile");
  assert.ok(favoritesSource.includes("embedded"), "FavoritesConfig supports embedded");
});

test("AppShell wires UnifiedSettingsModal and passes onOpenFile to open in Reader tabs", () => {
  const appShellPath = path.join(process.cwd(), "components", "AppShell.tsx");
  const source = fs.readFileSync(appShellPath, "utf8");

  assert.ok(source.includes("<UnifiedSettingsModal"), "AppShell renders UnifiedSettingsModal");
  assert.ok(source.includes("setSettingsModalTab(\"models\")"), "Toolbar maps to models tab");
  assert.ok(source.includes("setSettingsModalTab(\"skills\")"), "Toolbar maps to skills tab");
  assert.ok(source.includes("setSettingsModalTab(\"plugins\")"), "Toolbar maps to plugins tab");
  assert.ok(source.includes("openFileTab"), "onOpenFile triggers openFileTab");
});

test("subagent model selector refreshes when its settings tab becomes active", () => {
  const modalSource = fs.readFileSync(path.join(process.cwd(), "components", "UnifiedSettingsModal.tsx"), "utf8");
  const agentsSource = fs.readFileSync(path.join(process.cwd(), "components", "AgentsConfig.tsx"), "utf8");

  assert.ok(modalSource.includes('active={activeTab === "agents"}'));
  assert.ok(agentsSource.includes("active?: boolean"));
  assert.match(agentsSource, /fetch\(apiPathForPeer\(remotePeer, `models\?cwd=\$\{encodeURIComponent\(cwd\)\}`\), \{ cache: "no-store", signal: controller\.signal \}\)/);
  assert.match(agentsSource, /if \(!active\) return;/);
  assert.match(agentsSource, /\}, \[active, cwd, remotePeer, trustKey\]\);/);
});

test("remote subagent settings propagate remotePeer to AgentsConfig and use apiPathForPeer", () => {
  const modalSource = fs.readFileSync(path.join(process.cwd(), "components", "UnifiedSettingsModal.tsx"), "utf8");
  const agentsSource = fs.readFileSync(path.join(process.cwd(), "components", "AgentsConfig.tsx"), "utf8");

  assert.match(modalSource, /<AgentsConfig[\s\S]*?remotePeer=\{remotePeer\}/);
  assert.ok(agentsSource.includes("remotePeer?: string"));
  assert.match(agentsSource, /apiPathForPeer\(remotePeer, "subagents\/settings"\)/);
  assert.match(agentsSource, /apiPathForPeer\(remotePeer, `subagents\/profiles/);
});


test("UnifiedSettingsModal hosts FileViewerModal as popup overlay without closing settings", () => {
  const modalPath = path.join(process.cwd(), "components", "UnifiedSettingsModal.tsx");
  const source = fs.readFileSync(modalPath, "utf8");

  assert.ok(source.includes("FileViewerModal"), "imports FileViewerModal");
  assert.ok(source.includes("popupFilePath"), "manages popupFilePath state");
  assert.ok(source.includes("<FileViewerModal"), "renders FileViewerModal overlay");
});

test("remote General settings keep compaction requests on the selected peer", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "components", "GeneralConfig.tsx"), "utf8");
  const modalSource = fs.readFileSync(path.join(process.cwd(), "components", "UnifiedSettingsModal.tsx"), "utf8");

  assert.match(source, /apiFor\(remotePeer, "settings\/compaction"\)/);
  assert.match(source, /\}, \[remotePeer\]\);/);
  assert.match(modalSource, /<GeneralConfig[\s\S]*?remotePeer=\{remotePeer\}/);
});

test("GeneralConfig offers official multi-theme appearance choices and preserves quote-selection changes", () => {
  const generalPath = path.join(process.cwd(), "components", "GeneralConfig.tsx");
  const themePath = path.join(process.cwd(), "lib", "theme.ts");
  const source = fs.readFileSync(generalPath, "utf8");
  const themeSource = fs.readFileSync(themePath, "utf8");

  assert.ok(source.includes("settings.appearance"), "Appearance section is present");
  assert.ok(source.includes("THEME_OPTIONS"), "uses shared theme options");
  assert.ok(source.includes("setThemePreference"), "updates theme preference");
  assert.ok(source.includes('type="radio"'), "uses native theme radios");
  for (const preference of ["light", "dark", "mist", "rose", "pine", "auto"]) {
    assert.match(themeSource, new RegExp(`id: "${preference}"`));
  }
  assert.ok(source.includes("QUOTE_SELECTION_CHANGED_EVENT"), "exports quote selection changed event");
  assert.ok(source.includes("QUOTE_SELECTION_STORAGE_KEY"), "persists quote selection state");
  assert.ok(source.includes('apiFor(remotePeer, "settings/compaction")'), "routes the global compaction default through the selected peer");
  assert.ok(source.includes("settings.autoCompactionDefault"), "places the default in General settings");
});

test("GeneralConfig shares live percentage chat controls and groups selection with switches", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "components", "GeneralConfig.tsx"), "utf8");
  const hookSource = fs.readFileSync(path.join(process.cwd(), "hooks", "useChatAppearance.ts"), "utf8");
  assert.match(source, /useChatAppearance\(\)/);
  assert.doesNotMatch(source, /applyChatSizingStyles|CHAT_WIDTH_STORAGE_KEY|CHAT_FONT_SIZE_STORAGE_KEY/);
  assert.match(hookSource, /--chat-content-max-width", `\$\{width\}%`/);

  const quote = source.indexOf('t("settings.quoteSelection")');
  const width = source.indexOf('t("settings.chatContentWidth")');
  assert.ok(quote >= 0 && quote < width, "selection toggle stays before width slider");
  assert.ok(width >= 0, "width slider stays available");
  assert.doesNotMatch(source, /settings\.chatContentFontSize/);
});

test("ChatWindow implements floating quote selection popup", () => {
  const chatWindowPath = path.join(process.cwd(), "components", "ChatWindow.tsx");
  const source = fs.readFileSync(chatWindowPath, "utf8");

  assert.ok(source.includes("quoteSelectionEnabled"), "supports quoteSelectionEnabled prop");
  assert.ok(source.includes("pi-quote-selection-changed"), "listens to quote selection change event");
  assert.ok(source.includes("handleQuoteSelection"), "formats and quotes selected text");
  assert.ok(source.includes("selectionTooltip"), "manages selection tooltip coordinates");
  assert.match(source, /clampSelectionToolbarTop\(rect\.bottom, visibleTop, viewportHeight\)/, "keeps the floating toolbar below the visible chat area");
  assert.ok(source.includes("scrollContainerRef.current?.getBoundingClientRect().top"), "uses the chat viewport rather than a fixed top offset");
  assert.ok(source.includes("chat.askInCurrent"), "renders ask in current chat action");
});

test("PluginsConfig and SkillsConfig place path on secondary toolbar without duplicate header when embedded", () => {
  const pluginsPath = path.join(process.cwd(), "components", "PluginsConfig.tsx");
  const skillsPath = path.join(process.cwd(), "components", "SkillsConfig.tsx");

  const pluginsSource = fs.readFileSync(pluginsPath, "utf8");
  const skillsSource = fs.readFileSync(skillsPath, "utf8");

  assert.ok(pluginsSource.includes("!embedded && ("), "PluginsConfig hides top header when embedded");
  assert.ok(skillsSource.includes("!embedded && ("), "SkillsConfig hides top header when embedded");
  assert.ok(pluginsSource.includes("pluginSettingsPath(viewScope, cwd)"), "PluginsConfig displays path on secondary toolbar");
});

test("AgentsConfig provides full subagent options matching official pi-web", () => {
  const agentsPath = path.join(process.cwd(), "components", "AgentsConfig.tsx");
  const source = fs.readFileSync(agentsPath, "utf8");

  assert.ok(source.includes("agents.contextResources"), "native context resources section present");
  assert.ok(source.includes("agents.inheritProjectContext"), "project context option present");
  assert.ok(source.includes("agents.inheritGlobalContext"), "global context option present");
  assert.ok(source.includes("agents.inheritSkills"), "skill inheritance option present");
  assert.ok(source.includes("agents.model"), "model override select present");
  assert.ok(source.includes("agents.thinking"), "thinking level select present");
  assert.ok(source.includes("defaultContext"), "native context mode present");
  assert.ok(source.includes("defaultAsync"), "native async default present");
  assert.doesNotMatch(source, /loadSkills|loadExtensions|maxTurns|runInBackground/, "removed legacy controls stay absent");
});

test("ChatWindow quote selection provides both current chat and side chat options", () => {
  const chatWindowPath = path.join(process.cwd(), "components", "ChatWindow.tsx");
  const source = fs.readFileSync(chatWindowPath, "utf8");

  assert.ok(source.includes("chat.askInCurrent"), "ask in current chat option present");
  assert.ok(source.includes("chat.askInSidekick"), "ask in side chat option present");
  assert.ok(source.includes("handleQuoteToSidekick"), "handleQuoteToSidekick handler present");
  assert.ok(!source.includes("chat.quoteQuestion"), "does not append question prefix in quote text");
  assert.ok(source.includes("const quoteText = \`\x24{intro}\\n\\n\x24{quoted}\\n\\n\`;"), "formats quote block without trailing question label");
});

test("AppShell opens session chat files in floating popup with format rendering and Reader view transition", () => {
  const appShellPath = path.join(process.cwd(), "components", "AppShell.tsx");
  const source = fs.readFileSync(appShellPath, "utf8");

  assert.ok(source.includes("sessionPopupFile"), "manages sessionPopupFile state");
  assert.ok(source.includes("onOpenInReaderView"), "provides onOpenInReaderView transition");
  assert.ok(source.includes("<FileViewer"), "renders FileViewer inside popup modal");
});

test("FileViewer and FileViewerModal integrate Search & Replace", () => {
  const fileViewerPath = path.join(process.cwd(), "components", "FileViewer.tsx");
  const modalPath = path.join(process.cwd(), "components", "FileViewerModal.tsx");

  const fvSource = fs.readFileSync(fileViewerPath, "utf8");
  const modalSource = fs.readFileSync(modalPath, "utf8");

  assert.ok(fvSource.includes("SearchReplaceBar"), "FileViewer integrates SearchReplaceBar");
  assert.ok(modalSource.includes("FileViewer"), "FileViewerModal integrates FileViewer");
});

test("settings forms size footer actions to their content", () => {
  const agentsSource = fs.readFileSync(path.join(process.cwd(), "components", "AgentsConfig.tsx"), "utf8");
  const modelsSource = fs.readFileSync(path.join(process.cwd(), "components", "ModelsConfig.tsx"), "utf8");
  const routingSource = fs.readFileSync(path.join(process.cwd(), "components", "ModelRoutingConfig.tsx"), "utf8");
  const cssSource = fs.readFileSync(path.join(process.cwd(), "app", "settings.css"), "utf8");

  assert.ok(agentsSource.includes('className="settings-form-footer"'), "AgentsConfig has fixed footer");
  assert.ok(agentsSource.indexOf('className="settings-form-footer"') > agentsSource.indexOf("/* Main Split Body */"), "AgentsConfig footer follows scrollable body");
  assert.ok(agentsSource.includes('t("settings.discardUnsaved")'), "AgentsConfig has discard action");
  assert.ok(agentsSource.includes("setSavedOk(true)"), "AgentsConfig reports successful save");
  assert.ok(agentsSource.includes("disabled={saving || savedOk}"), "AgentsConfig disables save after success");
  assert.match(agentsSource, /method: "PATCH"[\s\S]*scope: "builtin"/, "built-in and runtime overrides use the live API");

  for (const [name, source] of [["ModelsConfig", modelsSource], ["ModelRoutingConfig", routingSource]]) {
    assert.ok(source.includes('className="settings-form-footer"'), `${name} has settings footer`);
    const expectedActions = name === "ModelsConfig" ? 4 : 2;
    const footer = source.match(/<div className="settings-form-footer">([\s\S]*?)<\/div>/)?.[1] ?? "";
    assert.equal((footer.match(/<ConfigButton\b/g) ?? []).length, expectedActions, `${name} uses shared action buttons`);
  }

  assert.ok(cssSource.includes(".config-button"), "shared settings action style exists");
  assert.ok(cssSource.includes("width: auto;"), "settings actions fit their content");
  assert.doesNotMatch(cssSource, /width: 104px;/, "settings actions are not fixed-width");
  assert.ok(cssSource.includes("height: var(--config-control-height);"), "settings actions share the standard control height");
});


test("settings modal guards unsaved changes with in-app confirmation dialog and discard actions", () => {
  const modalSource = fs.readFileSync(path.join(process.cwd(), "components", "UnifiedSettingsModal.tsx"), "utf8");
  const modelsSource = fs.readFileSync(path.join(process.cwd(), "components", "ModelsConfig.tsx"), "utf8");
  const routingSource = fs.readFileSync(path.join(process.cwd(), "components", "ModelRoutingConfig.tsx"), "utf8");
  const agentsSource = fs.readFileSync(path.join(process.cwd(), "components", "AgentsConfig.tsx"), "utf8");

  assert.ok(modalSource.includes("pendingAction"), "manages pending action for unsaved changes");
  assert.ok(modalSource.includes("modelsControllerRef"), "wires models controller");
  assert.ok(modalSource.includes("agentsControllerRef"), "wires agents controller");
  assert.ok(modalSource.includes("settings.unsavedChangesTitle"), "renders unsaved changes dialog title");
  assert.ok(modalSource.includes("settings.continueEditing"), "renders continue editing button");
  assert.ok(modalSource.includes("settings.discardAndClose"), "renders discard and close button");
  assert.ok(modalSource.includes("settings.saveAndClose"), "renders save and close button");

  assert.ok(modelsSource.includes("controllerRef"), "ModelsConfig accepts controllerRef");
  assert.ok(modelsSource.includes("settings.discardUnsaved"), "ModelsConfig has discard unsaved action");
  assert.ok(routingSource.includes("controllerRef"), "ModelRoutingConfig accepts controllerRef");
  assert.ok(routingSource.includes("settings.discardUnsaved"), "ModelRoutingConfig has discard unsaved action");
  assert.ok(agentsSource.includes("controllerRef"), "AgentsConfig accepts controllerRef");
  assert.ok(agentsSource.includes("settings.discardUnsaved"), "AgentsConfig has discard unsaved action");
});

test("resource mutations refresh only the opposite settings panel", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "components", "UnifiedSettingsModal.tsx"), "utf8");
  const skillsStart = source.indexOf('{visitedTabs.has("skills")');
  const pluginsStart = source.indexOf('{visitedTabs.has("plugins")');
  assert.ok(skillsStart >= 0 && pluginsStart > skillsStart, "skills and plugins panes present");
  const skillsPane = source.slice(skillsStart, pluginsStart);
  const pluginsPane = source.slice(pluginsStart);

  assert.match(source, /const \[skillsRefreshRevision, setSkillsRefreshRevision\] = useState\(0\);/);
  assert.match(source, /const \[pluginsRefreshRevision, setPluginsRefreshRevision\] = useState\(0\);/);
  assert.match(skillsPane, /revision=\{skillsRefreshRevision\}/);
  assert.match(skillsPane, /onChanged=\{notifyPluginsChanged\}/);
  assert.match(pluginsPane, /revision=\{pluginsRefreshRevision\}/);
  assert.match(pluginsPane, /onChanged=\{notifySkillsChanged\}/);
  assert.doesNotMatch(source, /revision=\{resourceRevision\}/);
});

test("global skill edits validate discovery in global scope only", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "app", "api", "skills", "route.ts"), "utf8");
  assert.match(source, /const discovered = await loadSkillsWithInstallInfo\(cwd, "global"\);/);
  assert.doesNotMatch(source, /Promise\.all\(\[\s*loadSkillsWithInstallInfo\(body\.cwd, "global"\),\s*loadSkillsWithInstallInfo\(body\.cwd, "project"\)\s*\]\)/s);
});

test("settings group headers share chevrons and preserve execution evidence and narrow layouts", () => {
  const read = (name) => fs.readFileSync(path.join(process.cwd(), "components", name), "utf8");
  const agents = read("AgentsConfig.tsx");
  const skills = read("SkillsConfig.tsx");
  const plugins = read("PluginsConfig.tsx");
  const mcp = read("McpConfig.tsx");
  const modal = read("UnifiedSettingsModal.tsx");
  const css = fs.readFileSync(path.join(process.cwd(), "app", "settings.css"), "utf8");
  assert.match(agents, /className="config-resource-group-header"/);
  assert.match(agents, /agents\.executionNotice/);
  assert.match(agents, /agents\.executionReaderLoaded/);
  assert.match(agents, /flexDirection: isMobile \? "column" : "row"/);
  for (const source of [agents, skills, plugins]) {
    assert.match(source, /<ChevronDown/);
    assert.match(source, /rotate\(-90deg\)/);
    assert.match(source, /rotate\(0deg\)/);
  }
  const filter = skills.slice(skills.indexOf('className="config-sidebar-filter"'));
  assert.match(filter, /flexWrap: "wrap"/);
  // MCP folds its groups the same way, with the turn in CSS.
  assert.match(mcp, /<ChevronDown/);
  assert.match(css, /\.mcp-group-chevron\.is-collapsed \{\n\s*transform: rotate\(-90deg\);/);
  assert.match(css, /\.mcp-config-sidebar \.config-resource-group-header \{[\s\S]*?border-top: 1px solid var\(--border\)/);
  const footer = mcp.slice(mcp.indexOf("<ConfigFooter\n"));
  assert.ok(footer.indexOf("<ConfigPanelRefreshButton") < footer.indexOf("<ConfigButton onClick={onClose}"));
  assert.match(modal, /id: "mcp", label: t\("common\.mcp"\) \|\| "MCP", icon: PiWebServerIcon/);
  assert.match(modal, /function PiWebServerIcon[\s\S]*aria-hidden="true"/);
});
