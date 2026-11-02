# 0006 — 模型配置保存不自动修改 enabledModels

## 状态

Accepted.

## 背景

Reader 同时有两类模型状态：

- `models.json` 保存 Provider、模型定义、模型元数据和 `hiddenModels`；
- `settings.json` 的 `enabledModels` 保存可选的模型范围，用于模型列表、初始模型和模型循环。

当模型配置面板保存、导入、删除或重命名模型时，过去会重新同步并可能创建或重写 `enabledModels`。在没有明确模型范围的情况下，这些 Provider glob 与 Pi 默认的“所有可用模型”语义重复，却会产生 stale pattern、Provider 重命名和删除模型后的维护问题。

Reader 的单模型隐藏已经由 `models.json` 顶层的 `hiddenModels` 提供，不需要通过生成 `enabledModels` 实现。

## 决策

- `models.json` 的保存、导入、删除和重命名流程不得创建或重写 `enabledModels`。
- 模型配置面板保存后只刷新启用范围的读取视图，不执行 scope resync。
- Provider 重命名可以继续迁移 `defaultProvider`，但不迁移 `enabledModels`。
- Reader 继续读取已有的 `enabledModels`，并保留显式模型范围 API 的兼容性；只有用户明确操作模型范围开关时才写入它。
- `hiddenModels` 继续作为模型显示隐藏的真源；它不改变 Provider 配置，也不依赖 `enabledModels`。
- 默认没有 `enabledModels` 时，Reader 使用所有当前可用模型；模型默认值和模型级 `defaultThinkingLevel` 继续由各自配置负责。

## 后果

- 删除或修改模型不会因为模型配置保存而制造新的 `enabledModels` 条目。
- 清理现有全量 Provider glob 后，模型发现、认证、默认模型、模型配置和 `hiddenModels` 不受影响。
- 如果用户明确保留一个手工模型范围，删除其中的模型不再由模型配置保存流程替用户维护该范围；该范围属于显式设置，仍可通过显式 scope 操作清理。
- `enabledModels` 中旧的 `:thinkingLevel` pin 仍可兼容读取；新配置应优先使用模型级默认推理等级或会话级显式选择。
