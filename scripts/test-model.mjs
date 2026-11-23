import assert from "node:assert/strict";

const endpoint = "http://127.0.0.1:3425/v1/chat/completions";
const model = "codex/gpt-5.6-luna";
const serviceTier = "priority";
const token = process.env.HARNESS_MAGPIE_TOKEN?.trim();

if (!token) {
  console.error("请通过 HARNESS_MAGPIE_TOKEN 提供本机 Magpie 凭据。");
  process.exit(1);
}

const toolName = "add_integers";
const tools = [{
  type: "function",
  function: {
    name: toolName,
    description: "Add two integers and return the sum.",
    strict: true,
    parameters: {
      type: "object",
      properties: { left: { type: "integer" }, right: { type: "integer" } },
      required: ["left", "right"],
      additionalProperties: false
    }
  }
}];

async function complete(messages, toolChoice) {
  const started = performance.now();
  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(45_000),
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ model, service_tier: serviceTier, messages, tools, tool_choice: toolChoice })
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = String(body?.error?.message ?? "").replaceAll(token, "[redacted]").slice(0, 180);
    throw new Error("Magpie HTTP " + response.status + (detail ? " · " + detail : ""));
  }
  const choice = body?.choices?.[0];
  assert.ok(choice?.message, "Magpie 未返回 Chat Completions 消息。");
  const returnedTier = body.service_tier ?? null;
  if (returnedTier !== null && !["priority", "fast"].includes(returnedTier)) {
    throw new Error("回传档位不是 Fast，本次测试按失败处理。");
  }
  return {
    message: choice.message,
    responseModel: body.model ?? null,
    returnedTier,
    durationMs: Math.round(performance.now() - started)
  };
}

try {
  const user = {
    role: "user",
    content: "Call add_integers with left=19 and right=23. After reading the tool result, reply with HARNESS_OK= followed by the number. Use exactly that format."
  };
  const first = await complete([user], { type: "function", function: { name: toolName } });
  const calls = first.message.tool_calls;
  assert.ok(Array.isArray(calls) && calls.length === 1, "模型未返回预期的单次工具调用。");
  const call = calls[0];
  assert.ok(typeof call.id === "string" && call.id && call.type === "function" &&
    call.function?.name === toolName, "工具调用标识或名称无效。");
  const args = JSON.parse(call.function.arguments);
  assert.deepEqual(args, { left: 19, right: 23 });
  const result = args.left + args.right;
  const final = await complete([
    user,
    { role: "assistant", content: first.message.content ?? null, tool_calls: [call] },
    { role: "tool", tool_call_id: call.id, content: String(result) }
  ], "none");
  assert.equal(final.message.content?.trim(), "HARNESS_OK=42", "模型未确认工具结果。");
  console.log(JSON.stringify({
    requestedModel: model,
    requestedTier: serviceTier,
    responseModels: [first.responseModel, final.responseModel],
    returnedTiers: [first.returnedTier, final.returnedTier],
    durationMs: [first.durationMs, final.durationMs],
    tool: toolName,
    result
  }));
  if (!first.returnedTier || !final.returnedTier) {
    console.log("工具调用闭环通过。请求了 Fast，网关没有回传完整的实际服务档位。");
  } else {
    console.log("工具调用闭环通过，网关确认了 Fast 档位。");
  }
} catch (error) {
  console.error(String(error.message).replaceAll(token, "[redacted]"));
  process.exitCode = 1;
}
