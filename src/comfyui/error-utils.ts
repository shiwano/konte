import { KonteError } from "../core/errors.js";
import type { ComfyUIHistoryEntry } from "./types.js";

type ComfyUIHistoryOutcome = "running" | "success" | "error";

// ComfyUI marks a failed prompt with status_str "error" and completed: false — only a
// successful prompt is completed: true. So an error is terminal regardless of completed;
// gating the error check on completed (the old bug) made a failure look still-running and
// hang until timeout.
export function historyOutcome(history: ComfyUIHistoryEntry): ComfyUIHistoryOutcome {
  if (history.status.status_str === "error") return "error";
  if (history.status.completed) return "success";
  return "running";
}

export function extractHistoryError(history: ComfyUIHistoryEntry): string | null {
  if (history.status.status_str !== "error") {
    return null;
  }

  for (const [msgType, msgData] of history.status.messages) {
    if (msgType === "execution_error" && msgData) {
      const nodeId = msgData.node_id as string | undefined;
      const exceptionType = msgData.exception_type as string | undefined;
      const exceptionMessage = msgData.exception_message as string | undefined;

      const parts: string[] = [];
      if (nodeId) parts.push(`node ${nodeId}`);
      if (exceptionType) parts.push(exceptionType);
      if (exceptionMessage) parts.push(exceptionMessage);

      if (parts.length > 0) {
        return `ComfyUI execution error: ${parts.join(" — ")}`;
      }
    }
  }

  return "ComfyUI execution failed";
}

export function historyFailure(history: ComfyUIHistoryEntry): KonteError {
  return new KonteError(
    "COMFYUI_ERROR",
    extractHistoryError(history) ?? "ComfyUI execution failed",
  );
}

const AUTH_FAILURES = ["COMFYUI_UNAUTHORIZED", "MISSING_TOKEN"] as const;

// A refused or unset credential says nothing of a prompt or install already running on the server.
export const UNOBSERVABLE = ["COMFYUI_UNAVAILABLE", ...AUTH_FAILURES] as const;

export function isAuthFailure(err: KonteError): boolean {
  return (AUTH_FAILURES as readonly string[]).includes(err.code);
}
