import type { AppState, Application, ApplicationStatus, Stage } from "@/types";
const date = (days = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
};
export const defaultRequirements = [
  "Government-issued ID",
  "Medical clearance",
  "Employment references",
  "Signed offer letter",
].map((name, i) => ({ id: `req-${i}`, name }));
const names = [
  "Sofia Reyes",
  "Mateo Santos",
  "Isabel Cruz",
  "Lucas Mendoza",
  "Amara Flores",
  "Nico Villanueva",
  "Elena Garcia",
  "Rafael Torres",
  "Mia Castillo",
  "Gabriel Ramos",
  "Clara Navarro",
  "Ethan Bautista",
  "Luna Mercado",
  "Marco Dela Vega",
  "Ava Rivera",
  "Diego Fernandez",
  "Lea Aquino",
  "Noah Santiago",
  "Eva Soriano",
  "Leo Valencia",
  "Celine Lim",
  "Paolo Rivera",
  "Alina Perez",
  "Enzo Manuel",
];
const stages: Stage[] = [
  "Screening",
  "Screening",
  "Initial Interview",
  "Final Interview",
  "Requirements",
  "Onboarding",
  "Hired",
  "Screening",
  "Screening",
  "Initial Interview",
  "Screening",
  "Screening",
];
const statuses: ApplicationStatus[] = [
  "New",
  "For Review",
  "In Progress",
  "Approved",
  "In Progress",
  "In Progress",
  "Hired",
  "Rejected",
  "Withdrawn",
  "No Response",
  "Talent Pool",
  "New",
];
export function createSeed(): AppState {
  const applications: Application[] = names.map((name, i): Application => {
    const stage = stages[i % 12];
    const status = statuses[i % 12];
    const appliedAt = date(-(i % 19));
    const id = `DJ-${String(1041 + i).padStart(4, "0")}`;
    return {
      id,
      applicant: {
        id: `person-${i}`,
        name,
        email: `candidate${i + 1}@example.com`,
        phone: `+63 900 000 ${String(i + 1).padStart(4, "0")}`,
        location: i % 3 === 0 ? "Santa Rosa, Laguna" : "Naga City",
        experience: 1 + (i % 5),
      },
      position:
        i % 7 === 0 ? "Supervisor" : i % 4 === 0 ? "Team Leader" : "Barista",
      location: i % 3 === 0 ? "Santa Rosa, Laguna" : "Naga City",
      appliedAt,
      stage,
      status,
      screening: {
        outcome:
          i % 5 === 0
            ? "Requires Review"
            : i % 7 === 0
              ? "Criteria Not Met"
              : "Meets Criteria",
        completedAt: appliedAt,
        criteria: [
          {
            id: "experience",
            requirement: "At least one year of customer-facing experience",
            result: "Met",
            evidence: `Fictional resume lists ${1 + (i % 5)} years in customer-facing roles.`,
          },
          {
            id: "location",
            requirement: "Available to work at the requested branch",
            result: i % 5 === 0 ? "Unclear" : "Met",
            evidence:
              i % 5 === 0
                ? "Branch availability is not stated in the fictional resume."
                : "Fictional resume states availability at the requested location.",
          },
          {
            id: "schedule",
            requirement: "Available for rotating shifts",
            result: i % 7 === 0 ? "Not Met" : "Met",
            evidence:
              i % 7 === 0
                ? "Fictional resume states weekday mornings only."
                : "Fictional resume states availability for rotating shifts.",
          },
        ],
      },
      lastActivity: date(-(i % 5)),
      notes: [],
      interviews: stage.includes("Interview")
        ? [
            {
              id: `interview-${i}`,
              stage: stage as "Initial Interview" | "Final Interview",
              scheduledAt: date((i % 3) + 1),
              status: "Scheduled",
              notes: "",
            },
          ]
        : [],
      requirements: defaultRequirements.map((r, j) => ({
        ...r,
        status: j < i % 5 ? "Complete" : "Pending",
        notes: "",
        ...(j < i % 5 ? { verifiedBy: "Demo HR", date: date(-1) } : {}),
      })),
      timeline: [
        {
          id: `event-${i}`,
          timestamp: appliedAt,
          user: "Demo intake",
          action: "Application received",
          applicationId: id,
          metadata: { source: "Fictional fixture" },
        },
        {
          id: `screen-${i}`,
          timestamp: appliedAt,
          user: "Demo screening",
          action: "Screening completed",
          applicationId: id,
          metadata: { mode: "Illustrative evidence only" },
        },
      ],
      onboardingStatus:
        status === "Hired" ? "Completed" : "Pending Orientation",
      ...(status === "Hired" ? { hiredAt: date(-2) } : {}),
      ...(status === "Talent Pool" ? { talentPoolAddedAt: date(-3) } : {}),
    };
  });
  return {
    version: 1,
    applications,
    hiringNeeds: [
      {
        id: "need-1",
        position: "Barista",
        location: "Naga City",
        slots: 5,
        filled: 2,
        urgency: "High",
        targetDate: date(12).slice(0, 10),
        status: "Open",
        qualifications:
          "1 year customer-facing experience; rotating shift availability",
        questions: "What does great hospitality mean to you?",
      },
      {
        id: "need-2",
        position: "Barista",
        location: "Santa Rosa, Laguna",
        slots: 3,
        filled: 1,
        urgency: "High",
        targetDate: date(15).slice(0, 10),
        status: "Open",
        qualifications: "Customer service experience",
        questions: "Describe a busy shift you handled.",
      },
      {
        id: "need-3",
        position: "Team Leader",
        location: "Naga City",
        slots: 2,
        filled: 0,
        urgency: "Medium",
        targetDate: date(21).slice(0, 10),
        status: "Open",
        qualifications: "2 years team leadership",
        questions: "How do you coach a new teammate?",
      },
      {
        id: "need-4",
        position: "Supervisor",
        location: "Naga City",
        slots: 1,
        filled: 0,
        urgency: "Medium",
        targetDate: date(25).slice(0, 10),
        status: "Open",
        qualifications: "3 years hospitality operations",
        questions: "How do you organize a branch opening?",
      },
    ],
    qualifications: ["Barista", "Team Leader", "Supervisor"].map(
      (position, i) => ({
        id: `qualification-${i}`,
        position,
        minimum: `${i + 1} year(s) relevant experience\nAvailable for rotating shifts`,
        preferred: "Hospitality experience\nCustomer service training",
        criteria:
          "Assess only the requirements listed above. Cite resume evidence; mark missing evidence as unclear.",
        questions: "Why would you like to join Daily Joe?",
      }),
    ),
    requirementTemplates: defaultRequirements,
    emailTemplates: [
      "Initial Interview",
      "Final Interview",
      "Requirements",
      "Follow-up",
      "Rejection",
      "No Response",
      "Onboarding",
    ].map((name, i) => ({
      id: `template-${i}`,
      name,
      subject: `Daily Joe Careers — ${name}`,
      body: `Hello {{applicant_name}},\n\nThank you for your interest in the {{position}} role at {{location}}.\n\n${name.includes("Interview") ? "We would like to invite you to an interview on {{interview_date}} at {{interview_time}}." : name === "Rejection" ? "Thank you for taking the time to apply. We will not be proceeding with this application. We appreciate your interest in Daily Joe." : name === "No Response" ? "We are following up on your application. Please let us know if you would like to continue." : "We would like to share the next steps in your application with you."}\n\nWarmly,\nDaily Joe Careers`,
    })),
    notifications: [
      {
        id: "n1",
        title: "Applications ready for review",
        description: "A little attention can open a new opportunity.",
        href: "/applications?status=For%20Review",
        read: false,
        date: date(),
      },
      {
        id: "n2",
        title: "Interviews coming up",
        description: "Review your candidates before the conversation.",
        href: "/applications?view=interviews",
        read: false,
        date: date(),
      },
      {
        id: "n3",
        title: "No response after 2 days",
        description:
          "Follow up or review. No applicant is automatically rejected.",
        href: "/applications?status=No%20Response",
        read: false,
        date: date(-1),
      },
      {
        id: "n4",
        title: "Naga City needs more baristas",
        description: "Three openings remain in a high-priority hiring request.",
        href: "/hiring-needs",
        read: false,
        date: date(),
      },
    ],
    preferences: { compact: false, weekStartsMonday: true },
  };
}
