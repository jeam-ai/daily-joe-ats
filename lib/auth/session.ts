import "server-only";
import { cookies } from "next/headers";
import { config, SafeError } from "@/lib/server/config";
import { withStore } from "@/lib/server/store";
import { findUser } from "@/lib/server/repository";
import { sessionHash } from "./security";
export const SESSION_COOKIE = "dj_session";
export async function currentUser() {
  const id = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!id) return null;
  const c = config();
  const session = await withStore(
    (s) => s.sessions[sessionHash(id, c.sessionSecret)],
    false,
  );
  if (!session || session.expiresAt <= Date.now()) return null;
  const user = await findUser(session.email);
  return user
    ? {
        ...user,
        name: session.name || user.name || user.email,
        avatarUrl: session.picture || user.avatarUrl,
      }
    : null;
}
export async function requireUser() {
  const user = await currentUser();
  if (!user)
    throw new SafeError(
      "Sign in with the authorized Google account first.",
      401,
    );
  return user;
}
export function requireOrigin(request: Request) {
  if (request.headers.get("origin") !== config().origin)
    throw new SafeError(
      "Request origin is not authorized. Refresh the application and try again.",
      403,
    );
}
