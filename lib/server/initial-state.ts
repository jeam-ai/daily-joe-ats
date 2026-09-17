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
    name: "",
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
      "Follow-up",
      "Rejection",
      "No Response",
      "Onboarding",
    ].map((name) => ({
      id: name,
      name,
      subject: `Daily Joe Careers — ${name}`,
      body:
        name === "Rejection"
          ? "Hello {{applicant_name}},\n\nThank you for your interest in the {{position}} position at {{company_name}}. After careful consideration, we will not be progressing your application on this occasion. Thank you for your time and interest.\n\nDaily Joe Careers"
          : name.includes("Interview")
            ? "Hello {{applicant_name}},\n\nWe invite you to an interview for {{position}} at {{location}} on {{interview_date}} at {{interview_time}}. Please reply to confirm your availability.\n\nDaily Joe Careers"
            : "Hello {{applicant_name}},\n\nRegarding your application for {{position}} at {{location}}:\n\n[HR: enter your message before sending.]\n\nDaily Joe Careers",
    })),
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
