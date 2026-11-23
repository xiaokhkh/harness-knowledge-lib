---
{"id":"runtime-boundaries","nav":"运行时边界","introduced":"0.1.0","reviewed":"2026-11-23","status":"verified","tags":["运行时","事件日志","恢复"]}
---

# Session、Run、Turn 和 Step

这四个概念分别决定历史怎么存、工作怎么调度、模型上下文怎么组装，以及失败后需要从哪里恢复。

| 概念 | 管什么 | 例子 |
| --- | --- | --- |
| Session | 多次交互共享的事件历史 | 一个项目对话可以包含数次 run |
| Run | 一次被用户消息或外部事件唤起的执行 | 修改两个模块并通过测试 |
| Turn | 一次模型请求及其产生的动作 | 模型读取工具结果，然后提出下一次调用 |
| Step | 有独立标识和状态、可以核对的执行单元 | 保存补丁意图、执行补丁、保存结果 |

## 两层循环怎么接

外层 Dispatcher 接收输入、入队、取消或恢复 run。内层 Agent Loop 组装请求、调用模型与工具，直到达到停止条件。工具完成事件带回原有 run 和调用 ID。这样读日志就能判断一次动作应该恢复原状态，还是发起独立工作。

## 查证顺序

- 新输入排队和插队看[事件调度章](../chapters/03-dispatcher.md)。
- 分开读取历史与模型窗口看[会话与上下文章](../chapters/02-session-context.md)。
- 写操作中途退出看[崩溃恢复章](../chapters/04-durable-execution.md)。

## 参考资料

- [Pi Durable · 会话、重放和检查点](https://earendil.com/posts/pi-durable/)
- [Anthropic · Session、Harness 与 Sandbox 的边界](https://www.anthropic.com/research/managed-agents)
