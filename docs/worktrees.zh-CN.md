# Pi Web 里的 Worktree

Pi Web 会把同一个 Git 项目的 main checkout 和 linked worktree 放在同一个项目下。你可以用它在不同分支之间切换工作目录，同时保留统一的会话列表。

## 什么时候会看到 Worktree 控件

当左上角选择的是 Git 仓库根目录时，项目选择器下面会出现 worktree 切换控件。

以下情况不会显示：

- 当前目录不是 Git 仓库。
- 当前目录在某个 Git 仓库里面，但不是仓库根目录。
- Git 无法读取这个仓库的 worktree 列表。

如果你在仓库子目录里，先从项目选择器打开仓库根目录，再管理 worktree。

## 切换 Worktree 会影响什么

worktree 切换器决定 Pi Web 接下来使用哪个 checkout。

它会影响：

- 从侧边栏新建的会话。
- 左侧 Explorer 浏览的文件。
- 从 Explorer 插入到输入框里的文件路径。

已有会话仍然按同一个 project root 分组。点击一个已有会话时，侧边栏会回到这个会话原本所在的 checkout。

## 新建 Worktree

在 worktree 菜单里选择 `New worktree...`，输入 branch name。

Pi Web 会把 checkout 放在：

```text
<repo>/.worktrees/<branch>
```

例如 main checkout 是：

```text
/Users/alex/Documents/Workspace/pi-web
```

新建 `codex/worktree-help` 时，目录会是：

```text
/Users/alex/Documents/Workspace/pi-web/.worktrees/codex-worktree-help
```

创建前先在主 checkout 根 `.gitignore` 提交 `/.worktrees/`。Pi Web 要求该目录已被忽略且为物理目录，不自动修改目标项目的忽略规则。Projects 还需在 Syncthing 排除整个仓库；Git 忽略不能代替同步排除。

从任意 linked worktree 新建都使用同一主 checkout 的 `.worktrees/`，不在任务树内嵌套创建。分支已存在时复用；不存在时优先使用已获取的 `origin/<分支>`，否则使用主 checkout 的 `HEAD`。基线、验证、合入与清理遵循目标项目自己的 `AGENTS.md`，界面默认值不替代项目规则。已有外部工作树仍按 Git 登记路径使用。

## 删除 Worktree

在“按工作树”分组里，从工作树分组菜单选择“删除工作树”，或使用工作树图谱里的清理按钮。它删除的是这个 checkout 目录。

删除 worktree 不会删除：

- Git branch。
- Pi Web 的历史会话。
- main checkout。

如果 worktree 里有未提交或未跟踪文件，Git 会拒绝删除，工作树分组会再次确认是否强制删除。强制删除会丢弃这个 checkout 里的未提交文件，只在确定不需要这些改动时使用。图谱清理按钮在确认框里先说明这一点，确认后直接强制删除。

## 重命名 Worktree 的分支

在“按工作树”分组里，从工作树分组菜单选择“重命名分支”。Pi Web 对这个 worktree 当前 checkout 的分支执行 `git branch -m`；checkout 目录保持不变，在其中开始的会话继续使用原工作目录。detached HEAD 的 checkout 没有可重命名的分支。

## 会话和 Worktree 的关系

Pi Web 按 project root 分组会话，所以 main checkout 和 linked worktree 里的会话会显示在一起。

但每个会话仍然记得自己创建时的 working directory：

- 在某个 worktree 创建的会话，会继续使用那个 worktree path。
- 在 main checkout 创建的会话，会继续使用 main checkout。
- 如果某个 worktree 已被删除，它的历史会话仍会显示在项目下，方便你找回上下文。

Git 图谱详情的**关联会话**列表会显示可见、未归档且 `cwd` 与所选工作树路径匹配的会话，也会显示会话历史中有成功创建该工作树记录的会话。相同 Session ID 只显示一次。列表显示标题、短 Session ID，以及可读取时的活动状态。点击某一行会直接打开对应会话；如果从当前会话打开 Git 图谱，存在匹配项时会自动选中当前会话所在的工作树，也包括通过已核验创建记录识别出的关联工作树；没有关联会话时显示空状态。

### 如何阅读工作树标签

“按工作树”分组里，主 checkout 显示为“主线”；其他 linked worktree 显示其当前 checkout 的完整 Git branch 名称，detached HEAD 时显示目录路径。没有会话的 linked worktree 也会列出，便于直接在其中新建会话；新建会话不会再创建 Git worktree。

### 如何阅读工作树图谱状态

图谱时间线顶部的每一条提交行代表一个 Git commit，不是另一棵工作树：当前主线 HEAD 会标有 `HEAD`；较旧的 commit 是工作树扇出的基线或历史节点。该节点下面的工作树行才是具体 checkout。

图谱把 Git 位置和整合历史分开：

- **暂无提交增量**：当前 `HEAD` 位于主线的 first-parent 历史上，没有自己的 commit（快进合入主线后的 checkout 也是这个状态）。这不能证明工作区干净；未提交文件请看右侧详情。
- **有未合入提交**：当前 `HEAD` 含有尚未进入主线的 commit。这是 Git 关系，不单独代表候选已经达到待整合条件。
- **已合入主线**：这棵工作树的提交已经通过合并提交进入主线，但 checkout 仍然保留。

时间只用于显示或排序活动时间，不定义这些状态。

图谱里的 `领先 N、落后 M` 是明确的工作树拓扑估算：`落后` 是所选扇出基线到当前主线 HEAD 的 first-parent commit 距离；脱离主线 first-parent 的 HEAD 会统计越过主线边界可达的提交，仍在主线上的 HEAD 领先为 0。这不是远端 upstream 对称差集，也不是文件数或未提交修改数。列表里的 `WIP` 表示存在一个或多个未忽略的未提交条目；这些计数随图谱请求批量返回，右侧详情按需读取经过脱敏的文件名。Git 状态无法读取时会显示“状态未知”，不会伪装成干净工作区。

## 常见问题

**为什么我看不到 worktree 切换器？**
请确认当前选择的是 Git 仓库根目录。非 Git 目录和仓库子目录会显示一行轻提示，而不是切换器。

**为什么某个 branch 不能创建 worktree？**
Git 不允许同一个 branch 同时被多个 worktree checkout。你可以切到已有的 worktree，或者先删除那个 checkout。

**Git 里还有已经消失的 worktree 记录怎么办？**
Git 有时会保留 prunable worktree 记录。Pi Web 会过滤这些记录，不在切换器里显示。

**Explorer 和当前聊天看起来不在同一个分支？**
Explorer 跟随当前选择的 worktree；聊天跟随打开的会话。重新点击会话，可以把侧边栏切回这个会话所在的 checkout。
