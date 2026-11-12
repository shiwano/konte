import { constantTimeEquals, newSessionToken } from "../../page-host/auth.js";
import { errorResponse, jsonResponse, parseJsonBody } from "../../page-host/http.js";
import { SESSION_HEADER, type RedeemTokenResponse } from "../../../pages/settings/types.js";

export interface SettingsSession {
  /** Handles `REDEEM_TOKEN_PATH`; the first request carrying the launch token gets the session. */
  redeem(req: Request): Promise<Response>;
  refuse(req: Request): Response | null;
}

export function createSettingsSession(launchToken: string): SettingsSession {
  const session = newSessionToken();
  let redeemed = false;

  return {
    async redeem(req) {
      const body = await parseJsonBody<{ token?: unknown }>(req);
      const given = typeof body?.token === "string" ? body.token : "";
      if (redeemed || !constantTimeEquals(given, launchToken)) {
        return errorResponse(
          "This link has already been used or belongs to another run. Run `konte settings` again.",
          "SESSION_REQUIRED",
          401,
        );
      }
      redeemed = true;
      return jsonResponse({ session } satisfies RedeemTokenResponse);
    },
    refuse(req) {
      const given = req.headers.get(SESSION_HEADER);
      if (given !== null && constantTimeEquals(given, session)) return null;
      return errorResponse(
        "This page has no session. Run `konte settings` again.",
        "SESSION_REQUIRED",
        401,
      );
    },
  };
}
