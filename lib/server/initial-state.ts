import { defaultEmailTemplate } from "@/lib/email-templates";
import type { AppState, User } from "@/types";
export function initialState(): AppState {
  const owner = process.env.GOOGLE_ALLOWED_EMAIL?.toLowerCase();
  const official =
    process.env.OFFICIAL_CAREERS_EMAIL || "careers@daily-joe.com";
  const users: User[] = [
    ...new Set([owner, official].filter(Boolean) as string[]),
  ].map((email) => ({
    id: email,
    email,
    name:
      email === "deveraajeam@gmail.com"
        ? "Jeam A. De Vera"
        : email === official
          ? ""
          : "",
    role: email === owner ? "Admin" : "Talent Acquisition",
    title:
      email === official ? "Talent Acquisition Specialist" : "HR Associate",
    active: true,
  }));
  return {
    version: 1,
    revision: 0,
    users,
    applications: [],
    hiringNeeds: [],
    notifications: [],
    importLimit: 100,
    importValidated: false,
    intakeQuery:
      "has:attachment {subject:application subject:applying subject:resume subject:cv} -in:spam -in:trash -in:sent",
    locations: [
      {
        id: "naga",
        name: "Naga City",
        city: "Naga City",
        province: "Camarines Sur",
        active: true,
      },
      {
        id: "santa-rosa",
        name: "Santa Rosa, Laguna",
        city: "Santa Rosa",
        province: "Laguna",
        active: true,
      },
    ],
    qualifications: ["Barista", "Team Leader", "Supervisor"].map(
      (position) => ({
        id: position,
        position,
        minimum: "",
        preferred: "",
        criteria: "",
        questions: "",
        rules: [],
      }),
    ),
    requirementTemplates: [
      "SSS",
      "PhilHealth",
      "Pag-IBIG",
      "NBI Clearance",
      "Medical Certificate",
    ].map((name, i) => ({ id: `requirement-${i}`, name })),
    emailTemplates: [
      "Initial Interview",
      "Final Interview",
      "Requirements",
      "Onboarding",
      "Hired",
      "Rejection",
      "Follow-up",
      "No Response",
    ].map(defaultEmailTemplate),
    preferences: {
      compact: false,
      weekStartsMonday: true,
      theme: "light",
      timezone: "Asia/Manila",
      dateFormat: "en-PH",
      notifications: true,
    },
  };
}
