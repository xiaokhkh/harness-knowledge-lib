---
{"id":"context","nav":"会话与上下文","introduced":"0.1.0","reviewed":"2026-11-23","status":"verified","tags":["上下文","事件日志"]}
---

# 让会话日志成为事实来源

模型窗口是一次请求能看见的内容。会话日志记录整段工作里发生过什么。拆出这两个概念，才有办法回看原始结果、从旧节点分叉，以及压缩以后继续执行。

## 事件怎么写

`SessionStore.append()` 给事件分配 ID，并通过 `parentId` 指向前一个节点。按写入顺序可以查看完整历史，沿父节点回溯可以重建当前分支。Pi 用 JSONL 保存这棵树。你用 SQLite 实现时，可以为会话、事件序号和父事件 ID 建索引。

## 上下文怎么读

`buildContext()` 走当前分支。遇到压缩事件时，把摘要放在保留消息前面。示例在工具回合结束后插入摘要，保留前一阶段的所有历史供查询。接真实模型时，压缩边界还要保证工具请求与对应结果的配对完整，并记录当时生效的指令。

压缩写入和上下文读取可以分开。后台任务生成摘要并追加事件。ContextBuilder 根据已有事件和预算重复组装请求，便于排查模型某一轮到底看见了什么。

## 在代码里试一下

比较「压缩后读取」和「从旧事件分叉」，观察 context.built 里的消息列表。

## 预期结果

压缩改变模型输入。分叉改变回溯路径。原始工具输出仍能在历史中查到。

## 参考资料

- [Pi · Session File Format](https://docs.pi.dev/latest/session-format)
- [Pi · Compaction Reference](https://docs.pi.dev/latest/compaction)
