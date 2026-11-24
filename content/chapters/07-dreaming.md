---
{"id":"dreaming","nav":"Dreaming","introduced":"0.1.0","reviewed":"2026-11-24","status":"verified","tags":["记忆","上下文"]}
---

# 让下一次会话读到更新后的经验

会话结束，约定可能仍然有用。Dreaming 从历史收集有证据的经验，合并重复项、更新旧笔记，并挑出少量需要在新会话启动时加载的内容。

## 四层怎么读写

[![Anthropic 的四层记忆架构图。Dreaming 从会话记录回查证据，在笔记、知识表示和注入上下文之间整理信息。](https://assets.claude.com/a0bcfa203214d817d2b4261b7188aba8be6db5b2.png?w=1200)](https://assets.claude.com/a0bcfa203214d817d2b4261b7188aba8be6db5b2.png)

来源为 [Anthropic《The components of agent memory》图 1](https://www.anthropic.com/research/components-of-agent-memory)。

1. **原始会话记录**随交互写入。Agent 和 Dreaming 按需检索，用它核对笔记的证据。
2. **记忆笔记**由 Agent 在会话中记下值得保留的发现。之后的 Agent 按需读取，Dreaming 也可以对照原文纠正或合并笔记。
3. **知识表示**把多条笔记和原文组织成方便导航的结构，例如带交叉链接的 wiki。Agent 可以沿链接找到事实和来源，Dreaming 可以更新索引、补齐缺失页面。
4. **启动注入**保留少量常用约定和索引。Harness 每次开会话时主动加载这部分。Dreaming 可以提升常用条目，也可以把细节下移并留下链接。

## 让旧约定可追溯

第一次会话记下 `pnpm test`，第二次会话确认仓库已经改用 `npm test`。实验把确认事件提炼成两条独立笔记，用约定名建立可查找的知识表示，再生成启动索引。当前条目的 `supersedes` 指回旧约定的证据。新会话需要详情时，可以沿 `sessionId` 与 `eventId` 回查原始记录。

示例用显式确认事件做确定性归并。Claude Managed Agents 的 Dreams API 以异步任务读取已有记忆库和过去的会话，生成单独的输出记忆库。调用方审核后，可以把输出库挂到后续会话。输入库保留，便于重新整理或回用。[Claude Managed Agents · Dreams API](https://platform.claude.com/docs/en/managed-agents/dreams)

## 在代码里试一下

比较「运行 Dreaming」和「保留上一版记忆」。按顺序查看 `memory.transcripts`、`memory.notes`、`memory.representation` 和 `session.startup_context`，最后检查 `memory.source_event`。

## 预期结果

更新后的启动索引读到 `npm test`，来源是 `s-002` 的确认事件。使用上一版记忆时，启动索引仍读到 `pnpm test`。

## 参考资料

- [Anthropic · 四层架构与 Dreaming 实验](https://www.anthropic.com/research/components-of-agent-memory)
- [Claude Managed Agents · Dreams API](https://platform.claude.com/docs/en/managed-agents/dreams)
