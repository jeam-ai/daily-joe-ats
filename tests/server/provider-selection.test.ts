import test from "node:test";
import assert from "node:assert/strict";
import { aivenConfigured, postgresConfigured } from "../../lib/server/database";

test("Aiven remains the selected PostgreSQL provider without a legacy DATABASE_URL", () => {
  const names = [
    "AIVEN_DATABASE_URL",
    "DATABASE_POOL_URL",
    "DATABASE_URL",
    "PERSISTENCE_PROVIDER",
  ] as const;
  const original = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  try {
    for (const name of names) delete process.env[name];
    assert.equal(postgresConfigured(), false);
    process.env.PERSISTENCE_PROVIDER = "postgres";
    process.env.AIVEN_DATABASE_URL =
      "postgres://test:example@service.aivencloud.com:5432/defaultdb";
    assert.equal(postgresConfigured(), true);
    assert.equal(aivenConfigured(), true);

    process.env.DATABASE_URL =
      "postgres://legacy:example@old.example.invalid:5432/legacy";
    assert.equal(aivenConfigured(), true);

    process.env.PERSISTENCE_PROVIDER = "sheets";
    assert.equal(postgresConfigured(), false);
    process.env.PERSISTENCE_PROVIDER = "local";
    assert.equal(postgresConfigured(), false);
  } finally {
    for (const name of names) {
      const value = original[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
