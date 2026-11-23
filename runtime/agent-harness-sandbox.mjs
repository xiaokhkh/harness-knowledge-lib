import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";

const exec = promisify(execFile);
const host = "127.0.0.1";
const port = 41737;
const origin = "http://" + host + ":" + port;
const imageReference = "docker.io/library/node@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a";
const localDocker = join(homedir(), ".local", "bin", "docker");
const bundledDocker = "/Applications/Docker.app/Contents/Resources/bin/docker";
const docker = [localDocker, bundledDocker].find(existsSync) ?? "docker";
const runtimeMs = 6000;
const maxRequest = 96 * 1024;
const maxOutput = 128 * 1024;
const maxJobs = 2;
const jobs = new Set();
const label = "org.harness-lab.sandbox=ephemeral";
const file = new URL("./agent-harness-lab.html", import.meta.url);
const streamMarker = "\u001e";
const engineEnv = { ...process.env };
delete engineEnv.DOCKER_HOST;
delete engineEnv.DOCKER_CONTEXT;
delete engineEnv.DOCKER_TLS_VERIFY;
delete engineEnv.DOCKER_CERT_PATH;

function dockerExec(args, timeout = 8000) {
  return exec(docker, args, { env: engineEnv, timeout, maxBuffer: 128 * 1024 });
}

async function connectEngine() {
  let context = "default";
  if (process.platform === "darwin") {
    try {
      await dockerExec(["context", "inspect", "desktop-linux"]);
      context = "desktop-linux";
    } catch {}
  }
  const { stdout: address } = await dockerExec([
    "context", "inspect", context, "--format", "{{.Endpoints.docker.Host}}"
  ]);
  if (!address.trim().startsWith("unix://")) throw new Error("此实验台需要本地 Docker Unix socket。");
  const prefix = ["--context", context];
  await dockerExec([...prefix, "version", "--format", "{{.Server.Version}}"]);
  const inspect = () => dockerExec([...prefix, "image", "inspect", imageReference, "--format", "{{.Id}}"]);
  let image;
  try {
    image = (await inspect()).stdout.trim();
  } catch {
    console.log("正在下载 Node.js 官方镜像，完成后可离线运行。");
    await dockerExec([...prefix, "pull", imageReference], 180_000);
    image = (await inspect()).stdout.trim();
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Docker 镜像 ID 无效。");
  return { prefix, image };
}

function bootstrap(code, scenario) {
  return `
import { writeFileSync } from "node:fs";
import { inspect } from "node:util";

const write = process.stdout.write.bind(process.stdout);
const marker = ${JSON.stringify(streamMarker)};
function safe(value) {
  if (value === undefined) return "undefined";
  if (value instanceof Error) return { name: value.name, message: value.message };
  try {
    const seen = new WeakSet();
    const content = JSON.stringify(value, (_key, item) => {
      if (typeof item === "bigint" || typeof item === "function") return String(item);
      if (item && typeof item === "object") {
        if (seen.has(item)) return "[循环引用]";
        seen.add(item);
      }
      return item;
    });
    if (!content) return "undefined";
    return content.length > 16000 ? content.slice(0, 16000) + "…（已截断）" : JSON.parse(content);
  } catch {
    return inspect(value, { depth: 2, maxStringLength: 1000 });
  }
}

globalThis.scenario = ${JSON.stringify(scenario)};
globalThis.trace = (name, payload) => {
  write(marker + JSON.stringify({ name: String(name).slice(0, 120), data: safe(payload) }) + "\\n");
};
for (const level of ["log", "info", "warn", "error", "debug"]) {
  console[level] = (...args) => trace("console." + level, args.length === 1 ? args[0] : args);
}

const program = "/workspace/program.mjs";
writeFileSync(program, ${JSON.stringify(code)});
await import("file://" + program);
`;
}

function respond(response, status, message) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify({ message }));
}

async function readInput(request) {
  let size = 0;
  const parts = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxRequest) throw new Error("代码请求超过 96 KB。");
    parts.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(parts).toString("utf8"));
  if (!value || typeof value.code !== "string" || !value.code.trim()) throw new Error("请输入 JavaScript 代码。");
  if (typeof value.scenario !== "string" || !/^[a-zA-Z0-9_-]{1,40}$/.test(value.scenario)) {
    throw new Error("运行场景参数无效。");
  }
  return value;
}

function lineReader(onLine) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  function append(text) {
    pending += text;
    let index;
    while ((index = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, index).replace(/\r$/, "");
      pending = pending.slice(index + 1);
      if (line) onLine(line);
    }
  }
  return {
    write: buffer => append(decoder.write(buffer)),
    end() {
      append(decoder.end());
      if (pending) onLine(pending);
    }
  };
}

function createContainer(prefix, image, name) {
  return dockerExec([
    ...prefix, "create", "--name", name, "--label", label, "--pull", "never",
    "--interactive", "--init", "--network", "none", "--ipc", "none",
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges=true",
    "--user", "1000:1000", "--memory", "192m", "--memory-swap", "192m",
    "--pids-limit", "48", "--cpus", "1", "--log-driver", "none",
    "--tmpfs", "/workspace:rw,noexec,nosuid,nodev,size=32m,mode=1777",
    "--workdir", "/workspace", "--entrypoint", "node",
    image, "--input-type=module", "-"
  ]);
}

function attachContainer(prefix, name, source, handlers) {
  const child = spawn(docker, [...prefix, "start", "--attach", "--interactive", name], {
    env: engineEnv, stdio: ["pipe", "pipe", "pipe"]
  });
  child.stdin.on("error", () => {});
  child.stdout.on("data", handlers.stdout);
  child.stderr.on("data", handlers.stderr);
  child.stdin.end(source);
  return {
    child,
    result: new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    })
  };
}

async function execute(engine, input, response) {
  const name = "harness-lab-" + randomUUID();
  let spawned = false;
  let child;
  let removed;
  let cancellation;
  let finished = false;
  let timer;
  let bytes = 0;
  let logs = 0;
  const start = performance.now();
  const emit = event => {
    if (response.destroyed || response.writableEnded) return;
    if (event.type === "log") {
      logs++;
      if (logs > 301) return;
      if (logs === 301) event = { type: "log", name: "output.limit", data: "只显示前 300 条日志。" };
    }
    response.write(JSON.stringify(event) + "\n");
  };
  const remove = () => {
    if (!spawned) return Promise.resolve();
    removed ??= dockerExec([...engine.prefix, "rm", "--force", name], 5000)
      .then(() => undefined)
      .catch(error => {
        if (!String(error.stderr ?? error.message).includes("No such container")) throw error;
      });
    return removed;
  };
  const cancel = async reason => {
    if (finished || cancellation) return;
    cancellation = reason;
    try { await remove(); }
    catch (error) { console.warn("清理沙箱失败", name, error.message); }
    finally { child?.kill("SIGTERM"); }
  };
  const job = { cancel };
  jobs.add(job);
  response.on("close", () => { void cancel("disconnected"); });
  response.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.flushHeaders();

  const stdout = lineReader(line => {
    if (line.startsWith(streamMarker)) {
      try {
        const event = JSON.parse(line.slice(streamMarker.length));
        if (typeof event.name === "string") {
          emit({ type: "log", name: event.name.slice(0, 120), data: event.data });
          return;
        }
      } catch {}
    }
    emit({ type: "log", name: "stdout", data: line });
  });
  const stderr = lineReader(line => emit({ type: "log", name: "stderr", data: line }));
  const limited = pipe => buffer => {
    bytes += buffer.length;
    if (bytes <= maxOutput) pipe.write(buffer);
    else void cancel("output_limit");
  };

  try {
    await createContainer(engine.prefix, engine.image, name);
    spawned = true;
    if (cancellation || response.destroyed) return;
    emit({ type: "log", name: "sandbox.started", data: { runtime: "Node.js 22 · Linux", cwd: "/workspace", network: false } });
    const attached = attachContainer(engine.prefix, name, bootstrap(input.code, input.scenario), {
      stdout: limited(stdout), stderr: limited(stderr)
    });
    child = attached.child;
    timer = setTimeout(() => { void cancel("timeout"); }, runtimeMs);
    const result = await attached.result;
    stdout.end();
    stderr.end();
    finished = true;
    await remove();
    emit({
      type: "finish", ...result, reason: cancellation ?? (result.exitCode === 0 ? "ok" : "exit"),
      durationMs: Math.round(performance.now() - start)
    });
  } catch (error) {
    emit({ type: "error", message: String(error.stderr ?? error.message).trim().slice(0, 1600) });
  } finally {
    finished = true;
    clearTimeout(timer);
    try { await remove(); }
    catch (error) { console.warn("清理沙箱失败", name, error.message); }
    jobs.delete(job);
    if (!response.writableEnded) response.end();
  }
}

async function main() {
  const engine = await connectEngine().catch(error => {
    throw new Error("无法启动本地 Docker 沙箱。请确认 Docker Desktop 已启动。\n" + (error.stderr || error.message));
  });
  const server = createServer(async (request, response) => {
    if (request.headers.host !== host + ":" + port) return respond(response, 403, "请从本地实验台访问。");
    if (request.method === "GET" && request.url === "/") {
      try {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        response.end(await readFile(file));
      } catch { response.destroy(); }
      return;
    }
    if (request.method === "GET" && request.url === "/api/sandbox") {
      return respond(response, 200, "Docker · Linux · Node.js 22");
    }
    if (request.method === "GET" && request.url === "/favicon.ico") {
      response.writeHead(204);
      return response.end();
    }
    if (request.method !== "POST" || request.url !== "/api/run") return respond(response, 404, "找不到这个地址。");
    if (request.headers.origin !== origin || request.headers["sec-fetch-site"] === "cross-site" ||
        !/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
      return respond(response, 403, "运行请求必须来自本地实验台。");
    }
    const size = Number(request.headers["content-length"] ?? 0);
    if (size > maxRequest) return respond(response, 413, "代码请求超过 96 KB。");
    let input;
    try { input = await readInput(request); }
    catch (error) { return respond(response, 400, error.message); }
    if (jobs.size >= maxJobs) return respond(response, 429, "沙箱忙，请等当前运行结束。");
    await execute(engine, input, response);
  });
  server.requestTimeout = 12000;
  server.on("error", error => {
    if (error.code === "EADDRINUSE" && process.argv.includes("--open")) {
      execFile("open", [origin + "/"]);
      return;
    }
    console.error(error.message);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    console.log("Harness 手册沙箱已启动 " + origin + "/");
    console.log("每次运行创建独立 Linux 容器。按 Ctrl+C 停止服务。");
    if (process.argv.includes("--open") && process.platform === "darwin") execFile("open", [origin + "/"]);
  });
  let stopping = false;
  function stop() {
    if (stopping) return;
    stopping = true;
    server.close();
    void Promise.allSettled([...jobs].map(job => job.cancel("shutdown")));
  }
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
