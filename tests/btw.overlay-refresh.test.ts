import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { initTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  Markdown,
  TUI_KEYBINDINGS,
  wrapTextWithAnsi,
  type TUI,
} from "@earendil-works/pi-tui";
import { BtwOverlayComponent } from "../extensions/btw";

// The overlay rebuilds the whole transcript on every streamed token. Both the
// markdown parse and the ANSI-aware wrapping are memoised, so count how often each
// actually runs: a single token must not re-do work for entries that did not change.
vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-tui")>();
  return { ...actual, wrapTextWithAnsi: vi.fn(actual.wrapTextWithAnsi) };
});

const wrapSpy = vi.mocked(wrapTextWithAnsi);
let renderSpy: MockInstance<(...args: any[]) => any>;

initTheme("dark", false);

function makeTranscript(turns: number) {
  const entries: any[] = [];
  let id = 0;
  for (let turn = 1; turn <= turns; turn += 1) {
    const streaming = turn === turns;
    entries.push({ id: (id += 1), turnId: turn, type: "turn-boundary", phase: "start" });
    entries.push({ id: (id += 1), turnId: turn, type: "user-message", text: `Question ${turn}` });
    entries.push({ id: (id += 1), turnId: turn, type: "thinking", text: `Thinking about ${turn}.\n\nsecond line`, streaming });
    entries.push({ id: (id += 1), turnId: turn, type: "tool-call", toolCallId: `call-${turn}`, toolName: "read", args: "{}" });
    entries.push({
      id: (id += 1),
      turnId: turn,
      type: "tool-result",
      toolCallId: `call-${turn}`,
      toolName: "read",
      content: `result ${turn}`,
      truncated: false,
      isError: false,
      streaming,
    });
    entries.push({ id: (id += 1), turnId: turn, type: "assistant-text", text: `## Answer ${turn}\n\nbody with \`code\``, streaming });
    entries.push({ id: (id += 1), turnId: turn, type: "turn-boundary", phase: "end", outcome: streaming ? undefined : "completed" });
  }
  return entries;
}

function markdownBlocks(entries: any[]) {
  return entries.filter((entry) => entry.type === "thinking" || entry.type === "assistant-text");
}

function streamingAssistant(entries: any[]) {
  return [...entries].reverse().find((entry) => entry.type === "assistant-text");
}

function fixture(entries: any[]) {
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as ExtensionContext["ui"]["theme"];
  const keybindings = new KeybindingsManager({ ...TUI_KEYBINDINGS });
  const overlay = new BtwOverlayComponent(
    { mode: "fullscreen", requestRender: vi.fn() } as unknown as TUI,
    theme,
    keybindings,
    () => entries as never,
    () => null,
    () => "contextual",
    () => "window",
    vi.fn(),
    vi.fn(),
    vi.fn(),
    vi.fn(),
  );
  return { overlay };
}

beforeEach(() => {
  renderSpy = vi.spyOn(Markdown.prototype, "render");
  wrapSpy.mockClear();
});

afterEach(() => {
  renderSpy.mockRestore();
});

describe("BTW overlay streaming rebuild cost", () => {
  it("parses each markdown block once and never re-parses unchanged blocks", () => {
    const entries = makeTranscript(12);
    const { overlay } = fixture(entries);

    // The constructor's initial refresh renders at the default width; the first paint
    // at the terminal width re-parses every thinking/assistant-text block exactly once.
    renderSpy.mockClear();
    overlay.render(80);
    expect(renderSpy.mock.calls.length).toBe(markdownBlocks(entries).length);

    // Rebuilding with no content change must not re-parse anything.
    renderSpy.mockClear();
    overlay.refresh();
    expect(renderSpy).not.toHaveBeenCalled();

    // A token delta re-parses only the entry that actually changed.
    renderSpy.mockClear();
    streamingAssistant(entries).text += " more";
    overlay.refresh();
    expect(renderSpy.mock.calls.length).toBe(1);
  });

  it("re-wraps only the transcript lines that changed", () => {
    const entries = makeTranscript(12);
    const { overlay } = fixture(entries);

    overlay.render(80);
    const sourceLines = (overlay as any).transcriptLines.length as number;
    expect(sourceLines).toBeGreaterThan(50);

    // Same frame, unchanged content: every wrapped line is a cache hit.
    wrapSpy.mockClear();
    overlay.render(80);
    expect(wrapSpy).not.toHaveBeenCalled();

    // After a token, only the lines belonging to the changed entry are re-wrapped.
    streamingAssistant(entries).text += " more";
    overlay.refresh();
    wrapSpy.mockClear();
    overlay.render(80);
    expect(wrapSpy.mock.calls.length).toBeGreaterThan(0);
    expect(wrapSpy.mock.calls.length).toBeLessThan(sourceLines);
  });

  it("does not accumulate wrapped line versions across a long stream", () => {
    const entries = makeTranscript(6);
    const { overlay } = fixture(entries);

    for (let token = 0; token < 60; token += 1) {
      streamingAssistant(entries).text += ` token${token}`;
      overlay.refresh();
      overlay.render(80);
    }

    const sourceLines = (overlay as any).transcriptLines.length as number;
    const cachedLines = (overlay as any).wrappedLineCache.size as number;
    // Entries for lines that no longer exist are pruned, so the cache tracks the
    // transcript size rather than the number of tokens that streamed through it.
    expect(cachedLines).toBeLessThanOrEqual(sourceLines + 1);
  });

  it("renders identically to a cold, un-cached rebuild", () => {
    const entries = makeTranscript(8);
    const { overlay } = fixture(entries);

    overlay.refresh();
    overlay.render(80);
    streamingAssistant(entries).text += " streamed token";
    overlay.refresh();
    const warm = overlay.render(80).join("\n");

    // Same content, brand new entry objects, so every cache is cold.
    const coldEntries = structuredClone(entries);
    const cold = fixture(coldEntries).overlay;
    cold.refresh();
    expect(cold.render(80).join("\n")).toBe(warm);
  });

  it("keeps rendering stable across width changes", () => {
    const entries = makeTranscript(8);
    const { overlay } = fixture(entries);

    overlay.refresh();
    const at80 = overlay.render(80).join("\n");
    overlay.render(60);
    expect(overlay.render(80).join("\n")).toBe(at80);
  });
});
