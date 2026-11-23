import { createPortal, flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { CheckIcon, Code2Icon, CopyIcon, GitCompareArrowsIcon, PlayIcon, RotateCcwIcon, SquareIcon, XIcon } from "lucide-react";
import { Button } from "./button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./select";
import { Tabs, TabsList, TabsPanel, TabsTab } from "./tabs";
import { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } from "./accordion";

type Choice = { value: string; label: string };
type Chapter = {
  id: string;
  title: string;
  navigationLabel: string;
  scenarios: Choice[];
};
type Handlers = {
  onChapter: (id: string) => void;
  onScenario: (id: string) => void;
  onView: (view: "code" | "changes") => void;
  onRun: () => void;
  onReset: () => void;
  onCopy: () => void;
  onClose: () => void;
  onRunFirst: () => void;
};

type LabState = {
  chapter: Chapter;
  index: string;
  scenario: string;
  view: "code" | "changes";
  running: boolean;
  copyLabel: string;
};

function Picker({ id, label, options, value, onChange }: {
  id: string;
  label: string;
  options: Choice[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select items={options} value={value} onValueChange={next => {
      if (next !== null) onChange(next);
    }}>
      <SelectTrigger id={id} aria-label={label} className="lab-select">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false} className="lab-select-list">
        {options.map(option => (
          <SelectItem key={option.value} value={option.value} data-choice={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function LabControls({ state, handlers }: { state: LabState; handlers: Handlers }) {
  return (
    <>
      <div className="lab-head">
        <div className="lab-title">
          <span id="lab-index">{state.index}</span>
          <strong id="lab-title">{state.chapter.title}</strong>
        </div>
        <label className="runtime-label" htmlFor="editor">JavaScript 源码</label>
        <Button id="close-lab" variant="outline" size="sm" className="mobile-close" onClick={handlers.onClose}>
          <XIcon aria-hidden="true" />
          返回文章
        </Button>
      </div>
      <Tabs value={state.view} onValueChange={handlers.onView} className="editor-tabs">
        <div className="lab-toolbar">
          <TabsList size="sm" className="lab-view-tabs" aria-label="编辑器视图">
            <TabsTab id="code-button" value="code" className="lab-tab">
              <Code2Icon className="size-3.5" aria-hidden="true" />
              代码
            </TabsTab>
            <TabsTab id="diff-button" value="changes" className="lab-tab">
              <GitCompareArrowsIcon className="size-3.5" aria-hidden="true" />
              对照
            </TabsTab>
          </TabsList>
          <div className="scenario-control">
            <Picker id="scenario" label="运行场景" options={state.chapter.scenarios}
              value={state.scenario} onChange={handlers.onScenario} />
          </div>
          <div className="toolbar-buttons">
            <Button variant="ghost" size="icon-sm" type="button" id="reset-button" aria-label="重置代码" title="重置代码" onClick={handlers.onReset}>
              <RotateCcwIcon aria-hidden="true" />
            </Button>
            <Button variant="ghost" size="icon-sm" type="button" id="copy-button" aria-label={state.copyLabel} title={state.copyLabel} onClick={handlers.onCopy}>
              {state.copyLabel === "已复制代码" ? <CheckIcon className="copy-success" aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
            </Button>
            <Button size="sm" type="button" id="run-button" className="run" onClick={handlers.onRun}>
              {state.running ? <SquareIcon aria-hidden="true" /> : <PlayIcon aria-hidden="true" />}
              {state.running ? "停止" : "运行"}
            </Button>
          </div>
        </div>
        <TabsPanel keepMounted value="code" className="editor-wrap">
          <pre className="highlight" id="highlight" aria-hidden="true" />
          <textarea id="editor" aria-label="可编辑的 JavaScript 源码" spellCheck={false} autoCapitalize="off" autoComplete="off" wrap="off" />
        </TabsPanel>
        <TabsPanel keepMounted value="changes" className="editor-wrap">
          <pre className="changes" id="changes" aria-label="与上一章的代码差异" />
        </TabsPanel>
      </Tabs>
    </>
  );
}

export function mount(chapters: Chapter[], handlers: Handlers) {
  const root = createRoot(document.getElementById("lab-controls")!);
  const expectedSlots = Array.from(document.querySelectorAll<HTMLElement>("[data-expected]"))
    .map(element => ({ element, text: element.dataset.expected ?? "" }));
  const chapterOptions = chapters.map(chapter => ({ value: chapter.id, label: chapter.navigationLabel }));
  let state: LabState = {
    chapter: chapters[0], index: "01 / " + String(chapters.length).padStart(2, "0"), scenario: chapters[0].scenarios[0].value,
    view: "code", running: false, copyLabel: "复制代码"
  };
  function render() {
    root.render(
      <>
        <LabControls state={state} handlers={handlers} />
        {createPortal(
          <>
            <Button id="hero-run" onClick={handlers.onRunFirst}>
              <PlayIcon aria-hidden="true" />
              运行第一章
            </Button>
            <Button variant="outline" render={<a href={"#" + chapters[0].id} data-jump={chapters[0].id} />}>
              开始阅读
            </Button>
          </>,
          document.getElementById("hero-actions")!
        )}
        {createPortal(
          <Picker id="chapter-picker" label="跳转到章节" options={chapterOptions}
            value={state.chapter.id} onChange={handlers.onChapter} />,
          document.getElementById("chapter-picker-slot")!
        )}
        {createPortal(
          <Button id="mobile-launch" className="mobile-launch" data-lab={state.chapter.id}>
            打开本章实验
          </Button>,
          document.getElementById("mobile-launch-slot")!
        )}
        {expectedSlots.map(({ element, text }) =>
          createPortal(
            <>
              <Accordion className="exercise-accordion">
                <AccordionItem value="expected">
                  <AccordionTrigger className="exercise-toggle">预期结果</AccordionTrigger>
                  <AccordionPanel className="exercise-result">{text}</AccordionPanel>
                </AccordionItem>
              </Accordion>
              <Button variant="outline" data-lab={element.dataset.exercise} className="inline-launch">
                打开实验
              </Button>
            </>,
            element, element.dataset.exercise
          )
        )}
      </>
    );
  }
  flushSync(render);
  return {
    update(next: Partial<LabState>) {
      if (!Object.entries(next).some(([key, value]) => state[key as keyof LabState] !== value)) return;
      state = { ...state, ...next };
      flushSync(render);
    }
  };
}
