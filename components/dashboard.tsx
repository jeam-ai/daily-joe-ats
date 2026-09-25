"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { greetingName } from "@/lib/identity";
import {
  ArrowUpRight,
  ArrowRight,
  UsersRound,
  Inbox,
  ScanEye,
  CheckCheck,
  CalendarDays,
  UserCheck,
  UserX,
  Undo2,
  Clock3,
  MapPin,
  Plus,
  ChevronRight,
  TriangleAlert,
  Sun,
  Database,
} from "lucide-react";
import { useApp } from "./provider";
import {
  Avatar,
  Badge,
  Card,
  MetricCard,
  ProgressBar,
  StatusBadge,
  StageLegend,
  LoadingSkeleton,
  EmptyState,
} from "./ui";
import { formatDate, formatTime } from "@/lib/dates";
import { requestJson } from "@/lib/client-request";
type RetentionSnapshot = {
  dryRun: boolean;
  queue: {
    active: number;
    queued: number;
    retentionPending: number;
    rejectedOrWithdrawnPending: number;
  };
  talentPoolExpiring: number;
  hiringNeedsExpiring: number;
  expiredHiringNeedsPending: number;
  activityRecordsPending: number;
  storagePercent: number | null;
  storageLevel: string;
  metrics: { month: string; metric: string; count: number }[];
};
export function Dashboard() {
  const { state, dataset } = useApp();
  const [retention, setRetention] = useState<RetentionSnapshot | null>(null);
  useEffect(() => {
    if (state?.currentUser?.role !== "Admin") return;
    const abort = new AbortController();
    requestJson<RetentionSnapshot>("/api/system/retention", {
      signal: abort.signal,
    })
      .then(setRetention)
      .catch(() => undefined);
    return () => abort.abort();
  }, [state?.currentUser?.role, state?.revision]);
  if (!state) return <LoadingSkeleton />;
  const now = new Date();
  const timezone = state.preferences.timezone || "Asia/Manila";
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "numeric",
      hourCycle: "h23",
    }).format(now),
  );
  const summary = state.applicationSummary?.[dataset];
  const apps = state.applications;
  const recentApps = [...apps].sort((a, b) =>
    b.appliedAt.localeCompare(a.appliedAt),
  );
  const monthly = summary?.currentMonthByStatus || {};
  const metrics = [
    ["Total Applications", Object.values(monthly).reduce((sum, count) => sum + (count || 0), 0), UsersRound, "Received this month", ""],
    [
      "New",
      monthly.New || 0,
      Inbox,
      "Ready for a first look",
      "New",
    ],
    [
      "For Review",
      monthly["For Review"] || 0,
      ScanEye,
      "Your perspective matters",
      "For Review",
    ],
    [
      "Approved",
      monthly.Approved || 0,
      CheckCheck,
      "Moving forward",
      "Approved",
    ],
    [
      "Interviews",
      summary?.interviewsThisMonth || 0,
      CalendarDays,
      "Conversations in progress",
      "interviews",
    ],
    [
      "Hired",
      monthly.Hired || 0,
      UserCheck,
      "New beginnings",
      "Hired",
    ],
    [
      "Rejected",
      monthly.Rejected || 0,
      UserX,
      "Applications closed",
      "Rejected",
    ],
    [
      "Withdrawn",
      monthly.Withdrawn || 0,
      Undo2,
      "Candidate withdrawals",
      "Withdrawn",
    ],
  ] as const;
  const upcoming = summary?.upcomingInterviews || [];
  const attention = [
    {
      title: "Applications awaiting review",
      description: "Help the next chapter begin.",
      count: summary?.byStatus["For Review"] || 0,
      href: "/applications?status=For%20Review",
      icon: ScanEye,
    },
    {
      title: "Interview decisions",
      description: "Keep good conversations moving.",
      count: summary?.interviewDecisions || 0,
      href: "/applications?view=interviews",
      icon: CalendarDays,
    },
    {
      title: "Incomplete requirements",
      description: "A few details still to follow up.",
      count: summary?.incompleteRequirements || 0,
      href: "/applications?stage=Requirements",
      icon: CheckCheck,
    },
    {
      title: "Waiting for a response",
      description: "2+ days · review before taking action.",
      count: summary?.noResponseAwaiting || 0,
      href: "/applications?status=No%20Response",
      icon: Clock3,
    },
  ];
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">RECRUITMENT WORKSPACE</div>
          <h1>
            Good {hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening"},{" "}
            {greetingName(state.currentUser?.name)}{" "}
            <Sun className="sun" size={24} aria-hidden="true" />
          </h1>
          <p>Here&apos;s what&apos;s happening with recruitment today.</p>
        </div>
        <div className="date-label">
          <CalendarDays size={17} />
          {formatDate(now, state.preferences)}
        </div>
      </div>
      <div className="section-heading">
        <h2>Recruitment at a glance</h2>
        <span className="muted">
          {now.toLocaleDateString("en-US", {
            timeZone: timezone,
            month: "long",
            year: "numeric",
          })}
        </span>
      </div>
      <div className="metrics-grid">
        {metrics.map(([label, value, Icon, note, status], i) => (
          <MetricCard
            key={label}
            label={label}
            value={value}
            note={note}
            icon={<Icon size={20} />}
            href={`/applications?${status === "interviews" ? "view=interviews" : `status=${encodeURIComponent(status)}`}&month=current`}
            tone={
              [
                "featured",
                "metric-new",
                "metric-review",
                "metric-approved",
                "metric-interviews",
                "hired",
                "metric-rejected",
                "metric-withdrawn",
              ][i]
            }
          />
        ))}
      </div>
      <StageLegend />
      <div className="dashboard-columns">
        <div>
          <Card>
            <div className="card-heading">
              <div>
                <h2>
                  Active hiring needs{" "}
                  <Badge>
                    {
                      state.hiringNeeds.filter((n) => n.status === "Open")
                        .length
                    }
                  </Badge>
                </h2>
                <p>Finding the right people for every branch.</p>
              </div>
              <Link className="text-link" href="/hiring-needs">
                View all <ArrowUpRight size={16} />
              </Link>
            </div>
            <div className="hiring-list">
              {state.hiringNeeds
                .filter((n) => n.status === "Open")
                .map((need) => (
                  <Link
                    href={`/hiring-needs?edit=${need.id}`}
                    key={need.id}
                    className="hiring-row"
                  >
                    <span className="job-icon">
                      <UsersRound size={21} />
                    </span>
                    <div className="job-description">
                      <strong>{need.position}</strong>
                      <span>
                        <MapPin size={12} />
                        {need.location}
                      </span>
                    </div>
                    <div className="hiring-slots">
                      <strong>{need.slots - need.filled} open slots</strong>
                      <span>
                        {
                          summary?.activeByHiringNeed[need.id] || 0
                        }{" "}
                        in pipeline
                      </span>
                    </div>
                    <div className="hiring-progress">
                      <StatusBadge status={`${need.urgency} priority`} />
                      <ProgressBar value={(need.filled / need.slots) * 100} />
                    </div>
                    <ChevronRight size={17} />
                  </Link>
                ))}
            </div>
            <Link href="/hiring-needs?new=1" className="card-bottom-link">
              <Plus size={16} /> Create a hiring need
            </Link>
          </Card>
          <Card className="recent-card">
            <div className="card-heading">
              <div>
                <h2>Recent applications</h2>
                <p>Meet the people who want to join us.</p>
              </div>
              <Link className="text-link" href="/applications">
                View all <ArrowUpRight size={16} />
              </Link>
            </div>
            <div className="recent-list">
              {recentApps.slice(0, 4).map((a) => (
                <Link
                  key={a.id}
                  href={`/applications/${a.id}`}
                  className="recent-row"
                >
                  <Avatar name={a.applicant.name} />
                  <div>
                    <strong>{a.applicant.name}</strong>
                    <span>
                      {a.position} · {a.location}
                    </span>
                  </div>
                  <StatusBadge status={a.status} />
                  <ArrowUpRight size={16} />
                </Link>
              ))}
            </div>
          </Card>
        </div>
        <div>
          {state.currentUser?.role === "Admin" && retention && (
            <Card className="retention-card">
              <div className="card-heading">
                <div>
                  <h2>
                    <Database size={18} /> System Retention
                  </h2>
                  <p>
                    {retention.dryRun
                      ? "Dry run · no records are permanently deleted"
                      : "Scheduled cleanup is active"}
                  </p>
                </div>
                {retention.storagePercent !== null && (
                  <Badge
                    tone={
                      retention.storageLevel === "critical"
                        ? "red"
                        : retention.storageLevel === "healthy"
                          ? "green"
                          : "orange"
                    }
                  >
                    Storage {retention.storagePercent}%
                  </Badge>
                )}
              </div>
              <div className="retention-summary">
                <span>
                  <strong>{retention.queue.retentionPending}</strong>{" "}
                  applications outside live queue
                </span>
                <span>
                  <strong>{retention.talentPoolExpiring}</strong> Talent Pool
                  records expiring soon
                </span>
                <span>
                  <strong>
                    {retention.hiringNeedsExpiring +
                      retention.expiredHiringNeedsPending}
                  </strong>{" "}
                  Hiring Needs due or in grace
                </span>
                <span>
                  <strong>{retention.activityRecordsPending}</strong> activity
                  records due for cleanup
                </span>
              </div>
              <p className="fine-print">
                Live queue: {retention.queue.active + retention.queue.queued} ·
                active HR view: {retention.queue.active}
              </p>
              <div className="retention-metrics">
                <strong>Cleanup totals this month</strong>
                {retention.metrics
                  .filter(
                    (item) =>
                      item.month === new Date().toISOString().slice(0, 7),
                  )
                  .map((item) => (
                    <span key={item.metric}>
                      {item.metric.replaceAll("_", " ")}: {item.count}
                    </span>
                  ))}
                {!retention.metrics.some(
                  (item) => item.month === new Date().toISOString().slice(0, 7),
                ) && <span>No cleanup actions recorded this month.</span>}
              </div>
            </Card>
          )}
          <Card className="attention-card">
            <div className="card-heading">
              <div>
                <h2>
                  <TriangleAlert size={18} aria-hidden="true" /> Needs your
                  attention
                </h2>
                <p>Follow-ups and outstanding requirements.</p>
              </div>
              <Badge tone="orange">
                {attention.reduce((total, item) => total + item.count, 0)}{" "}
                actions
              </Badge>
            </div>
            {attention
              .filter((item) => item.count > 0)
              .map(({ title, description, count, href, icon: Icon }) => (
                <Link href={href} className="attention-row" key={title}>
                  <span className="attention-icon">
                    <Icon size={18} />
                  </span>
                  <div>
                    <strong>{title}</strong>
                    <small>{description}</small>
                  </div>
                  <span className="attention-count">{count}</span>
                </Link>
              ))}
            {!attention.some((item) => item.count > 0) && (
              <div className="padded">
                <p>
                  You’re all caught up. New items will appear as recruitment
                  progresses.
                </p>
              </div>
            )}
            <Link className="attention-foot" href="/hiring-needs">
              {
                state.hiringNeeds.filter(
                  (n) =>
                    ["High", "Urgent"].includes(n.urgency) &&
                    n.filled < n.slots &&
                    n.status === "Open",
                ).length
              }{" "}
              urgent hiring needs remain underfilled <ArrowRight size={15} />
            </Link>
          </Card>
          <Card className="interview-card">
            <div className="card-heading">
              <div>
                <h2>Upcoming interviews</h2>
                <p>A chance to get to know someone.</p>
              </div>
              <CalendarDays size={19} />
            </div>
            {upcoming.length ? (
              upcoming.map((interview) => (
                <Link
                  key={interview.id}
                  className="interview-row"
                  href={`/applications/${interview.applicationId}`}
                >
                  <div className="calendar-tile">
                    <span>
                      {new Date(interview.scheduledAt).toLocaleDateString("en-US", {
                        timeZone: timezone,
                        month: "long",
                      })}
                    </span>
                    <strong>
                      {new Date(interview.scheduledAt).toLocaleDateString("en-US", {
                        timeZone: timezone,
                        day: "numeric",
                      })}
                    </strong>
                  </div>
                  <div>
                    <strong>{interview.applicantName}</strong>
                    <span>
                      {interview.stage} · {interview.position}
                    </span>
                    <small>
                      {formatTime(interview.scheduledAt, state.preferences)}
                    </small>
                  </div>
                  <ChevronRight size={15} />
                </Link>
              ))
            ) : (
              <EmptyState title="No upcoming interviews" />
            )}
          </Card>
          <div className="daily-note">
            <span>THE DAILY REMINDER</span>
            <p>
              Every great team starts
              <br />
              with a conversation.
            </p>
            <span className="note-line" />
          </div>
        </div>
      </div>
    </>
  );
}
