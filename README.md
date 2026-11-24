# Harness 手册

Agent 架构笔记与交互实验。当前版本 **v0.2.0**（2026-11-24）。

这是一套个人 Harness 知识库。可以直接在 GitHub 读 Markdown，也可以在本地打开课程界面，在真实 Docker 沙箱里编辑并运行章节示例。

## 阅读顺序

| 章 | 内容 | 主要验证 |
| --- | --- | --- |
| 01 | [Agent Loop](content/chapters/01-agent-loop.md) | 模型、工具和停止条件 |
| 02 | [会话与上下文](content/chapters/02-session-context.md) | 分支与压缩保留原始历史 |
| 03 | [事件调度](content/chapters/03-dispatcher.md) | steer、follow-up 与跨会话路由 |
| 04 | [崩溃恢复](content/chapters/04-durable-execution.md) | 子进程退出后从磁盘恢复 |
| 05 | [动态工作流](content/chapters/05-workflow.md) | 并行分支与失败重跑 |
| 06 | [独立验收](content/chapters/06-verification.md) | 用失败证据驱动修复 |
| 07 | [Dreaming](content/chapters/07-dreaming.md) | 更新记忆并保留来源 |
| 08 | [总装与复盘](content/chapters/08-assembly.md) | 串起输入、执行、验收和记忆 |

补充索引：[Session、Run、Turn 和 Step](content/notes/runtime-boundaries.md) · [本地 Fast 基模烟测](content/notes/local-fast-baseline.md) · [Codex 跨会话通信源码导读](content/notes/codex-thread-routing.md)。

## 本地运行

需要 Node.js 22+ 和本机 Docker。启动 Docker 后执行：

```sh
npm ci
npm run check
npm run build
npm start
```

在浏览器打开 <http://127.0.0.1:41737/>。服务只监听本机。首次下载官方 Node 镜像后，示例在断网容器内执行。运行服务时可另开终端执行 `npm run test:live`，逐个回归教程场景。

`dist/agent-harness-lab.html` 可直接打开阅读。要编辑并运行代码，从本地服务进入。

## 本地基模烟测

启动本机 Magpie 后，通过 `HARNESS_MAGPIE_TOKEN` 提供本机凭据，再运行 `npm run test:model`。脚本在宿主侧使用 `codex/gpt-5.6-luna` 请求 Fast 档位，验证模型能发起工具调用并读回工具结果。请求档位与实际回传档位分别记录。

## 怎样继续维护

| 想更新什么 | 去哪里 |
| --- | --- |
| 修订正文、练习或参考资料 | [content/chapters/](content/chapters/) |
| 记下一条新方案、对照或架构取舍 | [content/notes/](content/notes/) |
| 改可运行示例或增减场景 | [src/harness-programs.mjs](src/harness-programs.mjs) |
| 调整篇目、显示版本与 GitHub 链接 | [content/library.json](content/library.json) |
| 回看已经发布的变化 | [CHANGELOG.md](CHANGELOG.md) 和 [Git 标签](https://github.com/xiaokhkh/harness-knowledge-lib/tags) |

每篇文档以 `---` 包住 JSON 元数据，后面是正常 Markdown。

- `id` 是链接、章节切换和实验共用的稳定标识。修正文案可以改标题或 `nav`，已有 `id` 保持原值。
- `introduced` 记录首次收入的版本，`reviewed` 记录最后一次查证或复跑日期，`tags` 用于索引。用 `status: "draft"` 标记待复核条目，`"verified"` 表示已查证。
- 需要新实验时，新增章节和配套同 ID 的程序。独立笔记可直接加入 `notes`，无需配套程序。
- 结论落在正文，同时保留对应的上游文档、源码或论文。修订结论时更新 `reviewed` 并在变更记录里注明原因。
- 发布时用 `npm version <版本号> --no-git-tag-version` 更新包版本和锁文件，同步更新 `content/library.json`，再在 CHANGELOG 增加条目。完成检查后提交，并打上 `vX.Y.Z` Git 标签。每个标签都能签出当时的正文和可运行示例。

`0.x` 期间，新章节或新增实验通常升次版本，修正文案和修复交互升修订版本。页眉的版本号可打开版本记录。

## 依赖与授权

使用 [coss ui](https://github.com/cosscom/ui) 的 MIT 组件，内嵌 [Cal Sans](https://github.com/calcom/sans)、[Paper Mono](https://github.com/paper-design/paper-mono) 和 Noto Sans SC。授权文件见 [assets/licenses/](assets/licenses/)。中文字体子集由系统中文字体补全新条目的字形。
