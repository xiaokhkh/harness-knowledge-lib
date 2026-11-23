const sources = (...items) => items.map(item => typeof item === "string" ? item : item.toString()).join("\n\n");

const nodeImports = `import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";`;

function runWorkspaceTests(directory, path) {
  const testFile = join(directory, "limits.test.mjs");
  writeFileSync(testFile, [
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
    pass: result.status === 0, path, exitCode: result.status,
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

  submit(event) {
    trace("inbox.received", event);
    if (event.kind === "steer" && this.running) {
      this.steers.push(event);
      return;
    }
    this.queue.push(event);
    if (!this.running) this.running = this.drain();
  }

  async drain() {
    try {
      while (this.queue.length) {
        const event = this.queue.shift();
        trace("host.run_started", event.text);
        await this.run(event, () => this.steers.splice(0));
      }
    } finally {
      this.running = null;
    }
  }
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
    if (existing?.status === "done") {
      trace("step.reused", id);
      return existing.result;
    }
    if (existing?.status === "started") {
      const result = await recover();
      this.disk.write(id, { status: "done", result });
      trace("step.reconciled", { id, result });
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

function consolidate(sessions, previous = {}) {
  const notes = structuredClone(previous);
  for (const session of sessions) {
    for (const event of session.events) {
      if (event.type !== "project.convention_confirmed") continue;
      const { key, value } = event.data;
      const prior = notes[key];
      notes[key] = {
        value,
        source: { sessionId: session.id, eventId: event.id },
        supersedes: prior?.source ?? null
      };
    }
  }
  return notes;
}

function loadStartupIndex(notes) {
  return Object.entries(notes).slice(0, 3).map(([key, note]) => ({
    key, value: note.value, source: note.source
  }));
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
    scenarios: [["both", "同时投递 steer 与 follow-up"], ["follow", "只投递 follow-up"], ["steer", "只投递 steer"]],
    code: sources(Dispatcher, `// 用 promise 模拟一个仍在进行的工具调用。
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
  trace("host.run_finished", event.kind);
});

dispatcher.submit({ kind: "start", text: "修改购物车上限" });
if (scenario !== "follow") {
  dispatcher.submit({ kind: "steer", text: "先给我看 diff" });
}
if (scenario !== "steer") {
  dispatcher.submit({ kind: "follow-up", text: "做完后再补测试" });
}
finishTool();
await dispatcher.running;`)
  },
  {
    id: "durable",
    scenarios: [["after", "文件写完、结果落盘前中断"], ["before", "写入文件前中断"], ["conflict", "中断期间文件被其他操作修改"]],
    code: sources(nodeImports, createDemoDisk, Interrupted, StepRunner, patchStep, runPatchProcess, `const disk = createDemoDisk();
disk.write("cart.ts", "export const cartLimit = 1;");
const id = "patch-cart";
runPatchProcess(disk, id, scenario === "before" ? "before" : "after");

// 第一个 Node 进程已退出。下一进程从磁盘中的日志与文件恢复。
if (scenario === "conflict") disk.write("cart.ts", "export const cartLimit = 9;");
trace("process.restarting", disk.read(id));
console.log("恢复结果", runPatchProcess(disk, id, "resume"));
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
    code: sources(SessionStore, consolidate, loadStartupIndex, `const first = { id: "s-001", store: new SessionStore() };
first.store.append("project.convention_confirmed", { key: "testCommand", value: "pnpm test" });
const second = { id: "s-002", store: new SessionStore() };
second.store.append("message", { role: "user", content: "仓库已迁移到 npm" });
second.store.append("project.convention_confirmed", { key: "testCommand", value: "npm test" });

const snapshot = session => ({ id: session.id, events: session.store.branch() });
const previous = consolidate([snapshot(first)]);
trace("memory.previous", previous);
const notes = scenario === "stale" ? previous : consolidate([snapshot(second)], previous);
trace("memory.store", notes);
const index = loadStartupIndex(notes);
trace("session.startup_context", index);
const source = index[0].source;
const original = [first, second].find(session => session.id === source.sessionId);
trace("memory.source_event", original.store.events.find(event => event.id === source.eventId));`)
  },
  {
    id: "assembly",
    scenarios: [["recover", "写到一半中断并继续"], ["normal", "正常执行"], ["reject", "验收失败，保留证据"]],
    code: sources(
      nodeImports, runWorkspaceTests, SessionStore, buildContext, Dispatcher, runAgent,
      createDemoDisk, Interrupted, StepRunner, patchStep, runPatchProcess,
      WorkflowRunner, runWithVerification, consolidate, loadStartupIndex,
      `const session = new SessionStore();
const disk = createDemoDisk();
const paths = ["cart.ts", "stock.ts"];
disk.write(paths[0], "export const cartLimit = 1;");
disk.write(paths[1], "export const stockLimit = 1;");
const steps = new StepRunner(disk);

const dispatcher = new Dispatcher(async input => {
  session.append("message", { role: "user", content: input.text });
  const workflow = new WorkflowRunner(new Map(), {
    inspect(path) { return { path, original: disk.read(path) }; },
    merge(_, results) { return paths.map(path => results.get(path)); }
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
    async agent({ attempt, feedback }) {
      if (feedback) session.append("message", { role: "user", content: feedback });
      const path = attempt === 1 ? paths[0] : paths[1];
      const messages = buildContext(session.branch());
      let toolProposed = false;
      return runAgent({
        messages, tools, maxTurns: 2, runId: "attempt-" + attempt,
        model() {
          if (toolProposed || (scenario === "reject" && attempt > 1)) {
            return { answer: "提交本轮修改作为候选交付" };
          }
          toolProposed = true;
          return { tool: "patch_module", args: { path } };
        },
        record(message) {
          messages.push(message);
          session.append("message", message);
        }
      });
    },
    async verify() {
      const tests = paths.map(path => runWorkspaceTests(disk.root, path));
      const pending = tests.filter(test => !test.pass).map(test => test.path);
      return { pass: pending.length === 0, evidence: pending.length ? "仍需修改 " + pending.join(", ") : "两个模块均通过", tests };
    }
  });

  trace("delivery." + output.status, output);
  if (output.status === "completed") {
    session.append("project.convention_confirmed", { key: "testCommand", value: "npm test" });
    const notes = consolidate([{ id: "delivery-session", events: session.branch() }]);
    trace("next_session.startup_context", loadStartupIndex(notes));
  }
});

dispatcher.submit({ kind: "start", text: "更新购物车与库存上限，验收后记录测试约定" });
await dispatcher.running;`
    )
  }
];
