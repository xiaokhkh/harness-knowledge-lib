---
{"id":"durable","nav":"崩溃恢复","introduced":"0.1.0","reviewed":"2026-11-23","status":"verified","tags":["恢复","工具调用"]}
---

# 让工具步骤经得起重启

文件已经写好，工具结果还没落盘。这个窗口里进程一旦退出，恢复方只看到「步骤开始过」。它必须先核对外部状态，才能判断继续、重试还是请人确认。

## 写在执行前的调用意图

`StepRunner` 用稳定的步骤 ID 记录状态。开始前写入 `started`，完成后写入结果和 `done`。重启后可以复用 `done` 的结果。读文件一类操作通常可安全重跑，产生副作用的步骤要有自己的恢复策略。

## 两次状态读取，三种恢复结果

这个案例让补丁记住原文和期望的新内容。如果文件仍是原文，可以继续写。如果文件已等于期望内容，直接确认已完成。如果两边都对不上，示例返回 `unknown`。它可能遇到了人工修改，或者碰到另一次写入。真实工具应按各自能力返回需要的证据。

右侧让第一个 Node 子进程在指定位置以退出码 77 结束。第二个子进程读取同一容器里的文件与步骤日志并恢复。生产实现可以用 SQLite 存放步骤状态，并为外部调用传递幂等键或提供可核对的状态查询。

## 在代码里试一下

依次运行三个中断场景。数一下 workspace.patch_applied 出现几次，检查最后的文件值。

## 预期结果

已写入的补丁在恢复时被识别。第三个场景保留人工修改，并报告结果未知。

## 参考资料

- [Pi Durable · 恢复 walkthrough](https://github.com/earendil-works/explainer/blob/main/examples/durable/walkthrough.md)
- [Pi Durable · Persist and Resume](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md#persist-and-resume)
- [Pi Durable · CHANGELOG](https://github.com/earendil-works/pi/blob/main/packages/durable/CHANGELOG.md)
