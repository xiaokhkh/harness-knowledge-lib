---
{"id":"dreaming","nav":"Dreaming","introduced":"0.1.0","reviewed":"2026-11-23","status":"verified","tags":["记忆","上下文"]}
---

# 让下一次会话读到更新后的经验

会话结束，约定可能仍然有用。Dreaming 从历史收集有证据的经验，合并重复项、更新旧笔记，并挑出少量需要在新会话启动时加载的内容。

## 四层分别放什么

Anthropic 的图从下往上是原始记录、提炼笔记、结构化知识和启动注入。这个实验保留两个会话作为来源，把确认过的测试命令整理成以约定名索引的项目知识，再把少量条目投影成启动索引。开新会话只需载入短索引，需要详情时沿 `sessionId` 与 `eventId` 回查。

## 让旧约定可追溯

第一次会话记下 `pnpm test`，第二次会话确认仓库已经改用 `npm test`。后台整理用新约定替代旧约定，并留下 `supersedes` 指针。切换场景可以看见，跳过整理时启动索引仍显示旧值。

示例使用显式确认事件做确定性归并。接 LLM 的版本可以允许模型从原文提出候选，再为候选保存来源、作用域和修订关系。对个人或项目记忆，优先让有来源的更新可被人检查。

## 在代码里试一下

比较「运行 Dreaming」和「保留上一版记忆」，然后检查 memory.source_event 指回哪个会话。

## 预期结果

更新后的启动索引读到 npm test，并引用 s-002 的确认事件。

## 参考资料

- [Anthropic · 四层架构与 Dreaming 实验](https://www.anthropic.com/research/components-of-agent-memory)
- [Claude Managed Agents · Dreams API](https://platform.claude.com/docs/en/managed-agents/dreams)
