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

Reader 不强制移除 checkout。发现未提交、未跟踪或忽略文件、关联会话历史或使用该目录的进程时，拒绝移除；服务端在操作时重新核对目录身份，无法确认另一 Reader 通道、完整会话清单（包括已删除会话文件）或进程检查结果时也拒绝。Windows 暂时无法核验进程，故拒绝此操作。检查只是瞬时快照，不是阻止其他工具并发启动的锁；网络超时属于结果未确认，不自动重试。

## 重命名 Worktree 的分支

在“按工作树”分组里，从工作树分组菜单选择“重命名分支”。Pi Web 对这个 worktree 当前 checkout 的分支执行 `git branch -m`；checkout 目录保持不变，在其中开始的会话继续使用原工作目录。detached HEAD 的 checkout 没有可重命名的分支。

## 会话和 Worktree 的关系

Pi Web 按 project root 分组会话，所以 main checkout 和 linked worktree 里的会话会显示在一起。

但每个会话仍然记得自己创建时的 working directory：

- 在某个 worktree 创建的会话，会继续使用那个 worktree path。
- 在 main checkout 创建的会话，会继续使用 main checkout。
- 如果某个 worktree 已被删除，它的历史会话仍会显示在项目下，方便你找回上下文。

Git 图谱详情的**关联会话**列表显示可见、未归档且 `cwd` 位于所选工作树内的会话、成功创建该工作树的会话，以及有已核验结构化 `pi-web:worktree-binding` 记录的会话。子 Agent 会话（包括嵌套子 Agent）投影到所属主会话，关系标签区分主会话和子会话的目录、创建或绑定；显示的活动状态属于主会话。无法解析主会话的孤儿或循环关系不单独显示。点击一行打开主会话；再次打开 Git 时，为该会话和设备保留刚才的来源工作树。其他情况下按实际目录或已核验创建记录选择；当前会话行有明确标记，没有关联会话时显示空状态。

关联历史按受限批次读取，优先处理当前会话。本机私有缓存可以在重新核验期间提示此前已确认的工作树；该提示是临时定位，不代表关联已复核，也不能作为移除许可。除非用户手动选择该工作树，工作区操作须等核验完成。已确认的关联会先显示，其余历史继续读取，未完成时不能移除工作树。工作树登记变化时仍可复用未变化的会话结果；对追加的历史先校验已读前缀再续读。读取失败、会话清单不完整或单条记录超过 32 MiB 时保守提示不完整，仍显示能确认的关联，不把未知结果当作没有关联；服务重启后重新扫描，同时可使用有效的本机提示定位。历史扫描只读取会话，不执行其中的命令。

打开 Git 项目的会话后，Reader 会在后台为该设备和当前会话预读一次图谱和一批关联历史；快速切换会话时会取消尚未开始的请求。预读会占用少量 CPU 和磁盘，仍只读取会话而不执行历史命令，也不能代替完整校验。

在同一页面短时间内重新打开图谱时，可先显示按设备隔离的内存快照和此前已确认的当前会话定位；快照最多保留五分钟，不写入浏览器存储。快照期间工作区状态显示未知，任何工作树操作都要等图谱刷新成功，即使手动选择也不能提前操作。刷新失败时保留只读快照并提示失败。图谱正在加载时，第一批历史结果之后最多等待 400 毫秒再继续扫描，避免持续扫描拖慢首次显示。

### 如何阅读工作树标签

“按工作树”分组里，主 checkout 显示为“主线”；其他 linked worktree 显示其当前 checkout 的完整 Git branch 名称，detached HEAD 时显示目录路径。没有会话的 linked worktree 也会列出，便于直接在其中新建会话；新建会话不会再创建 Git worktree。

### 如何阅读工作树图谱状态

图谱默认显示“全部”。`CURRENT` 标记包含当前会话实际工作目录的 checkout，子目录也归属其工作树；多棵工作树嵌套时选最深的一棵。旧设备不能解析子目录时不猜测标记。选中的节点可以与 `CURRENT` 不同，创建记录、结构化绑定和关联会话活动状态不会触发该标记。

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
