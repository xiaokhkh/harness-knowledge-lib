const sources = (...items) => items.map(item => typeof item === "string" ? item : item.toString()).join("\n\n");

const nodeImports = `import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";`;

function runWorkspaceTests(directory, path) {
  const testFile = "limits.test.mjs";
  writeFileSync(join(directory, testFile), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { readFileSync } from "node:fs";',
    'const filename = process.env.HARNESS_FIXTURE;',
    'test("configured limit is 2", () => {',
    '  const source = readFileSync(new URL(filename, import.meta.url), "utf8");',
    '  assert.match(source.trim(), /= 2;$/);',
    '});'
  ].join("\n"));
  const result = spawnSync(process.execPath, ["--test", testFile], {
    cwd: directory, encoding: "utf8", timeout: 1500,
    env: { ...process.env, HARNESS_FIXTURE: path }
  });
  return {
    pass: result.status === 0, path, exitCode: result.status, command: "node --test " + testFile,
    stdout: result.stdout?.trim(), stderr: result.error?.message ?? result.stderr?.trim()
  };
}

function createWorkspace() {
  const directory = mkdtempSync(join(process.cwd(), "exercise-"));
  writeFileSync(join(directory, "cart.ts"), "export const cartLimit = 1;");
  writeFileSync(join(directory, "stock.ts"), "export const stockLimit = 1;");
  return {
    read_file({ path }) {
      return readFileSync(join(directory, path), "utf8");
    },
    apply_patch({ path, before, after }) {
      const file = join(directory, path);
      if (readFileSync(file, "utf8") !== before) throw new Error("补丁上下文已变化");
      writeFileSync(file, after);
      return { path, updated: true };
    },
    run_tests({ path }) {
      return runWorkspaceTests(directory, path);
    }
  };
}

function scriptedModel(messages) {
  const results = messages.filter(message => message.role === "tool");
  const path = "cart.ts";
  if (results.length === 0) return { tool: "read_file", args: { path } };
  if (results.length === 1) {
    const before = results[0].result;
    return { tool: "apply_patch", args: { path, before, after: before.replace("1;", "2;") } };
  }
  if (results.length === 2) return { tool: "run_tests", args: { path } };
  return { answer: results.at(-1).result.pass ? "购物车上限已更新，测试通过。" : "测试未通过。" };
}

async function runAgent({
  model, tools, messages, maxTurns = 6, runId = "run",
  beforeTurn = () => {},
  record = message => messages.push(message)
}) {
  for (let turn = 1; turn <= maxTurns; turn++) {
    await beforeTurn();
    const reply = await model(messages);
    if (!reply.tool) {
      record({ role: "assistant", ...reply });
      trace("run.finished", reply.answer);
      return reply;
    }

    const callId = runId + "/call-" + turn;
    record({ role: "assistant", callId, ...reply });
    trace("tool.requested", { callId, tool: reply.tool, args: reply.args });
    const execute = tools[reply.tool];
    if (typeof execute !== "function") throw new Error("未知工具 " + reply.tool);
    const result = await execute(reply.args);
    record({ role: "tool", callId, result });
    trace("tool.result", { callId, result });
  }
  trace("run.stopped", "已达到模型回合预算");
  return { stopped: "budget" };
}

class SessionStore {
  constructor() {
    this.events = [];
  }

  append(type, data, parentId = this.events.at(-1)?.id ?? null) {
    const event = { id: this.events.length + 1, parentId, type, data: structuredClone(data) };
    this.events.push(event);
    return event.id;
  }

  branch(leaf = this.events.at(-1)?.id) {
    const result = [];
    const byId = new Map(this.events.map(event => [event.id, event]));
    while (leaf != null) {
      const event = byId.get(leaf);
      if (!event) throw new Error("会话分支缺少事件 " + leaf);
      result.unshift(event);
      leaf = event.parentId;
    }
    return result;
  }
}

function buildContext(events) {
  const index = events.findLastIndex(event => event.type === "context.compacted");
  const prefix = index < 0 ? [] : [{ role: "system", content: events[index].data.summary }];
  const messages = events.slice(index + 1)
    .filter(event => event.type === "message")
    .map(event => event.data);
  return [...prefix, ...messages];
}

class Dispatcher {
  constructor(run) {
    this.run = run;
    this.queue = [];
    this.steers = [];
    this.running = null;
  }

  submit(event, { wake = true } = {}) {
    trace("inbox.received", event);
    if (event.kind === "steer" && this.running) {
      this.steers.push(event);
      return;
    }
    this.queue.push(event);
    if (wake) this.wake();
  }

  wake() {
    // 占有运行槽位后，才在微任务中调用用户提供的处理器。
    if (!this.running && this.queue.length) this.running = Promise.resolve().then(() => this.drain());
    return this.running;
  }

  async drain() {
    try {
      while (this.queue.length) {
        const event = this.queue.shift();
        trace("host.run_started", event.text);
        try {
          await this.run(event, () => this.steers.splice(0));
          trace("host.run_finished", event.kind);
        } catch (error) {
          trace("host.run_failed", { event: event.text, error: error?.message ?? String(error) });
        } finally {
          // steer 属于当前 run，未消费的输入不能悄悄转给下一轮。
          if (this.steers.length) trace("host.steer_unconsumed", this.steers.splice(0));
        }
      }
    } finally {
      this.running = null;
    }
  }
}

class ThreadRouter {
  constructor(dispatchers) {
    this.dispatchers = dispatchers;
    this.accepted = new Map();
  }

  deliver(message, { wake = false } = {}) {
    const { from, to, id, text } = message;
    const target = this.dispatchers.get(to);
    if (!target) throw new Error("找不到目标会话 " + to);

    const received = this.accepted.get(to) ?? new Set();
    const key = JSON.stringify([from, id]);
    if (received.has(key)) {
      trace("router.duplicate", { from, to, id });
      return;
    }
    target.submit({ kind: "cross-thread", from, to, id, text }, { wake: false });
    received.add(key);
    this.accepted.set(to, received);
    trace("router.accepted", { from, to, id, wake });
    if (wake) target.wake();
  }
}

async function demonstrateRouting(wake) {
  // A、B 分别持有自己的历史。只有显式发送的信息进入 B。
  const historyA = ["A 的项目背景"];
  const historyB = ["B 的项目背景"];
  const received = [];
  const target = new Dispatcher(async event => {
    received.push(event.id);
    const context = [...historyB, event.text];
    trace("thread.context", { threadId: "B", messages: context });
  });
  const router = new ThreadRouter(new Map([["B", target]]));
  const message = { from: "A", to: "B", id: "review-1", text: "检查购物车测试" };
  router.deliver(message, { wake });
  router.deliver(message, { wake });
  trace("target.after_delivery", { threadId: "B", running: Boolean(target.running), pending: target.queue.length });
  if (!wake) {
    trace("target.explicit_wake", "B");
    target.wake();
  }
  await target.running;
  trace("thread.result", { threadId: "B", received, senderHistory: historyA });
}

function createDemoDisk(root = process.cwd()) {
  const journal = join(root, ".steps");
  mkdirSync(journal, { recursive: true });
  const location = key => ["cart.ts", "stock.ts"].includes(key)
    ? join(root, key)
    : join(journal, encodeURIComponent(key) + ".json");
  return {
    root,
    read(key) {
      const file = location(key);
      if (!existsSync(file)) return undefined;
      const data = readFileSync(file, "utf8");
      return file.endsWith(".json") ? JSON.parse(data) : data;
    },
    write(key, value) {
      const file = location(key);
      writeFileSync(file + ".tmp", file.endsWith(".json") ? JSON.stringify(value) : value);
      renameSync(file + ".tmp", file);
    }
  };
}

class Interrupted extends Error {}

class StepRunner {
  constructor(disk) {
    this.disk = disk;
  }

  async run(id, { action, recover }) {
    const existing = this.disk.read(id);
    if (existing?.status === "done" && existing.result?.status !== "unknown") {
      trace("step.reused", id);
      return existing.result;
    }
    if (existing) {
      const result = await recover();
      const status = result?.status === "unknown" ? "needs_review" : "done";
      this.disk.write(id, { status, result });
      trace(status === "done" ? "step.reconciled" : "step.needs_review", { id, result });
      return result;
    }
    this.disk.write(id, { status: "started" });
    trace("step.intent_saved", id);
    const result = await action();
    this.disk.write(id, { status: "done", result });
    trace("step.result_saved", { id, result });
    return result;
  }
}

function patchStep(disk, crashAt, path = "cart.ts") {
  const variable = path === "stock.ts" ? "stockLimit" : "cartLimit";
  const before = "export const " + variable + " = 1;";
  const after = "export const " + variable + " = 2;";
  const apply = () => {
    if (disk.read(path) !== before) throw new Error("补丁上下文已变化");
    disk.write(path, after);
    trace("workspace.patch_applied", path);
    return { applied: true };
  };
  return {
    action() {
      if (crashAt === "before") throw new Interrupted("写入文件前中断");
      const result = apply();
      if (crashAt === "after") throw new Interrupted("写入已完成，工具结果尚未保存");
      return result;
    },
    recover() {
      const current = disk.read(path);
      if (current === after) return { applied: true, verified: "after" };
      if (current === before) return { ...apply(), verified: "before" };
      return { applied: false, status: "unknown", reason: "文件已被其他操作修改" };
    }
  };
}

function runPatchProcess(disk, id, phase, path = "cart.ts") {
  const childFile = join(disk.root, "patch-worker.mjs");
  const program = [
    'import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";',
    'import { join } from "node:path";',
    createDemoDisk, Interrupted, StepRunner, patchStep,
    'const [id, phase, path] = process.argv.slice(2);',
    'const disk = createDemoDisk();',
    'const trace = (name, data) => writeSync(1, JSON.stringify({name, data}) + "\\n");',
    'trace("process.worker", { pid: process.pid, phase });',
    'try {',
    '  const crashAt = phase === "resume" ? undefined : phase;',
    '  const result = await new StepRunner(disk).run(id, patchStep(disk, crashAt, path));',
    '  trace("process.result", result);',
    '} catch (error) {',
    '  if (!(error instanceof Interrupted)) throw error;',
    '  trace("process.interrupted", error.message);',
    '  process.exit(77);',
    '}'
  ].map(String).join("\n");
  writeFileSync(childFile, program);
  const outcome = spawnSync(process.execPath, [childFile, id, phase, path], {
    cwd: disk.root, encoding: "utf8", timeout: 2000
  });
  for (const line of outcome.stdout?.trim().split("\n") ?? []) {
    if (!line) continue;
    const event = JSON.parse(line);
    trace(event.name, event.data);
  }
  const expected = phase === "resume" ? 0 : 77;
  if (outcome.status !== expected) throw new Error(outcome.error?.message ?? outcome.stderr.trim());
  return disk.read(id)?.result;
}

class WorkflowRunner {
  constructor(state, handlers) {
    this.state = state;
    this.handlers = handlers;
  }

  async run(plan) {
    for (const stage of plan) {
      const outcomes = await Promise.allSettled(stage.map(async task => {
        if (this.state.has(task.id)) {
          trace("workflow.step_reused", task.id);
          return this.state.get(task.id);
        }
        trace("workflow.step_started", task.id);
        const result = await this.handlers[task.kind](task.input, this.state);
        this.state.set(task.id, result);
        trace("workflow.step_done", { id: task.id, result });
        return result;
      }));
      const failure = outcomes.find(outcome => outcome.status === "rejected");
      if (failure) throw failure.reason;
    }
    return Object.fromEntries(this.state);
  }
}

async function runWithVerification({ agent, verify, maxAttempts = 2 }) {
  let feedback;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const proposal = await agent({ attempt, feedback });
    trace("agent.completion_proposed", { attempt, proposal });
    const result = await verify();
    trace("verify.result", { attempt, ...result });
    if (result.pass) return { status: "completed", attempt };
    feedback = result.evidence;
  }
  return { status: "failed", reason: "验收未通过", evidence: feedback };
}

function extractMemoryNotes(sessions) {
  const notes = [];
  for (const session of sessions) {
    for (const event of session.events) {
      if (event.type !== "project.convention_confirmed") continue;
      const { key, value } = event.data;
      notes.push({ key, value, source: { sessionId: session.id, eventId: event.id } });
    }
  }
  return notes;
}

function buildMemoryRepresentation(notes) {
  const byKey = new Map();
  for (const note of notes) {
    const prior = byKey.get(note.key);
    byKey.set(note.key, { ...note, supersedes: prior?.source ?? null });
  }
  return byKey;
}

function loadStartupIndex(representation) {
  return [...representation.values()].slice(0, 3).map(({ key, value, source }) => ({ key, value, source }));
}

export const programs = [
  {
    id: "loop",
    scenarios: [["normal", "正常执行"], ["budget", "只允许两轮"]],
    code: sources(nodeImports, runWorkspaceTests, createWorkspace, scriptedModel, runAgent, `// 本章入口。规则模型按工具结果决定下一步。
const messages = [{ role: "user", content: "把购物车上限改成 2，并跑测试" }];
const outcome = await runAgent({
  model: scriptedModel,
  tools: createWorkspace(),
  messages,
  maxTurns: scenario === "budget" ? 2 : 6
});
console.log("模型返回", outcome);`)
  },
  {
    id: "context",
    scenarios: [["compact", "压缩后读取"], ["full", "保留完整上下文"], ["branch", "从旧事件分叉"]],
    code: sources(SessionStore, buildContext, `const store = new SessionStore();
const first = store.append("message", { role: "user", content: "更新购物车上限" });
store.append("message", { role: "assistant", tool: "read_file", args: { path: "cart.ts" } });
store.append("message", { role: "tool", content: "原始文件：export const cartLimit = 1;" });
if (scenario === "compact") {
  store.append("context.compacted", { summary: "已确认 cart.ts 的上限为 1，目标改成 2。" });
}
const parent = scenario === "branch" ? first : store.events.at(-1).id;
store.append("message", { role: "user", content: "继续处理上限" }, parent);

trace("session.persisted", store.events);
trace("context.built", buildContext(store.branch()));
console.log("历史里的原始工具输出", store.events[2].data.content);`)
  },
  {
    id: "dispatcher",
    scenarios: [
      ["both", "同时投递 steer 与 follow-up"], ["follow", "只投递 follow-up"], ["steer", "只投递 steer"],
      ["cross-queue", "跨会话 · 只投递"], ["cross-wake", "跨会话 · 投递并唤醒"],
      ["failure", "首轮失败，队列继续"]
    ],
    code: sources(Dispatcher, ThreadRouter, demonstrateRouting, `if (scenario === "cross-queue" || scenario === "cross-wake") {
  await demonstrateRouting(scenario === "cross-wake");
} else if (scenario === "failure") {
  await demonstrateFailure();
} else {
  await demonstrateSteering();
}

async function demonstrateSteering() {
  // 用 promise 模拟一个仍在进行的工具调用。
  let finishTool;
  const tool = new Promise(resolve => { finishTool = resolve; });
  const dispatcher = new Dispatcher(async (event, takeSteers) => {
    if (event.kind === "start") {
      trace("agent.tool_running", "read_file(cart.ts)");
      await tool;
      trace("agent.tool_finished", "read_file(cart.ts)");
    }
    const messages = [event.text, ...takeSteers().map(item => item.text)];
    trace("model.next_request", messages);
  });

  dispatcher.submit({ kind: "start", text: "修改购物车上限" });
  if (scenario !== "follow") {
    dispatcher.submit({ kind: "steer", text: "先给我看 diff" });
  }
  if (scenario !== "steer") {
    dispatcher.submit({ kind: "follow-up", text: "做完后再补测试" });
  }
  finishTool();
  await dispatcher.running;
}

async function demonstrateFailure() {
  const dispatcher = new Dispatcher(event => {
    if (event.kind === "start") {
      dispatcher.submit({ kind: "follow-up", text: "补充测试" });
      throw new Error("第一轮工具失败");
    }
    trace("model.next_request", [event.text]);
  });
  dispatcher.submit({ kind: "start", text: "修改购物车" });
  dispatcher.submit({ kind: "steer", text: "先给我看 diff" });
  await dispatcher.running;
}`)
  },
  {
    id: "durable",
    scenarios: [["after", "文件写完、结果落盘前中断"], ["before", "写入文件前中断"], ["conflict", "文件冲突，人工核对后恢复"]],
    code: sources(nodeImports, createDemoDisk, Interrupted, StepRunner, patchStep, runPatchProcess, `const disk = createDemoDisk();
disk.write("cart.ts", "export const cartLimit = 1;");
const id = "patch-cart";
runPatchProcess(disk, id, scenario === "before" ? "before" : "after");

// 第一个 Node 进程已退出。下一进程从磁盘中的日志与文件恢复。
if (scenario === "conflict") disk.write("cart.ts", "export const cartLimit = 9;");
trace("process.restarting", disk.read(id));
console.log("恢复结果", runPatchProcess(disk, id, "resume"));
if (scenario === "conflict") {
  trace("workspace.conflict_preserved", { file: disk.read("cart.ts"), status: disk.read(id).status });
  // 模拟人工核对后把文件修正为预期内容，再由新的进程确认。
  disk.write("cart.ts", "export const cartLimit = 2;");
  trace("workspace.conflict_resolved", disk.read("cart.ts"));
  runPatchProcess(disk, id, "resume");
}
runPatchProcess(disk, id, "resume");
console.log("最终文件", disk.read("cart.ts"));`)
  },
  {
    id: "workflow",
    scenarios: [["retry", "库存分支失败一次"], ["success", "两个分支均成功"]],
    code: sources(WorkflowRunner, `// 运行时可以接收 Agent 提议的同一份结构化计划。
const plan = [
  [
    { id: "inspect-cart", kind: "inspect", input: "cart.ts" },
    { id: "inspect-stock", kind: "inspect", input: "stock.ts" }
  ],
  [{ id: "merge", kind: "merge" }]
];
const state = new Map();
let failStock = scenario === "retry";
const handlers = {
  async inspect(path) {
    await new Promise(resolve => setTimeout(resolve, path === "cart.ts" ? 30 : 55));
    if (path === "stock.ts" && failStock) {
      failStock = false;
      throw new Error("库存分析暂时失败");
    }
    return { path, recommendation: "把上限改为 2" };
  },
  merge(_, results) {
    return [results.get("inspect-cart"), results.get("inspect-stock")];
  }
};

const runner = new WorkflowRunner(state, handlers);
try {
  await runner.run(plan);
} catch (error) {
  trace("workflow.retry", error.message);
  await runner.run(plan);
}
console.log("汇总结果", state.get("merge"));`)
  },
  {
    id: "verify",
    scenarios: [["repair", "首次验收失败，随后修复"], ["pass", "首次验收通过"], ["exhaust", "修复后仍不通过"]],
    code: sources(nodeImports, runWorkspaceTests, createWorkspace, runWithVerification, `const workspace = createWorkspace();
const path = "cart.ts";
const outcome = await runWithVerification({
  async agent({ attempt, feedback }) {
    if (scenario === "pass" || (attempt === 2 && scenario === "repair")) {
      const before = workspace.read_file({ path });
      workspace.apply_patch({ path, before, after: before.replace("1;", "2;") });
    }
    if (feedback) trace("agent.received_feedback", feedback);
    return "提交购物车修改作为候选交付";
  },
  async verify() {
    const test = workspace.run_tests({ path });
    return {
      pass: test.pass,
      evidence: test.pass ? "cart 测试通过" : "cart.ts 的期望上限是 2，实测文件仍为 1"
    };
  }
});
trace("run." + outcome.status, outcome);`)
  },
  {
    id: "dreaming",
    scenarios: [["refresh", "运行 Dreaming 后开启新会话"], ["stale", "保留上一版记忆"]],
    code: sources(SessionStore, extractMemoryNotes, buildMemoryRepresentation, loadStartupIndex, `const first = { id: "s-001", store: new SessionStore() };
first.store.append("project.convention_confirmed", { key: "testCommand", value: "pnpm test" });
const second = { id: "s-002", store: new SessionStore() };
second.store.append("message", { role: "user", content: "仓库已迁移到 npm" });
second.store.append("project.convention_confirmed", { key: "testCommand", value: "npm test" });

const transcripts = [first, second].map(({ id, store }) => ({ id, events: store.branch() }));
trace("memory.transcripts", transcripts);
const notes = extractMemoryNotes(scenario === "stale" ? transcripts.slice(0, 1) : transcripts);
trace("memory.notes", notes);
const representation = buildMemoryRepresentation(notes);
trace("memory.representation", Object.fromEntries(representation));
const index = loadStartupIndex(representation);
trace("session.startup_context", index);
const source = index[0].source;
const original = transcripts.find(session => session.id === source.sessionId);
trace("memory.source_event", original.events.find(event => event.id === source.eventId));`)
  },
  {
    id: "assembly",
    scenarios: [
      ["recover", "写到一半中断并继续"], ["normal", "正常执行"],
      ["stock-first", "将库存设为优先修改项"], ["reject", "验收失败，保留证据"]
    ],
    code: sources(
      nodeImports, runWorkspaceTests, SessionStore, buildContext, Dispatcher, runAgent,
      createDemoDisk, Interrupted, StepRunner, patchStep, runPatchProcess,
      WorkflowRunner, runWithVerification, extractMemoryNotes, buildMemoryRepresentation, loadStartupIndex,
      `const session = new SessionStore();
const disk = createDemoDisk();
const paths = ["cart.ts", "stock.ts"];
const priority = scenario === "stock-first" ? [...paths].reverse() : paths;
disk.write(paths[0], "export const cartLimit = 1;");
disk.write(paths[1], "export const stockLimit = 1;");
const steps = new StepRunner(disk);

const dispatcher = new Dispatcher(async input => {
  session.append("message", { role: "user", content: input.text });
  const workflow = new WorkflowRunner(new Map(), {
    inspect(path) {
      const original = disk.read(path);
      return { path, original, needsPatch: !original.trim().endsWith("= 2;") };
    },
    merge(_, results) { return priority.map(path => results.get(path)); }
  });
  const analysis = await workflow.run([
    paths.map(path => ({ id: path, kind: "inspect", input: path })),
    [{ id: "merge", kind: "merge" }]
  ]);
  session.append("workflow.result", analysis.merge);

  const tools = {
    async patch_module({ path }) {
      const stepId = "patch:" + path;
      if (scenario === "recover" && path === paths[0]) {
        runPatchProcess(disk, stepId, "after", path);
        return runPatchProcess(disk, stepId, "resume", path);
      }
      return steps.run(stepId, patchStep(disk, undefined, path));
    }
  };

  const output = await runWithVerification({
    async agent({ attempt }) {
      const events = session.branch();
      // 上下文保留工作流与验收器的来源，消息仍走原有投影。
      const context = {
        messages: buildContext(events),
        analysis: events.findLast(event => event.type === "workflow.result").data,
        verification: events.findLast(event => event.type === "verification.result")?.data.evidence ?? null
      };
      let toolProposed = false;
      return runAgent({
        messages: context.messages, tools, maxTurns: 2, runId: "attempt-" + attempt,
        model(messages) {
          if (toolProposed) return { answer: "提交本轮修改作为候选交付" };
          const request = { ...context, messages };
          const candidates = request.verification
            ? [...request.verification.pending]
            : request.analysis.filter(item => item.needsPatch).map(item => item.path);
          const [path] = candidates;
          trace("assembly.model_input", { analysis: request.analysis, verification: request.verification, candidates });
          if (!path || (scenario === "reject" && request.verification)) {
            return { answer: "提交本轮修改作为候选交付" };
          }
          toolProposed = true;
          return { tool: "patch_module", args: { path } };
        },
        record(message) {
          context.messages.push(message);
          session.append("message", message);
        }
      });
    },
    async verify() {
      const tests = paths.map(path => runWorkspaceTests(disk.root, path));
      const pending = tests.filter(test => !test.pass).map(test => test.path);
      const evidence = { pending, summary: pending.length ? "仍需修改 " + pending.join(", ") : "两个模块均通过" };
      const result = { pass: pending.length === 0, evidence, tests };
      session.append("verification.result", result);
      return result;
    }
  });

  trace("delivery." + output.status, output);
  if (output.status === "completed") {
    const verification = session.events.at(-1);
    const noteEventId = session.append("project.convention_confirmed", {
      key: "testCommand", value: verification.data.tests[0].command, evidenceEventId: verification.id
    });
    const notes = extractMemoryNotes([{ id: "delivery-session", events: session.branch() }]);
    trace("next_session.startup_context", loadStartupIndex(buildMemoryRepresentation(notes)));
    trace("memory.source_event", session.branch(noteEventId).at(-1));
  }
});

dispatcher.submit({ kind: "start", text: "更新购物车与库存上限，验收后记录测试约定" });
await dispatcher.running;`
    )
  }
];
