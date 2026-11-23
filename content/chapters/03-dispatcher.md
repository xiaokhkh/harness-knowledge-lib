---
{"id":"dispatcher","nav":"事件调度","introduced":"0.1.0","reviewed":"2026-11-23","status":"verified","tags":["运行时","事件日志"]}
---

# 让消息等在正确的位置

Agent 开始跑测试以后，宿主仍要收得到消息。外层 Dispatcher 管接收、排队、唤醒和取消。内层 Agent Loop 消费当前 run 的上下文，做完这一轮工作。

## 同一会话如何接两条消息

用户说「先给我看 diff」，属于 `steer`，在工具回合结束到下一次调用模型之间加入。用户说「做完后再补测试」，属于 `follow-up`，等当前 run 结束再启动。在示例里，工具由一个可控制完成时机的 Promise 表示，所以两类输入能在工具尚未结束时进入宿主。

## 按时间轴看边界

一个会话可以接收任意多条消息，同时只推进一个前台 run。生产实现里，Dispatcher 把待处理输入写到持久化 Inbox，用提交 ID 去重。工具回调携带 `runId` 和 `callId` 回到已有 run。取消是发给进行中步骤的信号，完成状态要等到执行器有结果再落盘。

OpenHands 的 V0 到 V1 迁移说明值得对照。它记录了早期 pub/sub 模型里的顺序和并发问题，也展示了新版如何让一次会话的推进顺序更容易理解。

## 在代码里试一下

运行「同时投递」，在输出里找到两次 host.run_started，看看「先给我看 diff」出现在哪一次模型请求。

## 预期结果

steer 进入第一轮的下一次模型请求。follow-up 启动第二次 run。

## 参考资料

- [OpenHands · V0 → V1](https://hub.openhands.dev/blog/the-path-to-openhands-v1)
- [Pi Durable · Inbox 示例](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/19-inbox.ts)
