(() => {
  const $ = id => document.getElementById(id);
  const publicSite = location.protocol === "https:";
  const view = HarnessComponents.mount(programs.map((program, index) => ({
    id: program.id, title: program.nav,
    navigationLabel: String(index + 1).padStart(2, "0") + " · " + program.nav,
    scenarios: program.scenarios.map(([value, label]) => ({ value, label }))
  })), {
    onChapter: jump,
    onScenario: selectScenario,
    onView: value => setDiff(value === "changes"),
    onRun: runCode,
    onReset: resetCode,
    onCopy: copySource,
    onClose: () => closeLab(),
    onRunFirst: runFirst
  }, publicSite);
  const editor = $("editor");
  const highlight = $("highlight");
  const changes = $("changes");
  const output = $("output");
  const anchors = programs.map(program => $(program.id));
  const media = matchMedia("(max-width: 690px)");
  const lab = $("lab");
  const showcase = $("lab-showcase");
  const dock = $("lab-dock");
  const reading = $("reading");
  const drafts = new Map();
  const scenarios = new Map();
  const runs = new Map();
  let active = 0;
  let chosenScenario = programs[0].scenarios[0][0];
  let currentRun = null;
  const sandboxOrigin = "http://127.0.0.1:41737";
  const sandboxConnected = location.origin === sandboxOrigin;
  editor.readOnly = !sandboxConnected;
  let diffVisible = false;
  let paintFrame = 0;
  let navigationFrame = 0;
  let copyTimer = 0;
  let lastTrigger;

  const key = () => programs[active].id + "/" + chosenScenario;
  const digits = number => String(number).padStart(2, "0");
  const html = value => String(value).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);

  function colorSource(source) {
    const token = /\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:const|let|class|function|async|await|return|if|else|for|while|throw|new|try|catch|finally|continue|break|extends|of|typeof|instanceof|undefined|true|false|null)\b|\b(?:runAgent|runPatchProcess|buildContext|apply_patch|run_tests|consolidate)\b(?=\s*\()|\b\d+(?:\.\d+)?\b/g;
    let chunks = "";
    let cursor = 0;
    for (const match of source.matchAll(token)) {
      const mark = match[0];
      chunks += html(source.slice(cursor, match.index));
      const kind = mark.startsWith("//") ? "comment" : /^["']/.test(mark) ? "str" : /^\d/.test(mark) ? "num"
        : /^(runAgent|runPatchProcess|buildContext|apply_patch|run_tests|consolidate)$/.test(mark) ? "fn" : "kw";
      chunks += '<span class="token-' + kind + '">' + html(mark) + '</span>';
      cursor = match.index + mark.length;
    }
    return chunks + html(source.slice(cursor)) + "\n";
  }

  function synchronizeHighlight() {
    highlight.scrollTop = editor.scrollTop;
    highlight.scrollLeft = editor.scrollLeft;
  }

  function paintSource() {
    highlight.innerHTML = colorSource(editor.value);
    synchronizeHighlight();
  }

  function showDiff() {
    if (active === 0) {
      changes.innerHTML = '<span class="diff-line diff-gap">第一章是起点。后续章节可在这里对照代码改动。</span>';
      return;
    }
    const oldLines = programs[active - 1].code.split("\n");
    const newLines = editor.value.split("\n");
    if (newLines.length > 500) {
      changes.textContent = "代码超过 500 行。可回到编辑器查看完整代码。";
      return;
    }
    const matrix = Array.from({ length: oldLines.length + 1 }, () => new Uint16Array(newLines.length + 1));
    for (let i = oldLines.length - 1; i >= 0; i--) {
      for (let j = newLines.length - 1; j >= 0; j--) {
        matrix[i][j] = oldLines[i] === newLines[j]
          ? 1 + matrix[i + 1][j + 1]
          : Math.max(matrix[i + 1][j], matrix[i][j + 1]);
      }
    }
    const lines = [];
    let i = 0;
    let j = 0;
    while (i < oldLines.length || j < newLines.length) {
      if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
        lines.push(["same", oldLines[i]]);
        i++;
        j++;
      } else if (j < newLines.length && (i === oldLines.length || matrix[i][j + 1] > matrix[i + 1][j])) {
        lines.push(["add", newLines[j++]]);
      } else {
        lines.push(["cut", oldLines[i++]]);
      }
    }
    const caption = '<span class="diff-line diff-gap">与第 ' + digits(active) + ' 章原始示例对照</span>';
    const prefixes = { same: "  ", add: "+ ", cut: "− " };
    changes.innerHTML = caption + lines.map(([type, line]) =>
      '<span class="diff-line diff-' + type + '">' + prefixes[type] + html(line) + "</span>"
    ).join("");
    changes.scrollTop = 0;
  }

  function setDiff(visible) {
    diffVisible = visible;
    view.update({ view: visible ? "changes" : "code" });
    if (visible) showDiff();
    else paintSource();
  }

  function activate(index) {
    active = index;
    const program = programs[index];
    chosenScenario = scenarios.get(program.id) ?? program.scenarios[0][0];
    const chapter = {
      id: program.id, title: program.nav,
      navigationLabel: digits(index + 1) + " · " + program.nav,
      scenarios: program.scenarios.map(([value, label]) => ({ value, label }))
    };
    view.update({ chapter, scenario: chosenScenario, index: digits(index + 1) + " / " + digits(programs.length) });
    $("progress").style.width = 100 * (index + 1) / programs.length + "%";
    document.querySelectorAll("[data-chapter]").forEach(anchor => {
      if (anchor.dataset.chapter === program.id) anchor.setAttribute("aria-current", "location");
      else anchor.removeAttribute("aria-current");
    });
    editor.value = drafts.get(program.id) ?? program.code;
    editor.scrollTop = editor.scrollLeft = 0;
    setDiff(diffVisible);
    paintRun();
  }

  function selectScenario(value) {
    chosenScenario = value;
    scenarios.set(programs[active].id, value);
    view.update({ scenario: value });
    paintRun();
  }

  function positionLab() {
    const next = !media.matches && reading.getBoundingClientRect().top <= 100 ? dock : showcase;
    if (lab.parentElement === next) return;
    if (typeof next.moveBefore === "function") next.moveBefore(lab, null);
    else next.append(lab);
    synchronizeHighlight();
  }

  function visibleChapter() {
    positionLab();
    const limit = innerHeight < 600 ? 112 : 185;
    let index = 0;
    for (let i = 0; i < anchors.length; i++) {
      if (anchors[i].getBoundingClientRect().top <= limit) index = i;
      else break;
    }
    if (index !== active) activate(index);
  }

  function jump(id) {
    const index = programs.findIndex(item => item.id === id);
    if (index < 0) return;
    if (location.hash !== "#" + id) history.pushState(null, "", "#" + id);
    activate(index);
    anchors[index].scrollIntoView();
    positionLab();
  }

  function runFirst() {
    if (active !== 0) activate(0);
    setDiff(false);
    if (media.matches) openLab($("hero-run"));
    runCode();
  }

  function stringify(value, pretty = false) {
    if (typeof value === "string") return value;
    try { return JSON.stringify(value, null, pretty ? 2 : 0) ?? String(value); }
    catch { return String(value); }
  }

  function appendLog(entry, index) {
    const node = document.createElement("details");
    node.className = "output-line";
    if (entry.name === "error" || entry.name === "stderr") node.classList.add("error");
    if (entry.name === "sandbox.exited" && entry.data?.exitCode === 0) node.classList.add("event-final");
    const summary = document.createElement("summary");
    const counter = document.createElement("time");
    counter.textContent = digits(index + 1);
    const name = document.createElement("strong");
    name.textContent = entry.name;
    name.title = entry.name;
    const preview = document.createElement("code");
    const text = stringify(entry.data).replace(/\s+/g, " ");
    preview.textContent = text.length > 93 ? text.slice(0, 90) + "…" : text;
    summary.append(counter, name, preview);
    const expanded = document.createElement("pre");
    expanded.textContent = stringify(entry.data, true);
    node.append(summary, expanded);
    output.append(node);
  }

  function paintStatus(record) {
    const isCurrent = currentRun?.key === key();
    view.update({ running: isCurrent });
    $("status").textContent = record
      ? ({ running: "运行中", done: "已执行", error: "执行出错", stopped: "已停止" })[record.status]
        + " · " + record.events.length + " 条事件"
      : sandboxConnected ? "Docker 就绪" : "需要本地 Docker";
  }

  function paintRun() {
    const record = runs.get(key());
    output.replaceChildren();
    paintStatus(record);
    if (record) record.events.forEach(appendLog);
    if (!record || !record.events.length) {
      const message = document.createElement("p");
      message.textContent = record?.status === "running"
        ? "正在启动独立容器…"
        : publicSite ? "可在线查看代码和对照差异。运行实验需要本地 Docker。"
        : "运行本章代码后，在这里查看事件、原始输出和容器退出码。";
      output.append(message);
      if (publicSite) appendSandboxLinks();
      else if (!record) {
        const runtime = document.createElement("dl");
        runtime.className = "idle-environment";
        for (const [label, value] of [["工作目录", "/workspace"], ["网络", "none"]]) {
          const term = document.createElement("dt");
          const description = document.createElement("dd");
          term.textContent = label;
          description.textContent = value;
          runtime.append(term, description);
        }
        output.append(runtime);
      }
    }
  }

  function appendSandboxLinks() {
    const links = document.createElement("p");
    const setup = document.createElement("a");
    const launch = document.createElement("a");
    setup.href = document.body.dataset.repository + "#本地运行";
    setup.textContent = "查看启动说明";
    launch.href = sandboxOrigin + "/#" + programs[active].id;
    launch.textContent = "打开已启动的本地沙箱";
    for (const link of [setup, launch]) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
    links.append(setup, " · ", launch);
    output.append(links);
  }

  function finishRun(job, state, message) {
    if (job !== currentRun) return;
    if (state === "stopped") job.controller.abort();
    currentRun = null;
    job.record.status = state;
    if (message) job.record.events.push({ name: state === "error" ? "error" : "sandbox.stopped", data: message });
    if (job.key === key()) paintRun();
  }

  function recordRunEvent(job, event) {
    job.record.events.push(event);
    if (job.key !== key()) return;
    if (job.record.events.length === 1) output.replaceChildren();
    appendLog(event, job.record.events.length - 1);
    paintStatus(job.record);
  }

  async function runCode() {
    if (publicSite) {
      paintRun();
      $("status").textContent = "请先启动本地 Docker 沙箱";
      output.focus({ preventScroll: true });
      return;
    }
    if (!sandboxConnected) {
      location.assign(sandboxOrigin + "/#" + programs[active].id);
      return;
    }
    if (currentRun?.key === key()) {
      finishRun(currentRun, "stopped", "用户取消，正在清理当前容器。");
      return;
    }
    if (currentRun) finishRun(currentRun, "stopped", "已切换到另一个示例。");

    const record = { status: "running", events: [] };
    const job = { key: key(), record, controller: new AbortController() };
    currentRun = job;
    runs.set(job.key, record);
    paintRun();

    function handleLine(line) {
      const event = JSON.parse(line);
      if (event.type === "log") recordRunEvent(job, event);
      else if (event.type === "error") finishRun(job, "error", event.message);
      else if (event.type === "finish") {
        recordRunEvent(job, {
          name: "sandbox.exited",
          data: { exitCode: event.exitCode, durationMs: event.durationMs, reason: event.reason }
        });
        if (event.reason === "ok") finishRun(job, "done");
        else if (event.reason === "timeout") finishRun(job, "error", "运行超过 6 秒，容器已停止。");
        else if (event.reason === "output_limit") finishRun(job, "error", "输出超过 128 KB，容器已停止。");
        else finishRun(job, "error", "容器以退出码 " + event.exitCode + " 结束。");
      }
    }

    try {
      const response = await fetch("/api/run", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: editor.value, scenario: chosenScenario }),
        signal: job.controller.signal
      });
      if (!response.ok) {
        const error = await response.json();
        finishRun(job, "error", error.message);
        return;
      }
      const stream = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      for (;;) {
        const { value, done } = await stream.read();
        if (job !== currentRun) {
          await stream.cancel().catch(() => {});
          return;
        }
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) if (line && job === currentRun) handleLine(line);
      }
      finishRun(job, "error", "沙箱连接提前关闭。");
    } catch (error) {
      if (job === currentRun) finishRun(job, "error", error.message);
    }
  }

  async function copySource() {
    let success = false;
    try {
      await navigator.clipboard.writeText(editor.value);
      success = true;
    } catch {
      const temp = document.createElement("textarea");
      temp.value = editor.value;
      temp.style.position = "fixed";
      temp.style.left = "-10000px";
      document.body.append(temp);
      temp.select();
      try { success = document.execCommand("copy"); } catch {}
      temp.remove();
    }
    $("copy-button").focus();
    view.update({ copyLabel: success ? "已复制代码" : "复制失败" });
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => view.update({ copyLabel: "复制代码" }), 1800);
  }

  function openLab(trigger) {
    if (!media.matches) return;
    lastTrigger = trigger;
    $("lab").classList.add("is-open");
    $("lab").setAttribute("role", "dialog");
    $("lab").setAttribute("aria-modal", "true");
    document.body.classList.add("lab-open");
    document.querySelector("main .article").inert = true;
    document.querySelector("header").inert = true;
    $("mobile-launch").hidden = true;
    $("close-lab").focus();
  }

  function closeLab(restoreFocus = true) {
    if (!$("lab").classList.contains("is-open")) return;
    $("lab").classList.remove("is-open");
    $("lab").removeAttribute("role");
    $("lab").removeAttribute("aria-modal");
    document.body.classList.remove("lab-open");
    document.querySelector("main .article").inert = false;
    document.querySelector("header").inert = false;
    $("mobile-launch").hidden = false;
    if (restoreFocus) lastTrigger?.focus();
  }

  editor.addEventListener("input", () => {
    drafts.set(programs[active].id, editor.value);
    cancelAnimationFrame(paintFrame);
    paintFrame = requestAnimationFrame(paintSource);
  });
  editor.addEventListener("scroll", synchronizeHighlight);
  function resetCode() {
    const selected = programs[active];
    if (currentRun?.key === key()) finishRun(currentRun, "stopped");
    runs.delete(key());
    drafts.delete(selected.id);
    editor.value = selected.code;
    editor.scrollTop = editor.scrollLeft = 0;
    setDiff(diffVisible);
    paintRun();
  }

  media.addEventListener("change", () => {
    if (!media.matches) closeLab(false);
    positionLab();
  });
  document.addEventListener("click", event => {
    const target = event.target.closest("[data-jump],[data-lab]");
    if (!target) return;
    if (target.dataset.jump) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      jump(target.dataset.jump);
    } else {
      const index = programs.findIndex(item => item.id === target.dataset.lab);
      if (index !== active) activate(index);
      openLab(target);
    }
  });
  document.addEventListener("keydown", event => {
    const modal = $("lab").classList.contains("is-open");
    const pickerOpen = document.querySelector('[data-slot="select-popup"][data-open]');
    if (event.key === "Escape" && modal && !pickerOpen && !event.defaultPrevented) closeLab();
    if (modal && event.key === "Tab" && !pickerOpen && !event.defaultPrevented) {
      const controls = [...$("lab").querySelectorAll("button,select,textarea,[tabindex],summary")]
        .filter(node => !node.hidden && node.getClientRects().length);
      if (event.shiftKey && document.activeElement === controls[0]) {
        event.preventDefault();
        controls.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === controls.at(-1)) {
        event.preventDefault();
        controls[0]?.focus();
      }
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && (!media.matches || modal)) {
      event.preventDefault();
      runCode();
    }
  });
  addEventListener("scroll", () => {
    if ($("lab").classList.contains("is-open")) return;
    cancelAnimationFrame(navigationFrame);
    navigationFrame = requestAnimationFrame(visibleChapter);
  }, { passive: true });
  addEventListener("hashchange", visibleChapter);

  const initial = programs.findIndex(item => "#" + item.id === location.hash);
  activate(Math.max(initial, 0));
  if (initial >= 0) requestAnimationFrame(() => {
    anchors[initial].scrollIntoView();
    positionLab();
  });
  else positionLab();

})();
