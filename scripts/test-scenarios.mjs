import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertScenario, cases } from "./scenario-cases.mjs";

const root = mkdtempSync(join(tmpdir(), "harness-scenarios-"));
try {
  for (const job of cases) {
    const cwd = mkdtempSync(join(root, job.id + "-"));
    writeFileSync(join(cwd, "program.mjs"), job.code);
    const bootstrap = `
      globalThis.scenario = ${JSON.stringify(job.scenario)};
      globalThis.trace = (name, data) => console.log("\\x1e" + JSON.stringify({ name, data }));
      await import("./program.mjs");
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", bootstrap], {
      cwd, encoding: "utf8", timeout: 8000
    });
    try {
      assert.equal(result.status, 0, result.error?.message ?? result.stderr);
      const events = result.stdout.split("\n")
        .filter(line => line.startsWith("\x1e"))
        .map(line => JSON.parse(line.slice(1)));
      assertScenario(job, events);
    } catch (error) {
      throw new Error(job.id + "/" + job.scenario + " 未通过", { cause: error });
    }
    console.log(job.id, job.scenario);
  }
  console.log(cases.length + " 个章节场景通过。");
} finally {
  rmSync(root, { recursive: true, force: true });
}
