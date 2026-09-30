import { NextResponse } from "next/server";
import { after } from "next/server";
import { SafeError } from "./config";
import { bufferFailure, isDatabaseFailure } from "./diagnostic-buffer";
import { reportIssue } from "./diagnostics";

function safeFailureSummary(error: unknown) {
  const candidate = error as {
    code?: unknown;
    name?: unknown;
    message?: unknown;
  };
  const message =
    typeof candidate?.message === "string"
      ? candidate.message
          .replace(
            /(?:postgres(?:ql)?:\/\/|https?:\/\/)[^\s]+/gi,
            "[redacted-url]",
          )
          .slice(0, 500)
      : "Unknown non-error value";
  return {
    type:
      typeof candidate?.name === "string"
        ? candidate.name.slice(0, 100)
        : "Error",
    code:
      typeof candidate?.code === "string"
        ? candidate.code.slice(0, 100)
        : undefined,
    message,
  };
}

export function safeError(error: unknown) {
  const databaseFailure = isDatabaseFailure(error);
  const unexpected = databaseFailure || !(error instanceof SafeError);
  const diagnosticId = unexpected
    ? `djc-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`
    : undefined;
  if (diagnosticId)
    console.error("Daily Joe Careers request failure", {
      diagnosticId,
      ...safeFailureSummary(error),
    });
  if (databaseFailure) {
    bufferFailure("database.unavailable");
    after(() => reportIssue("database.unavailable"));
  } else if (
    error instanceof SafeError &&
    /Sheets|Spreadsheet|Records changed while loading|Sheets storage timed out/.test(
      error.message,
    )
  ) {
    bufferFailure("sheets.sync");
    after(() => reportIssue("sheets.sync"));
  } else if (!(error instanceof SafeError)) {
    bufferFailure("server.failure");
    after(() => reportIssue("server.failure"));
  }
  const message = databaseFailure
    ? "The ATS database is temporarily unavailable. No changes were saved. Wait a moment and retry."
    : error instanceof SafeError &&
        !/Missing server configuration|DATABASE_URL|security keys|OAuth URLs|HTTPS is required|Google OAuth must/.test(
          error.message,
        )
      ? error.message
      : error instanceof SafeError && error.status === 504
        ? "This operation took too long. Refresh to check its status, then try again."
        : "The operation could not be completed. Try again, or contact your workspace administrator if the issue continues.";
  return NextResponse.json(
    {
      error: diagnosticId ? `${message} Reference: ${diagnosticId}.` : message,
      ...(diagnosticId ? { diagnosticId } : {}),
    },
    {
      status: databaseFailure
        ? 503
        : error instanceof SafeError
          ? error.status
          : 500,
      headers: {
        "Cache-Control": "no-store",
        ...(diagnosticId ? { "X-DJC-Diagnostic-Id": diagnosticId } : {}),
      },
    },
  );
}
