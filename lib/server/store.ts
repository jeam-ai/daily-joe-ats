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
  return transaction(async (tx) => {
    const encrypted = await readRecord<string>(tx, "secure", "auth");
    const store = encrypted
      ? unseal<Store>(encrypted, config().encryptionKey)
      : process.env.DATABASE_URL
        ? ({ sessions: {}, events: [], requests: {} } as Store)
        : await read();
    const count = store.events.length;
    const result = await fn(store);
    if (persist)
      for (const event of store.events.slice(count))
        await tx.query(
          "INSERT INTO audit_logs(id,occurred_at,actor,action,application_id,payload) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING",
          [
            event.id,
            event.timestamp,
            event.user,
            event.action,
            null,
            JSON.stringify(event.metadata),
          ],
        );
    if (persist || !encrypted)
      await putRecord(
        tx,
        "secure",
        "auth",
        seal(store, config().encryptionKey),
      );
    return result;
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
