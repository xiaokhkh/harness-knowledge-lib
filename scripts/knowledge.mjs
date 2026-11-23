import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import MarkdownIt from "markdown-it";
import { programs } from "../src/harness-programs.mjs";

const root = new URL("../", import.meta.url);
const markdown = new MarkdownIt({ html: false, linkify: true });
const versionFormat = /^\d+\.\d+\.\d+$/;
const idFormat = /^[a-z][a-z0-9-]*$/;
const dateFormat = /^\d{4}-\d{2}-\d{2}$/;
const statuses = ["draft", "verified"];

export const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[character]);
export const displayStatus = value => value === "verified" ? "已复核" : "草稿";

export const read = name => readFile(new URL(name, root), "utf8");
const json = async name => JSON.parse(await read(name));

function assertValue(condition, message) {
  if (!condition) throw new Error(message);
}

const headingLevels = ["heading_open", "heading_close"];
for (const type of headingLevels) {
  markdown.renderer.rules[type] = (tokens, index, options, env, renderer) => {
    const token = tokens[index];
    const oldTag = token.tag;
    token.tag = "h" + Math.min(6, Number(oldTag.slice(1)) + (env.headingOffset ?? 0));
    const output = renderer.renderToken(tokens, index, options);
    token.tag = oldTag;
    return output;
  };
}

const listOpen = (tokens, index, options, env, renderer) => {
  if (env.references) tokens[index].attrJoin("class", "refs");
  return renderer.renderToken(tokens, index, options);
};
markdown.renderer.rules.bullet_list_open = listOpen;
markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  const token = tokens[index];
  const href = token.attrGet("href") ?? "";
  if (href.startsWith("https://") || href.startsWith("http://")) {
    token.attrSet("target", "_blank");
    token.attrSet("rel", "noopener noreferrer");
  } else if (href.endsWith(".md") && env.entry) {
    const path = posix.normalize(posix.join(posix.dirname(env.entry.path), href));
    const id = env.index.get(path);
    if (id) {
      token.attrSet("href", "#" + id);
      if (env.chapterIds.has(id)) token.attrSet("data-jump", id);
    }
  }
  return renderer.renderToken(tokens, index, options);
};

function headingsOf(body) {
  const tokens = markdown.parse(body, {});
  return tokens.flatMap((token, index) => token.type === "heading_open" && token.level === 0
    ? [{ level: Number(token.tag.slice(1)), line: token.map[0], end: token.map[1], title: tokens[index + 1].content }]
    : []);
}

async function loadEntry(path, collection) {
  assertValue(typeof path === "string" && new RegExp("^" + collection + "/[a-z0-9-]+\\.md$").test(path), "无效文档路径 " + path);
  const raw = await read("content/" + path);
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assertValue(match, path + " 缺少 JSON 元数据");
  const meta = JSON.parse(match[1]);
  assertValue(idFormat.test(meta.id ?? ""), path + " 无效 id");
  assertValue(typeof meta.nav === "string" && meta.nav.trim(), path + " 缺少 nav");
  assertValue(versionFormat.test(meta.introduced ?? ""), path + " 无效 introduced");
  assertValue(dateFormat.test(meta.reviewed ?? ""), path + " 无效 reviewed");
  assertValue(statuses.includes(meta.status), path + " 无效 status");
  assertValue(Array.isArray(meta.tags) && meta.tags.length && meta.tags.every(tag => typeof tag === "string" && tag.trim()), path + " 无效 tags");

  const body = raw.slice(match[0].length);
  const lines = body.split(/\r?\n/);
  const headings = headingsOf(body);
  assertValue(headings[0]?.level === 1 && headings.filter(item => item.level === 1).length === 1, path + " 需要一个一级标题");
  const title = headings[0].title;
  if (collection === "notes") return { ...meta, path, title, body: lines.slice(headings[0].end).join("\n") };

  const markers = ["在代码里试一下", "预期结果", "参考资料"];
  const indices = markers.map(marker => headings.findIndex(item => item.level === 2 && item.title === marker));
  assertValue(indices[0] > 1 && indices[1] === indices[0] + 1 && indices[2] === indices[1] + 1 && indices[2] === headings.length - 1,
    path + " 需按顺序包含练习、预期和参考资料");
  const [exercise, expected, references] = indices.map(index => headings[index]);
  const entry = {
    ...meta, path, title,
    lead: lines.slice(headings[0].end, headings[1].line).join("\n").trim(),
    body: lines.slice(headings[1].line, exercise.line).join("\n"),
    exercise: lines.slice(exercise.end, expected.line).join("\n").trim(),
    expected: lines.slice(expected.end, references.line).join("\n").trim(),
    references: lines.slice(references.end).join("\n").trim()
  };
  for (const key of ["lead", "body", "exercise", "expected", "references"]) assertValue(entry[key], path + " 缺少 " + key);
  return entry;
}

export async function loadKnowledge() {
  const [library, packageInfo, lock] = await Promise.all([json("content/library.json"), json("package.json"), json("package-lock.json")]);
  assertValue(library.format === 1 && typeof library.title === "string" && typeof library.subtitle === "string", "知识库清单格式无效");
  assertValue(versionFormat.test(library.current ?? "") && packageInfo.version === library.current && lock.version === library.current, "内容、package.json 和锁文件版本须一致");
  assertValue(Array.isArray(library.releases) && library.releases[0]?.version === library.current, "版本记录顶部须为当前版本");
  assertValue(Array.isArray(library.chapters) && library.chapters.length > 0 && Array.isArray(library.notes), "缺少章节或笔记清单");
  const versions = new Set();
  for (const release of library.releases) {
    assertValue(versionFormat.test(release.version ?? "") && !versions.has(release.version) &&
      dateFormat.test(release.date ?? "") && typeof release.title === "string" &&
      Array.isArray(release.changes) && release.changes.every(change => typeof change === "string"), "版本条目无效");
    versions.add(release.version);
  }
  const [chapters, notes] = await Promise.all([
    Promise.all(library.chapters.map(path => loadEntry(path, "chapters"))),
    Promise.all(library.notes.map(path => loadEntry(path, "notes")))
  ]);
  const byId = new Map();
  const index = new Map();
  for (const entry of [...chapters, ...notes]) {
    assertValue(versions.has(entry.introduced), entry.path + " 引用未知版本");
    assertValue(!byId.has(entry.id) && !index.has(entry.path), entry.path + " 重复 ID 或文件");
    assertValue(!["top", "knowledge", "versions"].includes(entry.id), entry.path + " 使用了保留 ID");
    byId.set(entry.id, entry);
    index.set(entry.path, entry.id);
  }
  const chapterIds = new Set(chapters.map(chapter => chapter.id));
  const programIds = new Set(programs.map(program => program.id));
  assertValue(programs.length === programIds.size && programIds.size === chapterIds.size &&
    chapters.every(chapter => programIds.has(chapter.id)), "章节 ID 与交互示例 ID 必须一一对应");
  const render = (source, entry, opts = {}) => markdown.render(source, { entry, index, chapterIds, ...opts });
  return { library, chapters, notes, byId, render };
}
