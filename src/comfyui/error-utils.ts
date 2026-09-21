import type { KonteError } from "../core/errors.js";
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

/** Whether this failure is the server rejecting who we are, rather than a comms problem. */
export function isAuthFailure(err: KonteError): boolean {
  return err.code === "COMFYUI_UNAUTHORIZED" || err.code === "MISSING_TOKEN";
}
