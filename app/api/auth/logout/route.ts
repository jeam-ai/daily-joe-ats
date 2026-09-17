import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/server/config";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { sessionHash } from "@/lib/auth/security";
import { withStore } from "@/lib/server/store";
export async function GET(request: NextRequest) {
  const c = config();
  const id = request.cookies.get(SESSION_COOKIE)?.value;
  if (id)
    await withStore((s) => {
      delete s.sessions[sessionHash(id, c.sessionSecret)];
    });
  const response = NextResponse.redirect(new URL("/login", c.origin));
  response.cookies.set(SESSION_COOKIE, "", { maxAge: 0, path: "/" });
  return response;
}
