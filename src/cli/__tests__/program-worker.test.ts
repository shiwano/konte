import { expect, it } from "vitest";
import { workerProgramOf } from "../program-worker.js";

it.each([
  [["job", "worker"], { cwd: undefined }],
  [["--cwd", "/ws", "job", "worker"], { cwd: "/ws" }],
  [["--cwd=/ws", "job", "worker"], { cwd: "/ws" }],
])("recognizes %j", (args, expected) => {
  expect(workerProgramOf(args)).toEqual(expected);
});

it.each([
  [["job", "worker", "--help"]],
  [["job", "worker", "-y"]],
  [["job"]],
  [["job", "wait"]],
  [["status"]],
  [["job", "worker", "--cwd", "/ws"]],
])("leaves %j to the full program", (args) => {
  expect(workerProgramOf(args)).toBeNull();
});
