import type { z } from "zod";
import type { Stage } from "../../../core/address.js";
import { isReviewStage } from "../../../core/review-mode.js";
import {
  AddressReviewSubmitSchema,
  DirectionSubmitSchema,
  ReelSubmitSchema,
} from "../../../core/review-submit.js";
import { errorResponse, parseJsonBody } from "../../page-host/http.js";
import { handleDirectionSubmit } from "./direction-review.js";
import { handleReelSubmit } from "./reel-submit.js";
import { handleReferenceSubmit } from "./reference-review.js";
import type { ReviewContext } from "./review-context.js";

type Parsed<T> = { ok: true; body: T } | { ok: false; response: Response };

// A submit body for this session's stage, or the 400 that refuses it, naming each invalid field.
async function parseSubmitBody<S extends z.ZodTypeAny>(
  req: Request,
  stage: Stage,
  schema: S,
): Promise<Parsed<z.infer<S>>> {
  const raw = await parseJsonBody<unknown>(req);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, response: errorResponse("Invalid request body", "INVALID_REQUEST", 400) };
  }
  const sent = (raw as { stage?: unknown }).stage;
  if (sent !== stage) {
    return {
      ok: false,
      response: errorResponse(
        isReviewStage(sent)
          ? `This page reviews the ${stage}; a submit for the ${sent} belongs to \`konte preview ${sent}\``
          : `Invalid review payload — stage: expected "${stage}"`,
        "INVALID_REQUEST",
        400,
      ),
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(body)"}: ${issue.message}`,
    );
    return {
      ok: false,
      response: errorResponse(
        `Invalid review payload — ${issues.join("; ")}`,
        "INVALID_REQUEST",
        400,
      ),
    };
  }
  return { ok: true, body: parsed.data };
}

/**
 * Applies a submit to the session's stage. `onAccepted` runs once the body is taken, before anything
 * is written.
 */
export async function handleSubmit(
  ctx: ReviewContext,
  req: Request,
  onAccepted: () => void = () => {},
): Promise<Response> {
  switch (ctx.stage) {
    case "video":
    case "animatic": {
      const parsed = await parseSubmitBody(req, ctx.stage, ReelSubmitSchema);
      if (!parsed.ok) return parsed.response;
      onAccepted();
      return handleReelSubmit(ctx, ctx.stage, parsed.body);
    }
    case "reference": {
      const { reference } = ctx;
      if (!reference) {
        return errorResponse("No reference definition loaded", "ADDRESS_NOT_FOUND", 400);
      }
      const parsed = await parseSubmitBody(req, ctx.stage, AddressReviewSubmitSchema);
      if (!parsed.ok) return parsed.response;
      onAccepted();
      return handleReferenceSubmit(ctx, reference, parsed.body);
    }
    case "direction": {
      const { direction } = ctx;
      if (!direction) {
        return errorResponse("No direction definition loaded", "ADDRESS_NOT_FOUND", 400);
      }
      const parsed = await parseSubmitBody(req, ctx.stage, DirectionSubmitSchema);
      if (!parsed.ok) return parsed.response;
      onAccepted();
      return handleDirectionSubmit(ctx, direction, parsed.body);
    }
  }
}
