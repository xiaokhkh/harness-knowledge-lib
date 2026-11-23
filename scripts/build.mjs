import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { displayStatus, escapeHtml as text, loadKnowledge, read } from "./knowledge.mjs";
import { programs } from "../src/harness-programs.mjs";

const root = new URL("../", import.meta.url);
const absolute = name => fileURLToPath(new URL(name, root));
const run = promisify(execFile);
const { library, chapters, notes, render } = await loadKnowledge();
const number = index => String(index + 1).padStart(2, "0");
const jump = (chapter, label, attrs = "") =>
  '<a href="#' + chapter.id + '" data-jump="' + chapter.id + '"' + attrs + '>' + label + "</a>";
const displayTags = entry => entry.tags.map(tag => '<span class="library-tag">' + text(tag) + "</span>").join("");
const entryMeta = entry => '<span>v' + text(entry.introduced) + ' 引入</span><span>' + text(entry.reviewed) +
  ' 复核</span><span>' + displayStatus(entry.status) + '</span>';

const contents = chapters.map((chapter, index) =>
  '<li>' + jump(chapter, '<span>' + number(index) + "</span>" + text(chapter.nav), ' data-chapter="' + chapter.id + '"') + "</li>"
).join("\n");
const articles = chapters.map((chapter, index) => `
<section class="chapter" id="${chapter.id}" aria-labelledby="${chapter.id}-heading">
  <div class="chapter-marker">第 ${number(index)} 章 · ${text(chapter.nav)}</div>
  <h2 id="${chapter.id}-heading">${text(chapter.title)}</h2>
  ${render(chapter.lead, chapter).replace("<p>", '<p class="chapter-lead">')}
  ${render(chapter.body, chapter, { headingOffset: 1 })}
  <div class="exercise">
    <h3>在代码里试一下</h3>
    ${render(chapter.exercise, chapter)}
    <div data-exercise="${chapter.id}" data-expected="${text(chapter.expected)}"></div>
  </div>
  ${render(chapter.references, chapter, { references: true })}
  <div class="chapter-nav">
    ${index ? jump(chapters[index - 1], "← " + text(chapters[index - 1].nav)) : "<span></span>"}
    ${index + 1 < chapters.length ? jump(chapters[index + 1], text(chapters[index + 1].nav) + " →") : '<a href="#knowledge">知识索引 →</a>'}
  </div>
</section>`).join("\n");
const knowledge = `
<section class="library-section" id="knowledge" aria-labelledby="knowledge-heading">
  <div class="library-section-head">
    <h2 id="knowledge-heading">知识索引</h2>
    <p>按章节查找概念与实验，按笔记补充架构取舍和来源。</p>
  </div>
  <ul class="knowledge-grid">
    ${chapters.map(chapter => `<li>
      ${jump(chapter, text(chapter.nav), ' class="library-item-title"')}
      <div class="library-item-tags">${displayTags(chapter)}</div>
      <div class="library-item-meta">${entryMeta(chapter)}</div>
    </li>`).join("")}
  </ul>
  <div class="knowledge-notes">${notes.map(note => `<article class="knowledge-note" id="${note.id}">
    <h3>${text(note.title)}</h3>
    <div class="library-item-meta">${entryMeta(note)}</div>
    ${render(note.body, note, { headingOffset: 2 })}
  </article>`).join("")}</div>
</section>`;
const history = `
<section class="library-section" id="versions" aria-labelledby="versions-heading">
  <div class="library-section-head">
    <h2 id="versions-heading">版本记录</h2>
    <p>Git 标签保存每版的正文、笔记和实验代码。</p>
  </div>
  <ol class="release-list">${library.releases.map(release => `
    <li class="release-card">
      <div><a class="version-pill" href="${text(library.repository)}/tree/v${text(release.version)}" target="_blank" rel="noopener noreferrer">v${text(release.version)}</a><time datetime="${text(release.date)}">${text(release.date)}</time></div>
      <h3>${text(release.title)}</h3>
      <ul>${release.changes.map(change => "<li>" + text(change) + "</li>").join("")}</ul>
    </li>`).join("")}
  </ol>
</section>`;
const programMap = new Map(programs.map(program => [program.id, program]));
const data = chapters.map(({ id, nav }) => ({ ...programMap.get(id), nav }));
const dist = "dist/";
await mkdir(absolute(dist), { recursive: true });
const [shell, script, css, fonts, ...licenseTexts] = await Promise.all([
  "src/harness-shell.html", "src/harness-ui.js", "src/harness-dark.css", "assets/fonts.css",
  "assets/licenses/LICENSE-coss.txt", "assets/licenses/OFL-CalSans.txt",
  "assets/licenses/OFL-PaperMono.txt", "assets/licenses/OFL-NotoSansSC.txt"
].map(read));
const [bundle, tailwind] = await Promise.all([
  build({
    absWorkingDir: fileURLToPath(root), entryPoints: ["src/ui/lab-components.tsx"], bundle: true,
    jsx: "automatic", minify: true, legalComments: "inline", format: "iife", globalName: "HarnessComponents",
    define: { "process.env.NODE_ENV": '"production"' }, write: false
  }),
  run(process.execPath, [
    absolute("node_modules/@tailwindcss/cli/dist/index.mjs"), "-i", absolute("src/ui/theme.css"), "--minify"
  ], { cwd: fileURLToPath(root), maxBuffer: 1024 * 1024 })
]);

const embeddedJs = code => code.replace(/<\/script/gi, "<\\/script");
const replace = (name, value, source) => source.replaceAll(name, () => value);
const fragments = [
  ["{{LIBRARY_TITLE}}", text(library.title)],
  ["{{LIBRARY_SUBTITLE}}", text(library.subtitle)],
  ["{{LIBRARY_VERSION}}", "v" + text(library.current)],
  ["{{LIBRARY_REPO}}", text(library.repository)],
  ["{{FIRST_CHAPTER}}", chapters[0].id],
  ["/* UI_THEME */", tailwind.stdout],
  ["/* LOCAL_FONTS */", fonts],
  ["/* APP_STYLES */", css],
  ["<!-- CONTENTS -->", contents],
  ["<!-- CHAPTERS -->", articles],
  ["<!-- KNOWLEDGE -->", knowledge],
  ["<!-- VERSIONS -->", history],
  ["// APP_DATA", "const programs = " + JSON.stringify(data).replace(/</g, "\\u003c") + ";"],
  ["// COSS_COMPONENTS", embeddedJs(bundle.outputFiles[0].text)],
  ["// APP_SCRIPT", embeddedJs(script)],
  ["<!-- THIRD_PARTY_LICENSES -->", "<!-- coss ui / Cal Sans / Paper Mono / Noto Sans SC\n" + licenseTexts.join("\n\n") + "\n-->"]
];
const output = fragments.reduce((source, [name, value]) => replace(name, value, source), shell);
await writeFile(absolute(dist + "agent-harness-lab.html"), output);
for (const name of ["agent-harness-sandbox.mjs", "start-harness-sandbox.command"]) {
  await copyFile(absolute("runtime/" + name), absolute(dist + name));
}
await chmod(absolute(dist + "start-harness-sandbox.command"), 0o755);
console.log(`构建完成 ${library.title} v${library.current} · ${chapters.length} 章 · ${notes.length} 篇笔记`);
