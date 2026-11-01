import { expect, it } from "vitest";
import { mcpProgramOf } from "../program-mcp.js";

it.each([
  [["mcp", "serve"], { command: "serve", cwd: undefined }],
  [["mcp", "worker"], { command: "worker", cwd: undefined }],
  [["--cwd", "/ws", "mcp", "serve"], { command: "serve", cwd: "/ws" }],
  [["--cwd=/ws", "mcp", "worker"], { command: "worker", cwd: "/ws" }],
])("takes %j", (args, expected) => {
  expect(mcpProgramOf(args)).toEqual(expected);
});

it.each([
  [["mcp", "serve", "--help"]],
  [["mcp", "serve", "-y"]],
  [["mcp"]],
  [["mcp", "status"]],
  [["job", "wait"]],
  [["--cwd"]],
  [["mcp", "serve", "--cwd", "/ws"]],
])("leaves %j to the program", (args) => {
  expect(mcpProgramOf(args)).toBeNull();
});
