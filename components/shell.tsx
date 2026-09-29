"use client";
import { IntakeSyncStatus } from "./intake-sync";
import Link from "next/link";
import { canManage } from "@/lib/data-policy";
import { DemoControls } from "./system-settings";
import { usePathname } from "next/navigation";
import { useState, useEffect, useRef } from "react";
import {
  House,
  UsersRound,
  BriefcaseBusiness,
  Bookmark,
  ChartNoAxesCombined,
  Settings,
  Bell,
  Search,
  ChevronDown,
  Menu,
  ShieldCheck,
  ArrowUpRight,
  LogOut,
  Clock3,
  PackageCheck,
  ContactRound,
  PanelLeftClose,
  PanelLeftOpen,
  X,
  Mail,
  type LucideIcon,
} from "lucide-react";
import { AppProvider, useApp } from "./provider";
import { Avatar, Badge, Button } from "./ui";
import Image from "next/image";
import { RouteFeedback } from "./route-feedback";
type NavigationItem = readonly [string, string, LucideIcon];
const navigationGroups: ReadonlyArray<{
  label: string;
  items: ReadonlyArray<NavigationItem>;
}> = [
  { label: "Dashboard", items: [["Home", "/", House]] },
  {
    label: "Recruitment",
    items: [
      ["Applications", "/applications", UsersRound],
      ["Hiring Needs", "/hiring-needs", BriefcaseBusiness],
      ["Talent Pool", "/talent-pool", Bookmark],
    ],
  },
  {
    label: "HR operations",
    items: [
      ["Timekeeping", "/timekeeping", Clock3],
      ["Onboarding", "/people", ContactRound],
      ["Employee Issuance", "/issuance", PackageCheck],
    ],
  },
  { label: "Insights", items: [["Reports", "/reports", ChartNoAxesCombined]] },
  { label: "System", items: [["Settings", "/settings", Settings]] },
] as const;
const navigation = navigationGroups.flatMap((group) => group.items);
function Frame({
  children,
  email,
  name,
  demo,
}: {
  children: React.ReactNode;
  email?: string;
  name?: string;
  demo: boolean;
}) {
  const path = usePathname();
  const { state, dataset } = useApp();
  const [open, setOpen] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    const media = matchMedia("(max-width: 700px)");
    const apply = () => {
      setMobile(media.matches);
      if (!media.matches) setOpen(false);
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem("djc-sidebar-collapsed") === "true");
    } catch {}
  }, []);
  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem("djc-sidebar-collapsed", String(next));
      } catch {}
      return next;
    });
  };
  const sidebar = useRef<HTMLElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const focusable = () =>
      Array.from(
        sidebar.current?.querySelectorAll<HTMLElement>(
          "a[href], button:not([disabled])",
        ) || [],
      ).filter((el) => el.offsetParent !== null);
    focusable()[0]?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        requestAnimationFrame(() => menuButton.current?.focus());
      }
      if (e.key === "Tab") {
        const items = focusable(),
          first = items[0],
          last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);
  const active = navigation.find(([, href]) =>
    href === "/" ? path === "/" : path.startsWith(href),
  );
  return (
    <div className={`app-shell ${state?.preferences.compact ? "compact" : ""}`}>
      {open && (
        <button
          className="mobile-backdrop"
          tabIndex={-1}
          aria-hidden="true"
          aria-label="Close navigation"
          onClick={() => setOpen(false)}
        />
      )}
      <aside
        ref={sidebar}
        inert={mobile && !open}
        aria-hidden={mobile && !open ? true : undefined}
        aria-label="Workspace navigation"
        id="workspace-navigation"
        className={`sidebar ${open ? "mobile-open" : ""} ${collapsed ? "sidebar-collapsed" : ""}`}
      >
        <button
          className="icon-button sidebar-close"
          aria-label="Close navigation"
          onClick={() => {
            setOpen(false);
            requestAnimationFrame(() => menuButton.current?.focus());
          }}
        >
          <X size={20} />
        </button>
        <Link href="/" className="brand" onClick={() => setOpen(false)}>
          <Image
            className="brand-logo"
            src="/daily-joe-logo-blue.png"
            alt="Daily Joe Careers"
            width={170}
            height={74}
            priority
          />
          <span className="brand-careers">CAREERS</span>
        </Link>
        <button
          className="sidebar-collapse-toggle"
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          <span className="sidebar-collapse-label">
            {collapsed ? "Expand" : "Collapse"}
          </span>
        </button>
        <div className="workspace-label">YOUR WORKSPACE</div>
        <nav>
          {navigationGroups.map((group) => (
            <div className="sidebar-nav-group" key={group.label}>
              <span className="sidebar-nav-group-label">{group.label}</span>
              {group.items.map(([label, href, Icon]) => (
                <Link
                  href={href}
                  prefetch={false}
                  key={href}
                  onClick={() => setOpen(false)}
                  title={label}
                  aria-current={active?.[1] === href ? "page" : undefined}
                  className={`sidebar-nav-link ${active?.[1] === href ? "active" : ""}`}
                >
                  <Icon size={19} />
                  <span>{label}</span>
                  {label === "Applications" && (
                    <span
                      className="nav-count"
                      title="Applications in the newest 500-item live queue"
                    >
                      {state
                        ? (state.applicationSummary?.[dataset].liveQueue ?? 0)
                        : "…"}
                    </span>
                  )}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <ShieldCheck size={22} />
            <strong>Daily Joe Careers</strong>
            <p>Recruitment and HR operations.</p>
          </div>
          <Link href="/settings/account" className="sidebar-profile">
            <Avatar
              name={state?.currentUser?.name || name || email || "HR"}
              imageUrl={state?.currentUser?.avatarUrl}
              small
            />
            <span>
              {state?.currentUser?.name || name || email}
              <small>{state?.currentUser?.title}</small>
            </span>
            <ChevronDown size={15} />
          </Link>
        </div>
      </aside>
      <div className="main-shell" inert={open}>
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button menu-toggle"
              ref={menuButton}
              aria-expanded={open}
              aria-controls="workspace-navigation"
              onClick={() => setOpen(!open)}
              aria-label="Toggle navigation"
            >
              <Menu size={21} />
            </button>
            <span>Workspace</span>
            <span>/</span>
            <strong>{active?.[0] || "Notifications"}</strong>
          </div>
          <div className="topbar-actions">
            <form action="/search" className="global-search" title="Search applicants, employees, hiring needs, locations, and issued items">
              <Search size={16} />
              <input
                aria-label="Search HR hub"
                name="q"
                placeholder="Search HR hub…"
              />
              <kbd>↵</kbd>
            </form>
            <Badge tone="blue">
              {dataset === "demo" ? "DEMO" : "LIVE WORKSPACE"} ·{" "}
              {!state ? "…" : (state.applicationSummary?.[dataset].active ?? 0)}{" "}
              / 100 active
            </Badge>
            <Link
              className="icon-button notification-button"
              href="/notifications"
              aria-label="Notifications"
            >
              <Bell size={19} />
              {state?.preferences.notifications !== false &&
                state?.notifications.some((n) => !n.read) && <i />}
            </Link>
            <Link href="/settings/account" aria-label="Your profile">
              <Avatar
                name={state?.currentUser?.name || name || email || "HR"}
                imageUrl={state?.currentUser?.avatarUrl}
                small
              />
            </Link>
          </div>
        </header>
        <RouteFeedback />
        <main id="main-content">
          <DemoControls banner />
          {!path.startsWith("/timekeeping") && <IntakeSyncStatus />}
          {children}
        </main>
        <footer className="workspace-footer">
          <span>DAILY JOE CAREERS</span>
          <span>
            {email
              ? `Signed in as ${state?.currentUser?.name || name || email}`
              : "Authorized recruitment workspace"}
          </span>
          <a href="/api/auth/logout" aria-label="Sign out">
            <LogOut size={14} />
          </a>
        </footer>
      </div>
    </div>
  );
}
export function Shell(props: {
  children: React.ReactNode;
  email?: string;
  name?: string;
  demo: boolean;
}) {
  return (
    <AppProvider email={props.email}>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <Frame {...props} />
    </AppProvider>
  );
}
