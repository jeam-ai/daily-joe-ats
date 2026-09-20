import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { SafeError } from "./config";
import type { Transaction } from "./database";

// Only migration/explicit recovery code enters this context. HTTP requests cannot
// opt out of the write fence. The persisted lease also fences other app instances.
export const persistenceMaintenance = new AsyncLocalStorage<boolean>();
export async function assertSourceWritable(tx: Transaction) {
  if (persistenceMaintenance.getStore()) return;
  const rows = await tx.query(
    "SELECT payload FROM records WHERE collection=$1 AND id=$2",
    ["persistence_control", "source"],
  );
  const lock = rows[0] && JSON.parse(String(rows[0].payload));
  if (lock && (lock.frozen || lock.expiresAt > Date.now()))
    throw new SafeError(
      lock.frozen
        ? "Storage migration is verified. An administrator must finish the Sheets cutover or explicitly resume the preserved source before saving changes."
        : "Storage migration is in progress. Records are available for reading; retry this change after migration completes.",
      409,
    );
}
