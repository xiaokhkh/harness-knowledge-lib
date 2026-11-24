import assert from "node:assert/strict";
import { programs } from "../src/harness-programs.mjs";

export const cases = programs.flatMap(({ id, code, scenarios }) =>
  scenarios.map(([scenario]) => ({ id, code, scenario })));

export function assertScenario({ id, scenario }, events) {
  const named = name => events.filter(event => event.name === name).map(event => event.data);
  const first = name => {
    const event = events.find(item => item.name === name);
    assert(event, "缺少 " + name);
    return event.data;
  };
  const order = (...names) => {
    let position = -1;
    for (const name of names) {
      position = events.findIndex((event, index) => index > position && event.name === name);
      assert(position >= 0, "事件顺序应为 " + names.join(" → "));
    }
  };

  if (id === "loop") {
    if (scenario === "budget") {
      assert.equal(named("tool.requested").length, 2);
      first("run.stopped");
    } else {
      assert(named("tool.result").some(result => result.result?.stdout?.includes("configured limit is 2")));
      first("run.finished");
    }
  }

  if (id === "dispatcher" && scenario.startsWith("cross-")) {
    const wake = scenario === "cross-wake";
    assert.deepEqual(first("target.after_delivery"), { threadId: "B", running: wake, pending: 1 });
    assert.deepEqual(first("thread.context").messages, ["B 的项目背景", "检查购物车测试"]);
    assert.deepEqual(first("thread.result").received, ["review-1"]);
    first("router.duplicate");
    order("router.accepted", wake ? "target.after_delivery" : "target.explicit_wake", "host.run_started");
  }

  if (id === "dispatcher" && scenario === "failure") {
    assert.deepEqual(named("host.run_started"), ["修改购物车", "补充测试"]);
    order("host.run_started", "host.run_failed", "host.steer_unconsumed", "host.run_started", "host.run_finished");
    assert.deepEqual(named("model.next_request"), [["补充测试"]]);
  }

  if (id === "dispatcher" && ["both", "follow", "steer"].includes(scenario)) {
    const messages = [["修改购物车上限"]];
    if (scenario !== "follow") messages[0].push("先给我看 diff");
    if (scenario !== "steer") messages.push(["做完后再补测试"]);
    assert.deepEqual(named("model.next_request"), messages);
  }

  if (id === "durable") {
    const workers = named("process.worker");
    assert.equal(new Set(workers.map(worker => worker.pid)).size, scenario === "conflict" ? 4 : 3);
    if (scenario === "conflict") {
      assert.equal(first("step.needs_review").result.status, "unknown");
      assert.deepEqual(first("workspace.conflict_preserved"), {
        file: "export const cartLimit = 9;", status: "needs_review"
      });
      order("step.needs_review", "workspace.conflict_resolved", "step.reconciled", "step.reused");
      assert.equal(first("step.reconciled").result.verified, "after");
    } else {
      assert.equal(first("step.reconciled").result.verified, scenario);
    }
    assert.deepEqual(named("workspace.patch_applied"), ["cart.ts"]);
  }

  if (id === "workflow" && scenario === "retry") {
    assert.deepEqual(named("workflow.step_reused"), ["inspect-cart"]);
    order("workflow.retry", "workflow.step_reused", "workflow.step_done");
  }

  if (id === "verify") {
    const pass = scenario !== "exhaust";
    assert.deepEqual(named("verify.result").map(result => result.pass), scenario === "pass" ? [true] : [false, pass]);
    first(pass ? "run.completed" : "run.failed");
  }

  if (id === "dreaming") {
    const refresh = scenario === "refresh";
    const value = refresh ? "npm test" : "pnpm test";
    assert.equal(named("memory.notes")[0].length, refresh ? 2 : 1);
    assert.equal(first("memory.representation").testCommand.supersedes?.sessionId ?? null, refresh ? "s-001" : null);
    assert.equal(first("session.startup_context")[0].source.sessionId, refresh ? "s-002" : "s-001");
    assert.equal(first("memory.source_event").data.value, value);
  }

  if (id === "assembly") {
    const stockFirst = scenario === "stock-first";
    const paths = stockFirst ? ["stock.ts", "cart.ts"] : ["cart.ts", "stock.ts"];
    const rejected = scenario === "reject";
    const inputs = named("assembly.model_input");
    assert.deepEqual(inputs[0].candidates, paths);
    assert.deepEqual(inputs[1].verification.pending, paths.slice(1));
    assert.deepEqual(named("tool.requested").map(event => event.args.path), rejected ? paths.slice(0, 1) : paths);
    first(rejected ? "delivery.failed" : "delivery.completed");
    if (rejected) {
      assert.equal(named("next_session.startup_context").length, 0);
    } else {
      const source = first("memory.source_event");
      const startup = first("next_session.startup_context")[0];
      assert.equal(startup.source.eventId, source.id);
      assert.equal(startup.value, named("verify.result").at(-1).tests[0].command);
      assert.equal(source.data.evidenceEventId, source.parentId);
    }
    if (scenario === "recover") order("process.interrupted", "step.reconciled", "next_session.startup_context");
  }
}
