---
{"id":"local-fast-baseline","nav":"本地 Fast 基模","introduced":"0.1.1","reviewed":"2026-11-23","status":"verified","tags":["模型","验收","工具调用"]}
---

# 本地 Fast 基模烟测

手册的真实模型烟测通过本机 Magpie 的 Chat Completions 入口 `127.0.0.1:3425/v1/chat/completions`，使用 `codex/gpt-5.6-luna` 并在每次请求上指定 `service_tier: "priority"`。

## 验证什么

首次请求要求模型发出 `add_integers(19, 23)` 工具调用。脚本核对工具名和参数，计算结果 42，再带着原调用 ID 把结果交给模型。第二次请求验证模型能读到并确认工具结果。

脚本分别打印请求档位和网关回传的档位。2026-11-23 本机实测取得 `HARNESS_OK=42`，两次响应都标记为 `codex/gpt-5.6-luna`。网关未回传实际档位，因此能确认已请求 Fast 和模型闭环通过。

## 怎么运行

在本机启动 Magpie，并通过环境变量 `HARNESS_MAGPIE_TOKEN` 提供本机凭据，然后运行 `npm run test:model`。脚本在宿主侧执行。原有 21 个教程场景仍用 `npm run test:live` 回归，继续在断网的 Docker 容器内运行。

## 参考资料

- [Magpie · OpenAI 连接与 Fast 档位](https://usemagpie.ai/docs/openai)
- [OpenAI · Chat Completions 参数](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
