import { expect, test } from "bun:test";
import { languageFromReply } from "../src/reply-language.mjs";

test("reads the edited file from an Anthropic tool_use block", () => {
  const reply = {
    type: "message", role: "assistant",
    content: [
      { type: "text", text: "Editing the module" },
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/repo/src/app.py", old_string: "a", new_string: "b" } },
    ],
  };
  expect(languageFromReply(reply, "anthropic")).toEqual({ language: "Python", write: true });
});

test("reads the patch path from a Responses function_call", () => {
  const reply = {
    status: "completed",
    output: [{
      type: "function_call", name: "apply_patch",
      arguments: JSON.stringify({ input: "*** Begin Patch\n*** Update File: src/view.tsx\n@@\n*** End Patch" }),
    }],
  };
  expect(languageFromReply(reply, "responses")).toEqual({ language: "TypeScript", write: true });
});

test("reads the edited file from a Chat tool_call", () => {
  const reply = {
    choices: [{ message: { role: "assistant", content: null, tool_calls: [
      { type: "function", id: "c1", function: { name: "write_file", arguments: JSON.stringify({ filePath: "docs/guide.md" }) } },
    ] } }],
  };
  expect(languageFromReply(reply, "chat")).toEqual({ language: "Markdown", write: true });
});

test("reads the edited file from a Gemini functionCall", () => {
  const reply = {
    candidates: [{ content: { role: "model", parts: [
      { functionCall: { id: "g1", name: "replace", args: { path: "config.yaml" } } },
    ] } }],
  };
  expect(languageFromReply(reply, "gemini")).toEqual({ language: "YAML", write: true });
});

test("falls back to a read tool, marked as not a write", () => {
  const reply = {
    type: "message", role: "assistant",
    content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/lib.rs" } }],
  };
  expect(languageFromReply(reply, "anthropic")).toEqual({ language: "Rust", write: false });
});

test("prefers the last write tool and ignores later reads", () => {
  const reply = {
    type: "message", role: "assistant",
    content: [
      { type: "tool_use", id: "t1", name: "Write", input: { file_path: "a.py" } },
      { type: "tool_use", id: "t2", name: "Edit", input: { file_path: "b.ts" } },
      { type: "tool_use", id: "t3", name: "Read", input: { file_path: "c.go" } },
    ],
  };
  expect(languageFromReply(reply, "anthropic")).toEqual({ language: "TypeScript", write: true });
});

test("recognizes Add File and Move to patch markers", () => {
  for (const [patch, language] of [
    ["*** Begin Patch\n*** Add File: pkg/server.go\n*** End Patch", "Go"],
    ["*** Begin Patch\n*** Move to: src/main.rs\n*** End Patch", "Rust"],
  ]) {
    const reply = { output: [{ type: "function_call", name: "apply_patch", arguments: patch }] };
    expect(languageFromReply(reply, "responses")).toEqual({ language, write: true });
  }
});

test("does not read file bodies or shell commands", () => {
  const write = {
    type: "message", role: "assistant",
    content: [{ type: "tool_use", name: "Write", input: { file_path: "notes.md", content: "a.py" } }],
  };
  expect(languageFromReply(write, "anthropic")).toEqual({ language: "Markdown", write: true });
  const shell = {
    type: "message", role: "assistant",
    content: [{ type: "tool_use", name: "Bash", input: { command: "cat solution.py" } }],
  };
  expect(languageFromReply(shell, "anthropic")).toEqual({ language: null, write: false });
});

test("returns nothing when the reply has no tool calls or no recognizable file", () => {
  expect(languageFromReply({ content: [{ type: "text", text: "Done" }] }, "anthropic"))
    .toEqual({ language: null, write: false });
  expect(languageFromReply({ content: [{ type: "tool_use", name: "Edit", input: { file_path: "data.bin" } }] }, "anthropic"))
    .toEqual({ language: null, write: false });
});

test("does not throw on malformed arguments", () => {
  const reply = { choices: [{ message: { tool_calls: [{ function: { name: "write_file", arguments: "{broken" } }] } }] };
  expect(languageFromReply(reply, "chat")).toEqual({ language: null, write: false });
});

test("detects the protocol when the caller does not pass one", () => {
  const reply = { type: "message", role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: "app.nix" } }] };
  expect(languageFromReply(reply)).toEqual({ language: "Nix", write: true });
});
