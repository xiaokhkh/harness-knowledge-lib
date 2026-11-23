import { loadKnowledge } from "./knowledge.mjs";
import { programs } from "../src/harness-programs.mjs";

const { library, chapters, notes } = await loadKnowledge();
const scenarios = programs.reduce((count, program) => count + program.scenarios.length, 0);
console.log(`${library.title} v${library.current} · ${chapters.length} 章 · ${notes.length} 篇笔记 · ${scenarios} 个场景`);
