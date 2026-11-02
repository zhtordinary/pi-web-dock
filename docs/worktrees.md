# Worktrees in Pi Web

Pi Web can show all Git worktrees for one project in the sidebar. Use this when you want to keep separate checkouts for different branches, while keeping the project's sessions grouped together.

## When the Worktree Control Appears

The worktree switcher appears below the project picker when the selected directory is a Git repository root.

It is hidden when:

- The selected directory is not a Git repository.
- The selected directory is inside a repository, but not the repository root.
- Git cannot read the repository's worktree list.

If you are inside a repo subdirectory, open the repository root from the project picker to manage worktrees.

## Switching Worktrees

Use the worktree switcher to choose which checkout Pi Web should use for new work in that project.

Switching worktrees affects:

- New sessions started from the sidebar.
- The file Explorer.
- File mentions inserted from the Explorer.

Existing sessions stay grouped under the same project. Opening an existing session moves the effective working directory back to that session's checkout.

## Creating a Worktree

Choose `New worktree...` from the worktree menu and enter a branch name.

Pi Web creates the checkout at:

```text
<repo>/.worktrees/<branch>
```

For example, if the main checkout is:

```text
/Users/alex/Documents/Workspace/pi-web
```

and you create branch `codex/worktree-help`, the worktree is created under:

```text
/Users/alex/Documents/Workspace/pi-web/.worktrees/codex-worktree-help
```

Commit `/.worktrees/` in the main checkout’s root `.gitignore` before creating a worktree. Pi Web requires the directory to be ignored and physical, and never edits the project’s ignore policy automatically. Projects managed by Syncthing must also exclude the whole repository there; Git ignore rules do not control file synchronization.

Creation from any linked worktree uses the same main checkout’s `.worktrees/`, not a nested task directory. If the branch exists, Pi Web reuses it; otherwise it uses the already-fetched `origin/<branch>` when available, or the main checkout’s `HEAD`. Follow the project’s `AGENTS.md` for baseline, validation, integration, and cleanup; the UI does not replace those rules. Existing externally-created worktrees remain usable at their registered paths.

## Renaming a Worktree's Branch

Choose **Rename branch** from a worktree group's menu (in **By worktree** grouping). Pi Web runs `git branch -m` for the branch checked out in that worktree. The checkout directory stays where it is, so sessions started there keep their working directory. A detached checkout has no branch to rename.

## Removing a Worktree

Choose **Delete worktree** from a worktree group's menu, or use the cleanup button in the worktree graph, to remove that checkout.

Removing a worktree does not delete:

- The Git branch.
- Pi Web session history.
- The main checkout.

If the worktree has uncommitted or untracked files, Git refuses the removal. The worktree group then asks again before a force removal. Force removal discards the uncommitted files in that checkout, so use it only when you no longer need those changes. The graph's cleanup button states this up front and removes with force after its confirmation.

## Sessions and Worktrees

Pi Web groups sessions by project root, so sessions from the main checkout and linked worktrees appear together.

Each session still remembers the working directory it was created with. That means:

- A session started in a worktree continues to use that worktree path.
- A session started in the main checkout continues to use the main checkout.
- If a worktree has been removed, old sessions from it stay visible under the project so you can still find the history.

### Starting a session from an existing worktree

The worktree graph, the sidebar worktree menu, and **By worktree** grouping all reuse the checkout path that Git already reports. Their **New session** actions start an ordinary session whose working directory is that checkout. **By worktree** grouping also lists linked worktrees that have no sessions yet, so a session can be started there. New session actions never create another Git worktree.

Creating a physical checkout is a separate, explicit operation: use **New worktree...** in the worktree menu and provide a branch name. A DevSpace, task, or other externally-created checkout is an ordinary Git worktree to Pi Web: it may open it, start a session there, and group its sessions; the graph's New session action never creates, renames, or removes it.

The Git graph inspector's **Associated sessions** list includes visible, non-archived sessions whose `cwd` matches the selected worktree path, plus sessions whose successful tool history confirms they created that worktree. Each Session ID appears once. Rows show the session title and short Session ID, with activity status when available. Click a row to open that session directly. When the graph is opened from an active session, it selects that session's matching worktree, including a linked worktree identified by a verified creation record. A worktree with no associated sessions shows an explicit empty state.

### Reading worktree labels

In **By worktree** grouping, the main checkout is labelled `Main`. Every linked worktree is labelled with the exact Git branch it has checked out, or with its directory path when its `HEAD` is detached.

### Reading graph status

The graph separates Git position from integration history:

- **No commit increment** means the current `HEAD` sits on the main branch's first-parent history, so it has no commits of its own (a checkout that was fast-forwarded into main also looks like this). It does not prove that the working tree is clean; inspect the right-hand panel for uncommitted files.
- **Unmerged commits** means the current `HEAD` contains commits that are not in the main branch. This is a Git relationship, not by itself a ready-to-integrate candidate.
- **Merged into main** means the worktree's commits reached the main branch through a merge commit while the checkout remains available.

The timestamps only order or describe activity. They do not define any of these statuses.

The graph's `ahead N, behind M` values are a topology estimate with an explicit local scope. `behind` is the first-parent distance from the selected fork base to the current main HEAD. For a head outside the main first-parent spine, `ahead` counts commits reachable from that head before the spine boundary; a head on the spine has `ahead 0`. These values are not an upstream symmetric difference and never represent file count or uncommitted work.

A `WIP` row has one or more non-ignored uncommitted entries. The list receives these counts with the graph request, while the detail view may load redacted file names on demand. If Git status cannot be read, the row is marked as unknown.

## Troubleshooting

**I do not see the worktree switcher.**
Select a Git repository root. Non-Git directories and repo subdirectories show a small hint instead of the switcher.

**A branch cannot be added as a worktree.**
Git allows a branch to be checked out in only one worktree at a time. Switch to the existing worktree for that branch, or remove it first.

**A removed worktree still shows up in Git.**
Git can keep prunable worktree records after a checkout disappears. Pi Web filters those out of the switcher.

**The Explorer shows a different branch than the open chat.**
The Explorer follows the selected worktree. The chat follows the opened session. Click the session again to move the sidebar back to that session's checkout.
