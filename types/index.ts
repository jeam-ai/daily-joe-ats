export type Stage =
  | "Screening"
  | "Initial Interview"
  | "Final Interview"
  | "Requirements"
  | "Onboarding"
  | "Hired";
export type ApplicationStatus =
  | "New"
  | "For Review"
  | "Approved"
  | "In Progress"
  | "Hired"
  | "Rejected"
  | "Withdrawn"
  | "No Response"
  | "Talent Pool";
export type ScreeningOutcome =
  "Meets Criteria" | "Requires Review" | "Criteria Not Met";
export interface Applicant {
  id: string;
  name: string;
  email: string;
  phone: string;
  location: string;
  experience: number;
  availability?: string;
  education?: string;
  experienceDetails?: string;
  skills?: string;
  certifications?: string;
}
export interface ScreeningCriterion {
  id: string;
  requirement: string;
  result: "Met" | "Unclear" | "Not Met" | "Not Assessed";
  evidence: string;
}
export interface ScreeningResult {
  outcome: ScreeningOutcome;
  criteria: ScreeningCriterion[];
  completedAt: string;
  insight?: string;
  method?: "rules" | "ai" | "hr" | "demo";
  evidence?: string[];
}
export interface Interview {
  id: string;
  stage: "Initial Interview" | "Final Interview";
  scheduledAt: string;
  status:
    "Scheduled" | "Confirmed" | "Attended" | "No-show" | "Passed" | "Failed";
  notes: string;
}
export interface Requirement {
  id: string;
  name: string;
}
export interface RequirementChecklist extends Requirement {
  status: "Complete" | "Pending" | "Needs Correction";
  verifiedBy?: string;
  date?: string;
  notes: string;
}
export interface ApplicationTimelineEvent {
  id: string;
  timestamp: string;
  user: string;
  action: string;
  applicationId?: string;
  metadata: Record<string, string>;
}
export interface Application {
  queueState?: "Active" | "Queued" | "Closed";
  information?: {
    fields: Record<
      string,
      {
        source: string;
        evidence: string;
        confidence: "Confident" | "Uncertain" | "Missing";
        verifiedBy?: string;
      }
    >;
    conflicts: string[];
  };
  isDemo?: boolean;
  deletedAt?: string;
  deletedBy?: string;
  deletionReason?: string;
  extraction?: {
    method: "text" | "ocr" | "mixed";
    confidence?: number;
    pages?: number;
    textVersion?: string;
    warnings: string[];
  };
  hiringNeedId?: string;
  resumeId?: string;
  resumeHash?: string;
  source?: string;
  originalSubject?: string;
  rfcMessageId?: string;
  assignedTo?: string;
  rejectionReason?: string;
  withdrawalReason?: string;
  employment?: {
    status: "Active" | "Resigned" | "Terminated";
    date: string;
    notes: string;
    actor: string;
  };
  id: string;
  applicant: Applicant;
  position: string;
  location: string;
  appliedAt: string;
  stage: Stage;
  status: ApplicationStatus;
  screening: ScreeningResult;
  lastActivity: string;
  notes: string[];
  interviews: Interview[];
  requirements: RequirementChecklist[];
  timeline: ApplicationTimelineEvent[];
  gmailMessageId?: string;
  gmailThreadId?: string;
  hiredAt?: string;
  talentPoolAddedAt?: string;
  orientationDate?: string;
  commitmentDate?: string;
  onboardingStatus: "Pending Orientation" | "Scheduled" | "Completed";
}
export interface HiringNeed {
  isDemo?: boolean;
  id: string;
  position: string;
  location: string;
  slots: number;
  filled: number;
  urgency: "Urgent" | "High" | "Medium" | "Low";
  targetDate: string;
  status: "Open" | "Paused" | "Filled" | "Closed";
  criteria?: QualificationRule[];
  qualifications: string;
  questions: string;
}
export interface QualificationTemplate {
  rules?: QualificationRule[];
  id: string;
  position: string;
  minimum: string;
  preferred: string;
  criteria: string;
  questions: string;
}
export interface Notification {
  isDemo?: boolean;
  id: string;
  title: string;
  description: string;
  href: string;
  read: boolean;
  date: string;
}
export interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
  stage?: Stage;
  enabled?: boolean;
}
export interface User {
  id: string;
  email: string;
  name: string;
  role:
    | "Admin"
    | "Talent Acquisition"
    | "HR Generalist"
    | "Office Assistant"
    | "Viewer";
  title: string;
  active: boolean;
  avatarUrl?: string;
}
export interface QualificationRule {
  id: string;
  label: string;
  kind: "Minimum" | "Preferred";
  absenceFails: boolean;
}
export interface Location {
  id: string;
  name: string;
  city: string;
  province: string;
  active: boolean;
}
export interface IntegrationConnection {
  provider: "gmail";
  connected: boolean;
  email?: string;
  connectedAt?: string;
}
export interface AppState {
  demoAvailable?: boolean;
  revision?: number;
  users?: User[];
  currentUser?: User;
  locations?: Location[];
  importLimit?: number;
  importValidated?: boolean;
  intakeQuery?: string;
  trackerUpdatedAt?: string;
  syncStatus?: string;
  version: 1;
  applications: Application[];
  hiringNeeds: HiringNeed[];
  qualifications: QualificationTemplate[];
  requirementTemplates: Requirement[];
  emailTemplates: EmailTemplate[];
  notifications: Notification[];
  preferences: {
    compact: boolean;
    weekStartsMonday: boolean;
    theme?: "light" | "dark" | "system";
    timezone?: string;
    dateFormat?: string;
    notifications?: boolean;
  };
}
