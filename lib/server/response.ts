import { NextResponse } from "next/server";
import { after } from "next/server";
import { SafeError } from "./config";
import { bufferFailure, isDatabaseFailure } from "./diagnostic-buffer";
import { reportIssue } from "./diagnostics";
export function safeError(error: unknown) {
  if (isDatabaseFailure(error)) {
    bufferFailure("database.unavailable");
    after(() => reportIssue("database.unavailable"));
  } else if (
    error instanceof SafeError &&
    /Sheets|Spreadsheet|Records changed while loading/.test(error.message)
  ) {
    bufferFailure("sheets.sync");
    after(() => reportIssue("sheets.sync"));
  } else if (!(error instanceof SafeError)) {
    bufferFailure("server.failure");
    after(() => reportIssue("server.failure"));
  }
  return NextResponse.json(
    {
      error:
        error instanceof SafeError &&
        !/Missing server configuration|DATABASE_URL|security keys|OAuth URLs|HTTPS is required|Google OAuth must/.test(
          error.message,
        )
          ? error.message
          : error instanceof SafeError && error.status === 504
            ? "This operation took too long. Refresh to check its status, then try again."
            : "The operation could not be completed. Try again, or contact your workspace administrator if the issue continues.",
    },
    {
      status: error instanceof SafeError ? error.status : 500,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
