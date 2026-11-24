import assert from "node:assert/strict";
import { programs } from "../src/harness-programs.mjs";

const origin = "http://127.0.0.1:41737";
const headers = { Origin: origin, "Content-Type": "application/json" };


async function run(code, scenario = "test", more = {}) {
  const response = await fetch(origin + "/api/run", {
    method: "POST", headers, body: JSON.stringify({ code, scenario }), ...more
  });
  assert.equal(response.status, 200, "Sandbox status " + response.status);
  return (await response.text()).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}
function verifyFinish(events, reason = "ok") {
  const end = events.at(-1);
  assert.equal(end?.type, "finish", JSON.stringify(events).slice(-3000));
  assert.equal(end.reason, reason, JSON.stringify(events).slice(-3000));
  if (reason === "ok") assert.equal(end.exitCode, 0);
  return end;
}
const find = (events, name) => events.find(event => event.name === name);
assert.equal((await fetch(origin + "/api/sandbox")).status, 200);
const blocked = await fetch(origin + "/api/run", {
  method: "POST", headers: { ...headers, Origin: "http://invalid.local" },
  body: JSON.stringify({ code: "console.log('should not run')", scenario: "test" })
});
assert.equal(blocked.status, 403);

const isolation = await run(`
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { spawnSync } from "node:child_process";
assert.equal(process.platform, "linux");
assert.equal(process.getuid(), 1000);
assert.equal(process.cwd(), "/workspace");
assert.equal(existsSync("/var/run/docker.sock"), false);
assert.deepEqual(Object.keys(networkInterfaces()), ["lo"]);
assert.throws(() => writeFileSync("/usr/local/harness-test", "blocked"), error => ["EACCES","EROFS"].includes(error.code));
writeFileSync("isolation-marker", "persist inside this container");
assert.equal(readFileSync("isolation-marker", "utf8"), "persist inside this container");
assert.equal(spawnSync(process.execPath, ["--eval", "process.stdout.write('child-worked')"], {encoding:"utf8"}).stdout, "child-worked");
trace("isolation.checked", {
  platform: process.platform, uid: process.getuid(), workdir: process.cwd(),
  network: Object.keys(networkInterfaces()), version: process.version,
  memory: readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim(),
  pids: readFileSync("/sys/fs/cgroup/pids.max", "utf8").trim()
});
`);
verifyFinish(isolation);
const checked = find(isolation, "isolation.checked").data;
assert.equal(Number(checked.memory), 192 * 1024 * 1024);
assert.equal(Number(checked.pids), 48);
console.log("隔离边界已验证", checked);
const next = await run('import assert from "node:assert/strict"; import {existsSync} from "node:fs"; assert.equal(existsSync("isolation-marker"),false);');
verifyFinish(next);

const cases = programs.flatMap(program => program.scenarios.map(([scenario]) => ({ ...program, scenario })));
let cursor = 0;
async function worker() {
  for (;;) {
    const job = cases[cursor++];
    if (!job) return;
    const events = await run(job.code, job.scenario);
    verifyFinish(events);
    if (job.id === "loop" && job.scenario === "normal") {
      assert(events.some(event => event.data?.result?.stdout?.includes("configured limit is 2")));
    }
    if (job.id === "dispatcher" && job.scenario.startsWith("cross-")) {
      const wake = job.scenario === "cross-wake";
      const eventIndex = name => events.findIndex(event => event.name === name);
      assert.equal(find(events, "target.after_delivery").data.running, wake);
      assert.equal(find(events, "target.after_delivery").data.pending, wake ? 0 : 1);
      assert.deepEqual(find(events, "thread.context").data.messages, ["B 的项目背景", "检查购物车测试"]);
      assert.deepEqual(find(events, "thread.result").data.received, ["review-1"]);
      assert(find(events, "router.duplicate"));
      assert(eventIndex("router.accepted") < eventIndex("host.run_started"));
      if (!wake) assert(eventIndex("target.explicit_wake") < eventIndex("host.run_started"));
    }
    if (job.id === "durable") {
      const pids = new Set(events.filter(event => event.name === "process.worker").map(event => event.data.pid));
      assert.equal(pids.size, 3);
      if (job.scenario === "conflict") assert.equal(find(events,"step.reconciled").data.result.status,"unknown");
    }
    if (job.id === "assembly" && job.scenario === "recover") {
      assert(find(events, "next_session.startup_context"));
      assert(find(events, "process.interrupted"));
    }
    console.log(job.id, job.scenario, events.length);
  }
}
await Promise.all([worker(), worker()]);
const failed = await run('throw new Error("ACTUAL_PROCESS_ERROR")');
assert.equal(verifyFinish(failed, "exit").exitCode, 1);
assert(failed.some(event => event.name === "stderr" && String(event.data).includes("ACTUAL_PROCESS_ERROR")));
assert.equal(verifyFinish(await run("while (true) {}"), "timeout").reason, "timeout");

console.log(cases.length + " 个章节场景通过，Linux 隔离、独立工作区、进程退出码和超时均已验证。");
