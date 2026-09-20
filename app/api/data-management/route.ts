import { after } from "next/server";
import { requireOrigin, requireUser } from "@/lib/auth/session";
import { SafeError, config } from "@/lib/server/config";
import { safeError } from "@/lib/server/response";
import { withStore } from "@/lib/server/store";
import { syncSheets } from "@/lib/google/sheets";
import {
  sheetsConfiguration,
  connectWorkbook,
  validateWorkbook,
  exportDatabase,
  upsertWorkbook,
} from "@/lib/server/sheets-management";
import {
  migrateToGateway,
  migrationStatus,
  saveSourceBackup,
} from "@/lib/server/sheets-migration";
import {
  gatewayConfigured,
  gatewayRequest,
  sheetsPrimary,
} from "@/lib/server/sheets-gateway";
import { seal } from "@/lib/auth/security";
import {
  transaction,
  readRecord,
  putRecord,
  readTransaction,
} from "@/lib/server/database";
import { audit } from "@/lib/server/repository";
import { persistenceMaintenance } from "@/lib/server/persistence-maintenance";
import {
  previewSpreadsheetImport,
  confirmSpreadsheetImport,
} from "@/lib/server/sheets-import";
export const runtime = "nodejs";
export const maxDuration = 300;
async function admin() {
  const user = await requireUser();
  if (user.role !== "Admin")
    throw new SafeError("Administrator access required.", 403);
  return user;
}
export async function GET(request: Request) {
  try {
    const user = await admin(),
      action = new URL(request.url).searchParams.get("action");
    if (action === "export") {
      const snapshot = await exportDatabase();
      snapshot.tables.records = snapshot.tables.records.filter(
        (r) => r.collection !== "secure",
      );
      await transaction((tx) =>
        audit(tx, user.email, "database.exported", undefined, {
          tables: Object.keys(snapshot.tables).length,
          credentialsExcluded: true,
        }),
      );
      return new Response(
        JSON.stringify({
          format: "Daily Joe Careers encrypted backup",
          version: 1,
          encrypted: seal(snapshot, config().encryptionKey),
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "Content-Disposition": `attachment; filename="Daily-Joe-Careers-Backup-${new Date().toISOString().slice(0, 10)}.json"`,
            "Cache-Control": "no-store",
          },
        },
      );
    }
    const [configuration, connection, migration, job] = await Promise.all([
      sheetsConfiguration(),
      withStore(
        (s) =>
          s.sheetsConnection
            ? {
                account: s.sheetsConnection.email,
                connectedAt: s.sheetsConnection.connectedAt,
              }
            : null,
        false,
      ),
      migrationStatus(),
      readTransaction((tx) => readRecord(tx, "data_jobs", "migration")),
    ]);
    return Response.json(
      {
        configuration,
        connection,
        migration,
        job,
        provider: sheetsPrimary()
          ? "Google Sheets"
          : process.env.PERSISTENCE_PROVIDER !== "local" &&
              process.env.DATABASE_URL
            ? "PostgreSQL"
            : "Local SQLite",
        gatewayConfigured: gatewayConfigured(),
        storageOAuthConfigured:
          !!process.env.SHEETS_GATEWAY_CLIENT_ID &&
          !!process.env.SHEETS_GATEWAY_CLIENT_SECRET,
        storageAccount: await withStore(
          (s) => s.storageConnection?.email || null,
          false,
        ),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return safeError(e);
  }
}
export async function POST(request: Request) {
  try {
    requireOrigin(request);
    const user = await admin();
    if (request.headers.get("X-DJC-Dataset") === "demo")
      throw new SafeError(
        "Data management is available only in the real workspace.",
        403,
      );
    const body = await request.json();
    if (
      sheetsPrimary() &&
      ["create", "connect", "migrate"].includes(body.action)
    )
      throw new SafeError(
        "Google Sheets is already the primary store. Switching workbooks requires a separately verified migration; existing records remain unchanged.",
        409,
      );
    if (body.action === "resume-source") {
      if (sheetsPrimary() || body.confirmed !== true)
        throw new SafeError(
          "Confirm resuming the preserved source workspace.",
          409,
        );
      await persistenceMaintenance.run(true, () =>
        transaction(async (tx) => {
          await putRecord(tx, "persistence_control", "source", {
            expiresAt: 0,
            frozen: false,
          });
          await audit(tx, user.email, "sheets.cutover_cancelled", undefined, {
            sourcePreserved: true,
          });
        }),
      );
      return Response.json({
        message:
          "Source workspace resumed. The existing verified workbook was preserved; a new migration needs a reviewed destination.",
      });
    }
    if (body.action === "preview-import")
      return Response.json(await previewSpreadsheetImport(user));
    if (body.action === "confirm-import") {
      if (body.confirmed !== true || typeof body.previewId !== "string")
        throw new SafeError("Review and confirm the import preview.");
      return Response.json(
        await confirmSpreadsheetImport(user, body.previewId),
      );
    }
    if (body.action === "create")
      return Response.json(await connectWorkbook(user, { create: true }));
    if (body.action === "connect") {
      if (body.confirmed !== true)
        throw new SafeError("Confirm the workbook connection first.");
      return Response.json(await connectWorkbook(user, { id: body.id }));
    }
    if (
      body.action === "validate" ||
      body.action === "test" ||
      body.action === "repair"
    )
      return Response.json(
        await validateWorkbook(user, body.action === "repair"),
      );
    if (body.action === "backup") {
      const saved = await saveSourceBackup(await exportDatabase());
      return Response.json({
        message: "Encrypted source backup saved and verified on this server.",
        id: saved.id,
      });
    }
    if (body.action === "sync") {
      if (sheetsPrimary()) {
        const status = await gatewayRequest("status");
        const message = await syncSheets();
        return Response.json({
          message,
          status,
        });
      }
      if (body.confirmed !== true)
        throw new SafeError(
          "Review and confirm copying the operational records into the connected workbook.",
        );
      return Response.json(await upsertWorkbook(await exportDatabase(), user));
    }
    if (body.action === "migrate") {
      if (body.confirmed !== true)
        throw new SafeError(
          "Confirm migration after reviewing the connected workbook and source backup.",
        );
      if (!gatewayConfigured())
        throw new SafeError(
          "The authenticated Sheets transaction gateway must be configured before migration.",
          409,
        );
      const id = crypto.randomUUID();
      await transaction(async (tx) => {
        const current = await readRecord<{ status: string; startedAt: string }>(
          tx,
          "data_jobs",
          "migration",
        );
        if (
          current?.status === "Running" &&
          Date.now() - Date.parse(current.startedAt) < 300000
        )
          throw new SafeError("A migration is already running.", 409);
        await putRecord(tx, "data_jobs", "migration", {
          id,
          status: "Running",
          startedAt: new Date().toISOString(),
        });
      });
      after(async () => {
        try {
          const report = await migrateToGateway(user);
          await persistenceMaintenance.run(true, () =>
            transaction((tx) =>
              putRecord(tx, "data_jobs", "migration", {
                id,
                status: report.verified ? "Completed" : "Needs attention",
                report,
                completedAt: new Date().toISOString(),
              }),
            ),
          );
        } catch (e) {
          await persistenceMaintenance
            .run(true, () =>
              transaction((tx) =>
                putRecord(tx, "data_jobs", "migration", {
                  id,
                  status: "Failed",
                  error:
                    e instanceof SafeError
                      ? e.message
                      : "Migration could not finish. Original data is preserved.",
                  completedAt: new Date().toISOString(),
                }),
              ),
            )
            .catch(() => undefined);
        }
      });
      return Response.json(
        {
          message: "Migration started. Status is recorded in Data Management.",
          id,
        },
        { status: 202 },
      );
    }
    throw new SafeError("Choose a supported data management action.");
  } catch (e) {
    return safeError(e);
  }
}
