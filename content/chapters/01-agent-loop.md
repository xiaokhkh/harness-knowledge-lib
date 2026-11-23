---
{"id":"loop","nav":"Agent Loop","introduced":"0.1.0","reviewed":"2026-11-23","status":"verified","tags":["运行时","工具调用"]}
---

# 模型提议，运行时执行

一轮 Agent 从用户消息开始。模型返回回答，或者提出一次工具调用。运行时执行工具，把结果作为下一轮输入。循环会在模型给出回答或预算用完时结束。

## 写出最小闭环

这里用购物车模块做例子。用户要求把上限从 1 改成 2，并确认测试通过。第一次模型调用只知道任务，先请求 `read_file`。读到文件后，它才能构造带原始上下文的补丁。修改结束后跑测试，退出码决定下一轮的结论。

工具定义是模型和运行时之间的协议。模型发出工具名和参数，宿主决定用进程、文件 API 还是数据库来实现。在这一章，三个工具操作容器工作区里的真实文件，并用子进程调用 `node --test`。规则模型按收到的工具结果给出下一步。

## 把退出条件写进循环

`maxTurns` 是模型回合数，某一轮发出的工具调用也计入这轮。把预算设成两轮后，文件已经改过，测试还没运行。日志应该停在 `run.stopped`，保留已发生的工具结果。后续几章会把这个临时数组变成可查询、可恢复的会话。

## 在代码里试一下

先跑一次「正常执行」，再切到「只允许两轮」。也可以在 scriptedModel 中把补丁右侧的 2 改成 3，再观察测试结果。

## 预期结果

正常场景依次出现 read_file、apply_patch、run_tests，然后是 run.finished。

## 参考资料

- [Pi · How Pi Works](https://docs.pi.dev/latest/how-pi-works)
- [Pi · agent-loop.ts](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts)
