export type DiagnosticSeverity =
  "Informational" | "Minor" | "Needs Attention" | "Critical";
export type DiagnosticStatus =
  | "Active"
  | "Retrying"
  | "Needs Human Action"
  | "Needs Developer Action"
  | "Automatically Resolved"
  | "Fixed"
  | "Closed"
  | "Recurring";
export interface DiagnosticIssue {
  id: string;
  key: string;
  category: string;
  module: string;
  severity: DiagnosticSeverity;
  status: DiagnosticStatus;
  title: string;
  message: string;
  affected: string[];
  unaffected: string[];
  steps: string[];
  firstAt: string;
  lastAt: string;
  occurrences: number;
  recoveryAttempts: number;
  entityId?: string;
  user?: string;
  jobId?: string;
  auditId?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolution?: string;
  history: { at: string; action: string; actor: string }[];
}
export interface AuditEvent {
  id: string;
  timestamp: string;
  actor: string;
  role: string;
  action: string;
  module: string;
  entityType: string;
  entityId?: string;
  source: string;
  status: string;
  details: Record<string, unknown>;
}
export interface HealthCheck {
  id: string;
  service: string;
  status:
    | "Healthy"
    | "Attention Needed"
    | "Unavailable"
    | "Not Configured"
    | "Not Verified";
  checkedAt?: string;
  lastSuccess?: string;
  responseMs?: number;
  detail: string;
  href?: string;
  action?: string;
}
export interface AiResult {
  summary: string;
  clarifiedInformation: {
    field: string;
    interpretation: string;
    evidence: string;
  }[];
  experience: { interpretation: string; evidence: string }[];
  uncertainties: string[];
  conflicts: string[];
  verify: string[];
}
export interface AiRun {
  id: string;
  applicationId: string;
  provider: "Gemini";
  model: string;
  requestedBy: string;
  requestedAt: string;
  completedAt?: string;
  status: "Running" | "Completed" | "Failed";
  sourceVersion: string;
  result?: AiResult;
  error?: string;
  errorCode?: string;
}
export interface AiProfile {
  configured: boolean;
  enabled: boolean;
  eligible: string[];
  sourceVersion: string;
  stale: boolean;
  run?: AiRun;
  canRun: boolean;
}
