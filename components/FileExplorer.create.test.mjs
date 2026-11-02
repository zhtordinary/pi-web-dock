import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const explorer = await readFile(new URL("./FileExplorer.tsx", import.meta.url), "utf8");
const section = await readFile(new URL("./ExplorerSection.tsx", import.meta.url), "utf8");
const { createUploadProgressHandler, isFileExplorerRequestCurrent } = await createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true }).import("./FileExplorer.tsx");

test("Explorer keeps the root action menu available and targets the project root", () => {
  assert.match(section, /files\.actionMenuTitle/);
  assert.match(section, /FileActionMenuItem kind="folder"/);
  assert.match(section, /FileActionMenuItem kind="file"/);
  assert.match(section, /FileActionMenuItem kind="upload"/);
  assert.match(section, /openCreate\("folder", cwd \?\? explorerCwd/);
  assert.match(section, /openCreate\("file", cwd \?\? explorerCwd/);
  assert.match(section, /openUploadPicker\(cwd \?\? explorerCwd/);
  assert.doesNotMatch(section, /onOpenTerminal/);
});

test("folder and blank-tree context menus expose local and root actions", () => {
  assert.match(explorer, /onRequestCreate\(node\.fullPath, "folder"\)/);
  assert.match(explorer, /onRequestCreate\(node\.fullPath, "file"\)/);
  assert.match(explorer, /onRequestUpload\(node\.fullPath\)/);
  assert.match(explorer, /onContextMenu=\{handleRootContextMenu\}/);
  assert.match(explorer, /requestCreate\("folder", cwd\)/);
  assert.match(explorer, /requestCreate\("file", cwd\)/);
  assert.match(explorer, /requestUpload\(cwd\)/);
});

test("created documents open after creation and uploads preserve their target directory", () => {
  assert.match(explorer, /createPath\(target\.directory, nextName, target\.kind, targetPeer\)/);
  assert.match(explorer, /onOpenFile\(result\.path, nextName\)/);
  assert.match(explorer, /targetDirectory: string/);
  assert.match(explorer, /uploadFiles\(context.targetDirectory, files/);
  assert.match(explorer, /prepareUpload\(files, captureUploadContext\(uploadTargetRef\.current\)\)/);
});

test("git AI copy failures stay local to FileExplorer", () => {
  assert.match(explorer, /const handleCopyGitAiText = useCallback/);
  assert.match(explorer, /await copyText\(gitAiText\)/);
  assert.match(explorer, /setGitAiCopyError/);
  assert.match(explorer, /role="alert".*gitAiCopyError/);
});


test("deferred upload callback ignores a response after owner or peer changes", async () => {
  const oldOwner = { generation: 1, requestId: 1, cwd: "/repo", peer: "debian", targetDirectory: "/repo/docs" };
  let current = { ...oldOwner };
  let resolve;
  const deferred = new Promise((done) => { resolve = done; });
  const callback = deferred.then((value) => isFileExplorerRequestCurrent(oldOwner, current) ? value : "stale");
  current = { ...oldOwner, generation: 2, requestId: 2, peer: "air" };
  resolve("old response");
  assert.equal(await callback, "stale");
});


test("late upload progress cannot update a newer workspace", () => {
  const oldOwner = { generation: 1, requestId: 1, cwd: "/repo", peer: "debian", targetDirectory: "/repo/docs" };
  let current = { ...oldOwner };
  const progress = [];
  const onProgress = createUploadProgressHandler(
    oldOwner,
    (context) => isFileExplorerRequestCurrent(context, current),
    (value) => progress.push(value),
  );
  onProgress(25);
  current = { ...oldOwner, generation: 2, requestId: 2, cwd: "/other", peer: "air", targetDirectory: "/other/docs" };
  onProgress(90);
  assert.deepEqual(progress, [25]);
});

test("file creation actions share the existing Lucide toolbar style", () => {
  assert.match(explorer, /import \{ FilePlus2, FolderPlus, Upload \} from "lucide-react"/);
  assert.match(explorer, /kind === "folder" \? FolderPlus : kind === "file" \? FilePlus2 : Upload/);
  assert.match(explorer, /<Icon size=\{size\} strokeWidth=\{1\.8\} aria-hidden="true" \/>/);
});
