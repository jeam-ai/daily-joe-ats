import type { HiringNeed } from "./index";
export interface ReportBucket {
  name: string;
  count: number;
}
export interface RecruitmentReport {
  total: number;
  hired: number;
  talentPool: number;
  interviewPipeline: number;
  screening: ReportBucket[];
  groups: Record<"position" | "location" | "stage" | "status", ReportBucket[]>;
  months: { key: string; count: number }[];
  averageDaysToHire: number | null;
  hireCount: number;
  details: {
    rejectionReasons: ReportBucket[];
    withdrawalReasons: ReportBucket[];
    sources: ReportBucket[];
    employment: ReportBucket[];
    screening: ReportBucket[];
    interviews: ReportBucket[];
  };
  hiringNeeds: HiringNeed[];
}
