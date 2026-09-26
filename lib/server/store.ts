import { writeAudit } from "./audit";
import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { seal, unseal } from "@/lib/auth/security";
import { config } from "./config";
import { transaction, readRecord, putRecord } from "./database";
export interface StoredConnection {
  scopes?: string[];
  email: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  connectedAt: string;
  connectedBy?: string;
}
export interface IntegrationEvent {
  id: string;
  timestamp: string;
  user: string;
  action: string;
  metadata: Record<string, string>;
}
interface Store {
  connection?: StoredConnection;
  sessions: Record<
    string,
    { email: string; name?: string; picture?: string; expiresAt: number }
  >;
  officialConnection?: StoredConnection;
  sheetsConnection?: StoredConnection;
  storageConnection?: StoredConnection;
  events: IntegrationEvent[];
  requests: Record<
    string,
    { status: "pending" | "sent" | "failed"; createdAt: number }
  >;
}
async function read(): Promise<Store> {
  const file = path.join(process.cwd(), ".data", "secure-store.enc");
  try {
    return unseal<Store>(await readFile(file, "utf8"), config().encryptionKey);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { sessions: {}, events: [], requests: {} };
    throw error;
  }
}
// Auth state is encrypted inside the transactional database; the old local file is read only for migration.
export function withStore<T>(
  fn: (s: Store) => T | Promise<T>,
  persist = true,
): Promise<T> {
  let step = "start";
  return transaction(
    async (tx) => {
      step = "read_secure_record";
      const encrypted = await readRecord<string>(tx, "secure", "auth");
      const store = encrypted
        ? unseal<Store>(encrypted, config().encryptionKey)
        : process.env.DATABASE_URL
          ? ({ sessions: {}, events: [], requests: {} } as Store)
          : await read();
      const count = store.events.length;
      step = "update_store";
      const result = await fn(store);
      if (persist) {
        step = "write_audit";
        for (const event of store.events.slice(count))
          await writeAudit(
            tx,
            event.user,
            event.action,
            undefined,
            event.metadata,
          );
      }
      if (persist || (!encrypted && !process.env.DATABASE_URL)) {
        step = "write_secure_record";
        await putRecord(
          tx,
          "secure",
          "auth",
          seal(store, config().encryptionKey),
        );
      }
      step = "commit";
      return result;
    },
    { readOnly: !persist },
  ).catch((error: unknown) => {
    // PostgreSQL SQLSTATE and a fixed operation label are enough to diagnose
    // a failed session write. Never log the SQL, encrypted store or tokens.
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    console.error("Secure store transaction failed", {
      step,
      ...(persist ? { operation: "write" } : { operation: "read" }),
      ...(/^[0-9A-Z]{5}$/.test(code) ? { sqlstate: code } : {}),
    });
    throw error;
  });
}
export function recordEvent(
  store: { events: IntegrationEvent[] },
  user: string,
  action: string,
  metadata: Record<string, string> = {},
) {
  store.events.push({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    user,
    action,
    metadata,
  });
}
