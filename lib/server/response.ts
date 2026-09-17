import { NextResponse } from "next/server";
import { SafeError } from "./config";
export function safeError(error: unknown) {
  return NextResponse.json(
    {
      error:
        error instanceof SafeError
          ? error.message
          : "The operation could not be completed. Check server configuration and try again.",
    },
    {
      status: error instanceof SafeError ? error.status : 500,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
