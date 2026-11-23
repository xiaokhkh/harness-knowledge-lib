---
{"id":"workflow","nav":"动态工作流","introduced":"0.1.0","reviewed":"2026-11-23","status":"verified","tags":["编排","恢复"]}
---

# 把并发与依赖写成可执行计划

跨模块任务可以先并行调查，再汇总并修改。把这些关系交给 WorkflowRunner，模型提出计划，运行时负责每个节点何时开始、失败后如何继续。

## 先实现能读懂的三步计划

右侧的 `plan` 是两个阶段。第一阶段启动购物车和库存两个分析节点，第二阶段等前一阶段完成后汇总。每个节点有稳定 ID。编排器按 ID 缓存完成结果，所以库存分支重试时，购物车分析可以复用。

这个实验把计划写在代码里，便于看清运行时。接模型后，可以让它提交相同的结构化计划，再由宿主校验节点类型、依赖图、并发和预算。Claude 的动态工作流采用可执行脚本，子 Agent 在单独的会话线程里运行。

## 并行分析之后，写入如何协调

两个 Agent 同时读代码，通常可以直接并行。如果它们要改同一文件，工作区要明确共享与合并策略。简单可行的第一版是先并行分析，汇总后串行写入。每个子任务都应留下结果或失败原因，供父任务验收。

## 在代码里试一下

运行「库存分支失败一次」，搜索 workflow.step_reused，再对照两个分支都成功的轨迹。

## 预期结果

重试复用 inspect-cart，只重新执行失败的 inspect-stock，然后运行 merge。

## 参考资料

- [Claude Cookbook · Dynamic Workflows](https://platform.claude.com/cookbook/claude-agent-sdk-08-dynamic-workflows)
- [Claude Managed Agents · Workflow Runs](https://platform.claude.com/docs/en/managed-agents/workflow-runs)
