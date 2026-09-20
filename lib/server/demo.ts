import "server-only";
import type { AppState, Application, HiringNeed, User } from "@/types";
import type { Transaction } from "./database";
import { audit, getState, saveState } from "./repository";
import { SafeError } from "./config";

export function demoDataset(state: AppState, actor: string) {
  const batch = crypto.randomUUID();
  const date = (days: number) =>
    new Date(Date.now() + days * 86400000).toISOString();
  const interviewDate = (days: number) => {
    const value = new Date(date(days));
    value.setUTCHours(6, 0, 0, 0); // 2 PM in the demo branches' timezone.
    return value.toISOString();
  };
  const rules = [
    "1+ year barista experience",
    "Customer service experience",
    "Available for shifting schedule",
    "High school graduate or equivalent",
  ].map((label, i) => ({
    id: `demo-rule-${i}`,
    label,
    kind: "Minimum" as const,
    absenceFails: false,
  }));
  const hiringNeeds: HiringNeed[] = [
    { position: "Barista", location: "Naga City", urgency: "Urgent" as const },
    {
      position: "Barista",
      location: "Santa Rosa, Laguna",
      urgency: "Medium" as const,
    },
    {
      position: "Team Leader",
      location: "Naga City",
      urgency: "High" as const,
    },
  ].map((need, i) => ({
    ...need,
    id: `demo-need-${batch}-${i}`,
    isDemo: true,
    slots: i === 0 ? 3 : 2,
    filled: 0,
    targetDate: date(14 + i * 7).slice(0, 10),
    status: "Open",
    qualifications: "Fictional demonstration only",
    questions: "Ask about availability and relevant experience.",
    criteria:
      i === 2
        ? [{ ...rules[0], label: "Team supervision experience" }, rules[1]]
        : rules,
  }));
  const applications: Application[] = [
    "Maria Santos",
    "Rafael Cruz",
    "Isabel Reyes",
    "Paolo Garcia",
    "Sofia Mendoza",
  ].map((name, i) => {
    const stage = [
      "Screening",
      "Initial Interview",
      "Final Interview",
      "Requirements",
      "Hired",
    ][i] as Application["stage"];
    const need = hiringNeeds[[0, 1, 2, 0, 1][i]];
    const id = `DEMO-${batch.slice(0, 8)}-${i + 1}`;
    const hired = stage === "Hired";
    return {
      id,
      isDemo: true,
      source: "Demo",
      applicant: {
        id: crypto.randomUUID(),
        name: `DEMO — ${name}`,
        email: `demo-${batch}-${i}@example.invalid`,
        phone: "",
        location: need.location,
        experience: i + 1,
      },
      position: need.position,
      location: need.location,
      hiringNeedId: need.id,
      appliedAt: date(-8 + i),
      stage,
      status: hired ? "Hired" : i === 0 ? "For Review" : "In Progress",
      lastActivity: date(-i / 10),
      assignedTo: actor,
      screening: {
        outcome: "Requires Review",
        method: "demo",
        completedAt: date(-3),
        criteria: need.criteria!.map((r, n) => ({
          id: r.id,
          requirement: r.label,
          result: n === 2 ? "Unclear" : "Met",
          evidence:
            n === 2
              ? "Schedule availability is not stated in the fictional resume."
              : `Fictional evidence: ${r.label} documented at Example Coffee.`,
        })),
        insight: `This fictional ${need.position} application demonstrates a review against the qualifications for ${need.location}. Experience and customer-service evidence are recorded; availability should be confirmed by HR. No hiring recommendation is made.`,
        evidence: [
          "Example Coffee — fictional work history",
          "Schedule availability — not stated",
        ],
      },
      notes: ["DEMO DATA — fictional applicant for internal demonstrations."],
      interviews:
        i === 0
          ? []
          : [
              {
                id: crypto.randomUUID(),
                stage: "Initial Interview",
                scheduledAt: interviewDate(i === 1 ? 2 : -4),
                status: i === 1 ? "Scheduled" : "Passed",
                notes: "Fictional demonstration interview",
              },
              ...(i >= 2
                ? [
                    {
                      id: crypto.randomUUID(),
                      stage: "Final Interview" as const,
                      scheduledAt: interviewDate(i === 2 ? 3 : -2),
                      status:
                        i === 2 ? ("Scheduled" as const) : ("Passed" as const),
                      notes: "Fictional demonstration interview",
                    },
                  ]
                : []),
            ],
      requirements: state.requirementTemplates.map((r, n) => ({
        ...r,
        status: hired || (i === 3 && n < 2) ? "Complete" : "Pending",
        notes: i === 3 && n < 2 ? "DEMO — verified for walkthrough" : "",
        ...(hired ? { verifiedBy: actor, date: date(-1) } : {}),
      })),
      timeline: [
        {
          id: crypto.randomUUID(),
          timestamp: date(-1),
          user: actor,
          action: "Demo applicant created",
          applicationId: id,
          metadata: {
            communication: "Demo isolation — no email or spreadsheet sync",
          },
        },
      ],
      onboardingStatus: hired ? "Completed" : "Pending Orientation",
      ...(hired
        ? {
            hiredAt: date(-1),
            orientationDate: date(-2).slice(0, 10),
            commitmentDate: date(-2).slice(0, 10),
            employment: {
              status: "Active" as const,
              date: date(-1).slice(0, 10),
              notes: "DEMO — onboarding completed",
              actor,
            },
          }
        : {}),
    };
  });
  return { applications, hiringNeeds };
}

export async function purgeDemoApplication(tx: Transaction, a: Application) {
  if (!a.isDemo)
    throw new SafeError(
      "Only marked demo records can be removed permanently.",
      403,
    );
  for (const table of [
    "interviews",
    "application_requirements",
    "screening_results",
    "employment_records",
    "application_events",
  ])
    await tx.query(`DELETE FROM ${table} WHERE application_id=$1`, [a.id]);
  await tx.query("DELETE FROM intake_window WHERE application_id=$1", [a.id]);
  await tx.query("DELETE FROM applications WHERE id=$1", [a.id]);
  await tx.query(
    "DELETE FROM applicants WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM applications WHERE applicant_id=$1)",
    [a.applicant.id],
  );
}

export async function launchDemo(tx: Transaction, user: User) {
  const state = await getState(tx);
  if (
    state.applications.some((a) => a.isDemo) ||
    state.hiringNeeds.some((n) => n.isDemo)
  )
    return {
      imported: 0,
      message:
        "Demo data is already available. Clear it before starting a new demo.",
    };
  const data = demoDataset(state, user.email);
  state.applications.push(...data.applications);
  state.hiringNeeds.push(...data.hiringNeeds);
  await saveState(tx, state, { sync: false });
  await audit(tx, user.email, "demo.launched", undefined, {
    applications: 5,
    hiringNeeds: 3,
  });
  return {
    imported: 5,
    message: "Demo ready: 5 applicants and 3 hiring needs.",
  };
}

export async function controlledTestApplicant(tx: Transaction, user: User) {
  if (user.role !== "Admin")
    throw new SafeError("Administrator access required.", 403);
  const state = await getState(tx),
    id = "demo-test-jeam";
  if (state.applications.some((a) => a.id === id))
    return { id, created: false };
  if (
    state.applications.some(
      (a) => a.applicant.email.toLowerCase() === "deveraajeam@gmail.com",
    )
  )
    throw new SafeError(
      "An applicant already uses the designated test email. Review that record before creating a duplicate.",
      409,
    );
  const dataset = demoDataset(state, user.email),
    a = dataset.applications[0],
    need = dataset.hiringNeeds[0];
  a.id = id;
  a.applicant.name = "TEST / DEMO — Jeam De Vera";
  a.applicant.email = "deveraajeam@gmail.com";
  a.source = "Controlled test";
  a.isDemo = true;
  a.timeline = a.timeline.map((e) => ({ ...e, applicationId: id }));
  a.notes = [
    "Controlled test requested by the workspace owner. Fictional evidence; excluded from real recruitment and spreadsheets. Email can only be sent using the separate designated-recipient test action.",
  ];
  state.hiringNeeds.push(need);
  state.applications.push(a);
  await saveState(tx, state, { sync: false });
  await audit(tx, user.email, "demo.test_created", id, {
    name: a.applicant.name,
    recipient: a.applicant.email,
  });
  return { id, created: true };
}

export async function clearDemo(tx: Transaction, user: User) {
  const state = await getState(tx);
  const demos = state.applications.filter((a) => a.isDemo);
  const needs = state.hiringNeeds.filter((n) => n.isDemo);
  if (
    state.applications.some(
      (a) => !a.isDemo && needs.some((n) => n.id === a.hiringNeedId),
    )
  )
    throw new SafeError(
      "A real application references a demo hiring need. Correct the assignment before clearing demo data.",
      409,
    );
  for (const a of demos) await purgeDemoApplication(tx, a);
  for (const n of needs)
    await tx.query("DELETE FROM hiring_needs WHERE id=$1", [n.id]);
  for (const n of state.notifications.filter((n) => n.isDemo))
    await tx.query("DELETE FROM notifications WHERE id=$1", [n.id]);
  state.applications = state.applications.filter((a) => !a.isDemo);
  state.hiringNeeds = state.hiringNeeds.filter((n) => !n.isDemo);
  await saveState(tx, state, { sync: false });
  await audit(tx, user.email, "demo.cleared", undefined, {
    removed: demos.length,
    hiringNeeds: needs.length,
  });
  return {
    removed: demos.length,
    message: "Demo data cleared. Real records are unchanged.",
  };
}
