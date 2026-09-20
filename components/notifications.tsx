"use client";
import Link from "next/link";
import { Bell, CheckCheck, ArrowUpRight } from "lucide-react";
import type { Notification } from "@/types";
import { useApp } from "./provider";
import { formatDate } from "@/lib/dates";
import { Button, Card, EmptyState, LoadingSkeleton } from "./ui";
export function NotificationItem({
  item,
  onRead,
}: {
  item: Notification;
  onRead: () => void;
}) {
  const { state } = useApp();
  return (
    <div className={`notification-item ${item.read ? "read" : ""}`}>
      <span className="attention-icon">
        <Bell size={19} />
      </span>
      <Link href={item.href} onClick={onRead}>
        <strong>{item.title}</strong>
        <p>{item.description}</p>
        <small>{formatDate(item.date, state?.preferences, true)}</small>
      </Link>
      {!item.read && (
        <Button
          variant="ghost"
          onClick={onRead}
          aria-label={`Mark ${item.title} as read`}
        >
          <CheckCheck size={18} />
        </Button>
      )}
      <Link
        href={item.href}
        className="icon-button"
        aria-label={`View ${item.title}`}
        onClick={onRead}
      >
        <ArrowUpRight size={18} />
      </Link>
    </div>
  );
}
export function Notifications() {
  const { state, update, saving } = useApp();
  if (!state) return <LoadingSkeleton />;
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">STAY IN THE LOOP</div>
          <h1>Notifications</h1>
          <p>A little nudge for the things that need you.</p>
        </div>
        <Button
          variant="secondary"
          disabled={saving || !state.notifications.some((n) => !n.read)}
          onClick={() =>
            update((s) => ({
              ...s,
              notifications: s.notifications.map((n) =>
                state.notifications.some((v) => v.id === n.id)
                  ? { ...n, read: true }
                  : n,
              ),
            }))
          }
        >
          <CheckCheck size={16} />
          Mark all as read
        </Button>
      </div>
      <Card>
        {state.notifications.length ? (
          [...state.notifications]
            .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
            .map((n) => (
              <NotificationItem
                key={n.id}
                item={n}
                onRead={() =>
                  update((s) => ({
                    ...s,
                    notifications: s.notifications.map((item) =>
                      item.id === n.id ? { ...item, read: true } : item,
                    ),
                  }))
                }
              />
            ))
        ) : (
          <EmptyState
            title="You're all caught up"
            description="No notifications right now."
          />
        )}
      </Card>
    </>
  );
}
