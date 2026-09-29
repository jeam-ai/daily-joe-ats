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
  PackageCheck,
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
import { applicantDisplayName } from "@/lib/applicant-information";
import type { Application } from "@/types";
import type { GmailThreadActivity } from "@/lib/gmail-activity";
import { activityLabel } from "@/lib/gmail-activity";
type RetentionSnapshot = {
  dryRun: boolean;
  queue: {
    active: number;
    queued: number;
    retentionPending: number;
    retentionAwaitingMarker: number;
    rejectedOrWithdrawnPending: number;
  };
  talentPoolExpiring: number;
  hiringNeedsExpiring: number;
  expiredHiringNeedsPending: number;
  activityRecordsPending: number;
  storagePercent: number | null;
  storageLevel: string;
  storageBytes: number | null;
  storageLimitBytes: number | null;
  storageCapacityConfigured: boolean;
  metrics: { month: string; metric: string; count: number }[];
};

function formatStorage(bytes: number | null) {
  if (bytes === null) return "Database size unavailable";
  if (bytes < 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
export function Dashboard() {
  const { state, dataset } = useApp();
  const [showAllNeeds, setShowAllNeeds] = useState(false);
  const [retention, setRetention] = useState<RetentionSnapshot | null>(null);
  const [mailActivity, setMailActivity] = useState<GmailThreadActivity[]>([]);
  const [recentConversations, setRecentConversations] = useState<
    Application[] | null
  >(null);
  useEffect(() => {
    if (dataset !== "real") return;
    const abort = new AbortController();
    const load = () =>
      requestJson<{ applications: Application[] }>(
        "/api/applications?tab=All%20applications&sort=activity&limit=4",
        { signal: abort.signal },
      )
        .then((result) => setRecentConversations(result.applications))
        .catch(() => {});
    void load();
    const interval = setInterval(load, 60000);
    return () => {
      abort.abort();
      clearInterval(interval);
    };
  }, [dataset, state?.revision]);
  useEffect(() => {
    if (dataset !== "real") return;
    const abort = new AbortController();
    const load = () =>
      requestJson<{ events: GmailThreadActivity[] }>("/api/gmail-activity", {
        signal: abort.signal,
      })
        .then((result) => setMailActivity(result.events))
        .catch(() => {});
    void load();
    const interval = setInterval(load, 60000);
    return () => {
      abort.abort();
      clearInterval(interval);
    };
  }, [dataset, state?.revision]);
  useEffect(() => {
    if (state?.currentUser?.role !== "Admin") return;
    const abort = new AbortController();
    const load = async () => {
      let snapshot = await requestJson<RetentionSnapshot>(
        "/api/system/retention",
        { signal: abort.signal },
      );
      // Catch up once for records queued before immediate grace markers were
      // introduced. This action only creates/cancels grace dates; it cannot
      // delete applicant data.
      if (snapshot.queue.retentionAwaitingMarker > 0) {
        await requestJson("/api/system/retention", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "sync-queue-grace" }),
          signal: abort.signal,
        });
        snapshot = await requestJson<RetentionSnapshot>(
          "/api/system/retention",
          { signal: abort.signal },
        );
      }
      setRetention(snapshot);
    };
    void load().catch(() => undefined);
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
  const recentApps =
    dataset === "real"
      ? recentConversations || []
      : [...apps].sort((a, b) => b.appliedAt.localeCompare(a.appliedAt));
  const monthly = summary?.currentMonthByStatus || {};
  const metrics = [
    [
      "Applications This Month",
      Object.values(monthly).reduce((sum, count) => sum + (count || 0), 0),
      UsersRound,
      "Received this month",
      "",
    ],
    ["New", monthly.New || 0, Inbox, "Ready for a first look", "New"],
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
    ["Hired", monthly.Hired || 0, UserCheck, "New beginnings", "Hired"],
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
  const openNeeds = state.hiringNeeds.filter((need) => need.status === "Open");
  const stockSummary = ["Uniform", "Welcome Kit", "Other"] as const;
  const issuanceStock = stockSummary
    .map((category) => {
      const items = (state.issuanceInventory || []).filter(
        (item) => item.category === category,
      );
      return {
        category,
        beginning: items.reduce((sum, item) => sum + item.beginning, 0),
        issued: items.reduce((sum, item) => sum + item.issued, 0),
        onHand: items.reduce((sum, item) => sum + item.onHand, 0),
      };
    })
    .filter((summary) => summary.beginning || summary.issued || summary.onHand);
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
    <div className="workspace-page dashboard-page">
      <div className="page-heading workspace-page-heading">
        <div>
          <div className="eyebrow">RECRUITMENT WORKSPACE</div>
          <h1>
            Good {hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening"},{" "}
            {greetingName(state.currentUser?.name)}{" "}
            <Sun className="sun" size={24} aria-hidden="true" />
          </h1>
          <p>Here&apos;s what&apos;s happening with recruitment today.</p>
        </div>
        <div className="workspace-heading-context date-label">
          <CalendarDays size={17} />
          {formatDate(now, state.preferences)}
        </div>
      </div>
      <p className="workspace-heading-note">
        Your live recruitment overview — start with the work that needs HR
        attention today.
      </p>
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
                  Active hiring needs <Badge>{openNeeds.length}</Badge>
                </h2>
                <p>Finding the right people for every branch.</p>
              </div>
              <Link className="text-link" href="/hiring-needs">
                View all <ArrowUpRight size={16} />
              </Link>
            </div>
            <div className="hiring-list">
              {(showAllNeeds ? openNeeds : openNeeds.slice(0, 5)).map(
                (need) => (
                  <Link
                    href={`/hiring-needs?edit=${need.id}`}
                    prefetch={false}
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
                        {summary?.activeByHiringNeed[need.id] || 0} in pipeline
                      </span>
                    </div>
                    <div className="hiring-progress">
                      <StatusBadge status={`${need.urgency} priority`} />
                      <ProgressBar value={(need.filled / need.slots) * 100} />
                    </div>
                    <ChevronRight size={17} />
                  </Link>
                ),
              )}
            </div>
            {openNeeds.length > 5 && (
              <button
                type="button"
                className="card-bottom-link"
                aria-expanded={showAllNeeds}
                onClick={() => setShowAllNeeds((current) => !current)}
              >
                {showAllNeeds
                  ? "Show fewer hiring needs"
                  : `Show all ${openNeeds.length} hiring needs`}
              </button>
            )}
            <Link href="/hiring-needs?new=1" className="card-bottom-link">
              <Plus size={16} /> Create a hiring need
            </Link>
          </Card>
          <Card className="recent-card">
            <div className="card-heading">
              <div>
                <h2>Recent applicant conversations</h2>
                <p>Latest Gmail reply or application received first.</p>
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
                  prefetch={false}
                  className="recent-row"
                >
                  <Avatar name={applicantDisplayName(a)} />
                  <div>
                    <strong>{applicantDisplayName(a)}</strong>
                    <span>
                      {a.position} · {a.location}
                    </span>
                    {a.gmailActivityAt && (
                      <small>
                        Gmail activity{" "}
                        {formatDate(a.gmailActivityAt, state.preferences, true)}
                      </small>
                    )}
                  </div>
                  <StatusBadge status={a.status} />
                  <ArrowUpRight size={16} />
                </Link>
              ))}
              {dataset === "real" && !recentConversations && (
                <p className="padded muted">Loading recent conversations…</p>
              )}
            </div>
          </Card>
          {dataset === "real" && (
            <Card className="recent-card gmail-activity-card">
              <div className="card-heading">
                <div>
                  <h2>Recent Gmail activity</h2>
                  <p>
                    Replies and sent mail in applicant threads. Original
                    submission dates and the 500-item retention queue stay
                    unchanged.
                  </p>
                </div>
              </div>
              {mailActivity.length ? (
                <div className="recent-list">
                  {mailActivity.map((event) => (
                    <Link
                      key={event.messageId}
                      href={`/applications/${event.applicationId}`}
                      prefetch={false}
                      className="recent-row"
                    >
                      <span className="mail-activity-icon">
                        <Inbox size={16} />
                      </span>
                      <div>
                        <strong>{event.applicantName}</strong>
                        <span>
                          {activityLabel(event.direction)} ·{" "}
                          {formatDate(
                            event.occurredAt,
                            state.preferences,
                            true,
                          )}
                        </span>
                      </div>
                      <ArrowUpRight size={16} />
                    </Link>
                  ))}
                </div>
              ) : (
                <p className="padded muted">
                  No recent applicant-thread replies or sent messages have been
                  recorded yet.
                </p>
              )}
            </Card>
          )}
        </div>
        <div>
          {issuanceStock.length > 0 && (
            <Card className="home-stock-card">
              <div className="card-heading">
                <div>
                  <h2>
                    <PackageCheck size={18} /> Employee issuance stock
                  </h2>
                  <p>Current counts from the editable On Hand register.</p>
                </div>
                <Link className="text-link" href="/issuance">
                  Open stock <ArrowUpRight size={16} />
                </Link>
              </div>
              <div className="home-stock-list">
                {issuanceStock.map((stock) => (
                  <div className="home-stock-row" key={stock.category}>
                    <div className="home-stock-item">
                      <strong>{stock.category}</strong>
                      <span>Issuance inventory</span>
                    </div>
                    <div className="home-stock-metrics" aria-label={`${stock.category} stock summary`}>
                      <span>
                        <small>Beginning</small>
                        <b>{stock.beginning}</b>
                      </span>
                      <span>
                        <small>Issued</small>
                        <b>{stock.issued}</b>
                      </span>
                      <span className="home-stock-on-hand">
                        <small>On hand</small>
                        <b>{stock.onHand}</b>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
          {state.currentUser?.role === "Admin" && (
            <Card className="retention-card">
              {retention ? (
                <>
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
                    {retention.storagePercent !== null ? (
                      <Badge
                        tone={
                          retention.storageLevel === "critical"
                            ? "red"
                            : retention.storageLevel === "healthy"
                              ? "green"
                              : "orange"
                        }
                      >
                        Database {retention.storagePercent}%
                      </Badge>
                    ) : (
                      <Badge>
                        Database {formatStorage(retention.storageBytes)}
                      </Badge>
                    )}
                  </div>
                  <div className="retention-summary">
                    <div className="retention-summary-row">
                      <strong>{retention.queue.retentionPending}</strong>
                      <span>Applications outside live queue</span>
                    </div>
                    <div className="retention-summary-row">
                      <strong>{retention.talentPoolExpiring}</strong>
                      <span>Talent Pool records expiring soon</span>
                    </div>
                    <div className="retention-summary-row">
                      <strong>
                        {retention.hiringNeedsExpiring +
                          retention.expiredHiringNeedsPending}
                      </strong>
                      <span>Hiring Needs due or in grace</span>
                    </div>
                    <div className="retention-summary-row">
                      <strong>{retention.activityRecordsPending}</strong>
                      <span>Activity records due for cleanup</span>
                    </div>
                  </div>
                  <p className="fine-print">
                    Live queue:{" "}
                    {retention.queue.active + retention.queue.queued} · active
                    HR view: {retention.queue.active}
                  </p>
                  <p className="fine-print retention-storage-note">
                    Database data: {formatStorage(retention.storageBytes)}
                    {retention.storageCapacityConfigured
                      ? ` of ${formatStorage(retention.storageLimitBytes)} configured Aiven capacity.`
                      : ". Aiven disk capacity is not configured here, so no percentage is shown."}
                  </p>
                  {retention.queue.retentionAwaitingMarker > 0 && (
                    <p className="fine-print">
                      {retention.queue.retentionAwaitingMarker} outside-queue
                      records await the next retention scan before their grace
                      dates are set.
                    </p>
                  )}
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
                      (item) =>
                        item.month === new Date().toISOString().slice(0, 7),
                    ) && <span>No cleanup actions recorded this month.</span>}
                  </div>
                </>
              ) : (
                <div className="retention-loading" role="status">
                  <Database size={18} aria-hidden="true" />
                  <div>
                    <strong>System Retention</strong>
                    <span>Loading retention health…</span>
                  </div>
                </div>
              )}
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
                      {new Date(interview.scheduledAt).toLocaleDateString(
                        "en-US",
                        {
                          timeZone: timezone,
                          month: "long",
                        },
                      )}
                    </span>
                    <strong>
                      {new Date(interview.scheduledAt).toLocaleDateString(
                        "en-US",
                        {
                          timeZone: timezone,
                          day: "numeric",
                        },
                      )}
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
    </div>
  );
}
