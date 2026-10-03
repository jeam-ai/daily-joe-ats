import { initialState } from "../../lib/server/initial-state";
import { transaction, putRecord } from "../../lib/server/database";
import { saveState } from "../../lib/server/repository";
import { seal, sessionHash } from "../../lib/auth/security";
import {
  analyzeOdoo,
  defaultOdooRules,
  type OdooReports,
} from "../../lib/odoo";
import type { Application, User } from "../../types";
import ExcelJS from "exceljs";
import { mkdirSync, writeFileSync } from "node:fs";
Object.assign(process.env, {
  PERSISTENCE_PROVIDER: "local",
  LOCAL_DATABASE_FILE: "final-system-qa-20261003.sqlite",
  GOOGLE_ALLOWED_EMAIL: "admin@example.invalid",
  OFFICIAL_CAREERS_EMAIL: "careers@example.invalid",
  GOOGLE_CLIENT_ID: "test",
  GOOGLE_CLIENT_SECRET: "test",
  GOOGLE_REDIRECT_URI: "http://localhost:3004/api/auth/callback",
  APP_ORIGIN: "http://localhost:3004",
  SESSION_SECRET: "s".repeat(40),
  TOKEN_ENCRYPTION_KEY: "ab".repeat(32),
  DATABASE_URL: "",
  AIVEN_DATABASE_URL: "",
  DATABASE_POOL_URL: "",
  GEMINI_API_KEY: "",
  GOOGLE_SHEETS_ID: "",
});
async function run() {
  mkdirSync("test-results", { recursive: true });
  const state = initialState();
  const admin: User = {
    id: "admin@example.invalid",
    email: "admin@example.invalid",
    name: "QA Admin",
    role: "Admin",
    title: "QA HR",
    active: true,
  };
  state.users = [
    admin,
    ...[
      "Viewer",
      "Office Assistant",
      "Talent Acquisition",
      "HR Generalist",
    ].map((role, i) => ({
      id: `role-${i}@example.invalid`,
      email: `role-${i}@example.invalid`,
      name: `QA ${role}`,
      role: role as User["role"],
      title: "QA",
      active: true,
    })),
  ];
  state.hiringNeeds = [
    {
      id: "qa-need",
      position: "Barista",
      location: "Naga City",
      slots: 12,
      filled: 0,
      urgency: "High",
      status: "Open",
      openedAt: "2026-10-01",
      targetDate: "2026-10-31",
      qualifications: "QA experience",
      questions: "QA",
      criteria: [],
    },
  ];
  state.applications = Array.from({ length: 360 }, (_, i): Application => {
    const hired = i >= 250 && i < 295,
      talent = i >= 295 && i < 325;
    const name =
      i === 12
        ? "Juan Dela Cruz"
        : i === 13
          ? "Maria Santos"
          : i === 14
            ? "Ana O'Neil 100%_QA"
            : `QA Candidate ${String(i).padStart(3, "0")}`;
    return {
      id: `QA-${String(i).padStart(4, "0")}`,
      applicant: {
        id: `person-${i}`,
        name,
        email: `qa${i}@example.invalid`,
        phone: `0917${String(i).padStart(7, "0")}`,
        location: "Naga City",
        experience: i % 7,
      },
      position: i % 4 ? "Barista" : "Service Crew",
      location: i % 3 ? "Naga City" : "Santa Rosa, Laguna",
      assignedBranch: i % 3 ? "Naga City" : "Santa Rosa, Laguna",
      appliedAt: new Date(
        Date.parse("2026-10-03T00:00:00Z") - i * 3600000,
      ).toISOString(),
      lastActivity: "2026-10-03T00:00:00Z",
      hiringNeedId: "qa-need",
      status: hired
        ? "Hired"
        : talent
          ? "Talent Pool"
          : i >= 325
            ? i % 2
              ? "Rejected"
              : "Withdrawn"
            : i % 5
              ? "New"
              : "For Review",
      stage: hired ? "Hired" : "Screening",
      screening: { outcome: "Requires Review", criteria: [], completedAt: "" },
      source: "Gmail",
      notes: ["Fictional QA record"],
      interviews: [],
      requirements: [
        {
          id: `req-${i}`,
          name: "Government ID",
          status: hired && i % 2 ? "Complete" : "Pending",
          notes: "",
        },
      ],
      timeline: [],
      onboardingStatus: hired && i % 2 ? "Completed" : "Pending Orientation",
      hiredAt: hired ? "2026-10-01T00:00:00Z" : undefined,
      employment: hired
        ? {
            status: "Active",
            date: "2026-10-01",
            actor: admin.email,
            notes: "QA",
          }
        : undefined,
      assignedTo: i === 12 ? "role-1@example.invalid" : admin.email,
    };
  });
  state.applications[12].information = {
    fields: {
      name: {
        source: "HR edit",
        evidence: "Juan Dela Cruz",
        confidence: "Confident",
        verifiedBy: admin.email,
      },
    },
    conflicts: [],
  };
  state.issuanceItems = [
    { id: "qa-apron", category: "Uniform", name: "QA Apron", active: true },
  ];
  state.issuance = [];
  state.issuanceInventory = [
    {
      id: "qa-stock",
      category: "Uniform",
      item: "QA Apron",
      beginning: 1000,
      issued: 0,
      onHand: 1000,
      updatedAt: "2026-10-03T00:00:00Z",
    },
  ];
  const reports: OdooReports = {
    attendance: [],
    pivot: [],
    period: {
      start: "2026-09-16",
      end: "2026-09-27",
      title: "QA realistic cutoff",
    },
    sources: [],
    warnings: [],
    aliases: [],
  };
  for (let e = 0; e < 119; e++)
    for (let d = 16; d <= 27; d++) {
      const index = e * 12 + d - 16,
        date = `2026-09-${d}`,
        name = `QA Employee ${String(e).padStart(3, "0")}`,
        minutes =
          index % 20 === 0
            ? 571
            : index % 20 === 1
              ? 479
              : index % 50 === 2
                ? 960
                : 480 + (index % 7) * 15;
      const checkIn = `${date} 09:00:00`,
        checkOut = new Date(Date.parse(`${date}T09:00:00Z`) + minutes * 60000)
          .toISOString()
          .replace("T", " ")
          .slice(0, 19);
      reports.pivot.push({
        row: index + 2,
        employee: name,
        date,
        worked: minutes / 60,
        expected: 9,
        difference: minutes / 60 - 9,
        balance: 0,
      });
      reports.attendance.push({
        row: index + 2,
        employee: name,
        employeeId: `emp-${e}`,
        checkIn,
        checkOut: index % 100 === 3 ? "" : checkOut,
        worked: minutes / 60,
        overtime: 0,
        extra: 0,
        location: e % 2 ? "Naga City" : "Santa Rosa, Laguna",
      });
    }
  const analysis = analyzeOdoo(reports, defaultOdooRules);
  const now = new Date().toISOString();
  await transaction(async (tx) => {
    await saveState(tx, state, { sync: false });
    for (const a of state.applications.slice(10, 20))
      await putRecord(
        tx,
        "application_sources",
        a.id,
        seal(
          {
            subject: "Application for Barista Position",
            body: `Full name: ${a.applicant.name}\nEmail: ${a.applicant.email}\nPhone: 09181112222\nApplying for: Barista`,
            from: `Recruitment Team <${a.applicant.email}>`,
          },
          process.env.TOKEN_ENCRYPTION_KEY!,
        ),
      );
    const sessions: Record<string, unknown> = {};
    for (const [i, u] of state.users!.entries())
      sessions[
        sessionHash(
          i === 0 ? "workflow-qa-session" : `final-qa-role-${i}`,
          process.env.SESSION_SECRET!,
        )
      ] = { email: u.email, name: u.name, expiresAt: Date.now() + 86400000 };
    sessions[sessionHash("final-qa-expired", process.env.SESSION_SECRET!)] = {
      email: admin.email,
      name: admin.name,
      expiresAt: Date.now() - 1000,
    };
    await putRecord(
      tx,
      "secure",
      "auth",
      seal(
        { sessions, events: [], requests: {} },
        process.env.TOKEN_ENCRYPTION_KEY!,
      ),
    );
    const batch = {
      ...analysis,
      id: "qa-realistic-cutoff",
      fingerprint: "final-qa-fixture",
      revision: 1,
      uploadedBy: admin.email,
      uploadedAt: now,
      analyzedAt: now,
    };
    await putRecord(
      tx,
      "odoo_batches",
      batch.id,
      seal(batch, process.env.TOKEN_ENCRYPTION_KEY!),
    );
    await putRecord(tx, "odoo_index", batch.id, {
      id: batch.id,
      period: analysis.period,
      uploadedAt: now,
      analyzedAt: now,
      revision: 1,
      records: batch.records.length,
      exceptions: batch.records.filter((r) => r.review.status === "For Review")
        .length,
      uploadedBy: admin.email,
      retentionExpiresAt: "2026-12-01T00:00:00Z",
    });
  });
  const aBook = new ExcelJS.Workbook(),
    pBook = new ExcelJS.Workbook();
  aBook.addWorksheet("Attendance").addRows([
    [
      "Employee",
      "Check In",
      "Check Out",
      "Worked Hours",
      "Overtime",
      "Extra Hours",
    ],
    [
      "QA Import Person",
      "2026-09-16 09:00:00",
      "2026-09-16 18:31:00",
      571 / 60,
      0,
      0,
    ],
  ]);
  pBook.addWorksheet("Pivot").addRows([
    [null, "September 2026"],
    [null, "Worked Hours", "Expected Hours", "Difference", "Balance"],
    ["QA Import Person", 571 / 60, 9, 31 / 60, 0],
    ["16 Sep 2026", 571 / 60, 9, 31 / 60, 0],
  ]);
  writeFileSync(
    "test-results/final-qa-Attendance.xlsx",
    Buffer.from(await aBook.xlsx.writeBuffer()),
  );
  writeFileSync(
    "test-results/final-qa-Pivot.xlsx",
    Buffer.from(await pBook.xlsx.writeBuffer()),
  );
  console.log(
    JSON.stringify({
      applications: state.applications.length,
      hired: 45,
      talent: 30,
      attendance: analysis.records.length,
      autoResolved: analysis.records.filter(
        (r) => r.review.status === "Resolved",
      ).length,
    }),
  );
}
void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
