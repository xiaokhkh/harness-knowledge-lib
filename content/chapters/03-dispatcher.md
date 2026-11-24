---
{"id":"dispatcher","nav":"事件调度","introduced":"0.1.0","reviewed":"2026-11-24","status":"verified","tags":["运行时","事件日志","跨会话通信"]}
---

# 让消息等在正确的位置

Agent 开始跑测试以后，宿主仍要收得到消息。外层 Dispatcher 管接收、排队、唤醒和取消。内层 Agent Loop 消费当前 run 的上下文，做完这一轮工作。

## 同一会话如何接两条消息

用户说「先给我看 diff」，属于 `steer`，在工具回合结束到下一次调用模型之间加入。用户说「做完后再补测试」，属于 `follow-up`，等当前 run 结束再启动。在示例里，工具由一个可控制完成时机的 Promise 表示，所以两类输入能在工具尚未结束时进入宿主。

## 按时间轴看边界

一个会话可以接收任意多条消息，同时只推进一个前台 run。生产实现里，Dispatcher 把待处理输入写到持久化 Inbox，用提交 ID 去重。工具回调携带 `runId` 和 `callId` 回到已有 run。取消是发给进行中步骤的信号，完成状态要等到执行器有结果再落盘。

OpenHands 的 V0 到 V1 迁移说明值得对照。它记录了早期 pub/sub 模型里的顺序和并发问题，也展示了新版如何让一次会话的推进顺序更容易理解。

## 跨会话消息交给谁

**归属是宿主层事件调度。** 路由器先用 `threadId` 找目标会话，再把消息交给目标 Inbox。目标 Dispatcher 决定排队还是唤醒。它运行时用自己的会话历史组装上下文。发送方的历史继续留在自己的会话里，需要随消息交接的内容由发送方明确提供。

把**投递成功**和**任务完成**做成不同事件。投递回执说明运行时接受了消息。结果要等目标 run 结束后再读取。生产实现还要明确发送者、目标会话和唤醒权限。同一条消息重试时可按消息 ID 去重。见 [Codex 跨会话通信源码导读](../notes/codex-thread-routing.md)。

## 在代码里试一下

运行「同时投递」，看 steer 和 follow-up 分别进哪一轮。然后比较「跨会话 · 只投递」和「跨会话 · 投递并唤醒」，观察目标会话 B 何时出现 host.run_started。

## 预期结果

steer 进入第一轮的下一次模型请求。follow-up 启动第二次 run。只投递时，B 在收到显式唤醒前没有启动。投递并唤醒时，B 直接进入运行。两种场景都把同一条消息送两次，B 只消费一次。

## 参考资料

- [OpenHands · V0 → V1](https://hub.openhands.dev/blog/the-path-to-openhands-v1)
- [Pi Durable · Inbox 示例](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/19-inbox.ts)
- [OpenAI · Codex App Server 架构](https://openai.com/index/unlocking-the-codex-harness/)
