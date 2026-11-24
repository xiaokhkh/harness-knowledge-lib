---
{"id":"codex-thread-routing","nav":"Codex 跨会话通信","introduced":"0.2.0","reviewed":"2026-11-24","status":"verified","tags":["运行时","事件日志","跨会话通信","源码导读"]}
---

# Codex 跨会话通信

**归入[事件调度](../chapters/03-dispatcher.md)的宿主层。** 路由器负责找到目标会话，Inbox 保存尚待处理的输入，目标 Dispatcher 决定何时启动或继续执行。Agent Loop 只消费当前会话获得的输入。

> 发送方 → 按 threadId 定位目标 → 目标 Inbox → 目标 Dispatcher → 目标 Agent Loop

## 公开代码从哪读

先读 [openai/codex](https://github.com/openai/codex) 的 [App Server README](https://github.com/openai/codex/tree/main/codex-rs/app-server)。本笔记的源码链接固定到复核时的提交，便于以后对比演进。

| 查什么 | 开源入口 |
| --- | --- |
| 已有会话怎样接收排队的用户输入 | [#39092](https://github.com/openai/codex/pull/39092) 增加 `codex queue`，接到 `thread/queue/add`。当前[队列服务](https://github.com/openai/codex/blob/9ba0ceac1ae9a72b1198f492a252b12c061ae399/codex-rs/ext/queue/src/service.rs) 按线程发现队列变化并派发。 |
| 同一 Agent 树内，投递和唤醒如何分开 | [消息工具源码](https://github.com/openai/codex/blob/9ba0ceac1ae9a72b1198f492a252b12c061ae399/codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs) 显示 `send_message` 和 `followup_task` 共享提交链路，由消息语义决定是否立即唤醒。 |
| 空闲根会话如何被唤醒 | [#54961](https://github.com/openai/codex/pull/54961) 在功能开关后加入对应行为。可继续看[输入入口](https://github.com/openai/codex/blob/9ba0ceac1ae9a72b1198f492a252b12c061ae399/codex-rs/core/src/session/turn_input.rs)如何做启动与转向的判定。 |
| 为什么回执只说明已接受 | [#61894](https://github.com/openai/codex/pull/61894) 增加接收回执，并为非根目标说明何时用 `followup_task` 立即唤醒。 |

## 厘清桌面工具与开源运行时

桌面层有按会话读取、等待和发送跟进消息的工具。公开的桌面 [#40852](https://github.com/openai/codex/issues/40852) 记录了这些接口在某个版本中的可见性差异。该 issue 可作接口线索。上表两个有源码的链路分别是 **App Server 的用户输入队列**和 **Codex Core 的 Agent 消息**，没有证据表明桌面 `send_message_to_thread` 与其中任一链路完全相同。

## 手册实验的设计边界

第 3 章用内存路由器演示两个独立会话、目标 Inbox、显式唤醒和重复投递。消息 ID 在目标会话内去重。宿主对发件身份和目标访问权限做的校验，以及跨进程的持久化，属于真实实现需要加在路由器与队列之间的边界。排队成功可以立即返回回执，目标完成由后续事件表达。

## 参考资料

- [OpenAI · Codex App Server 架构](https://openai.com/index/unlocking-the-codex-harness/)
- [Codex App Server 协议 · turn/start 与 turn/steer](https://learn.chatgpt.com/docs/app-server)
- [Codex CLI · queue](https://learn.chatgpt.com/docs/developer-commands#codex-queue)
