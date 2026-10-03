"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { CircleHelp } from "lucide-react";
import { HelpTip } from "./ui";
import { recordHold } from "@/lib/record-selection";

export function SelectionHelp() {
  return (
    <p className="selection-help">
      To select, use ⋮ → Select, right-click, or press and hold a record.
      <HelpTip
        label="How to select records"
        icon={<CircleHelp size={15} aria-hidden />}
      >
        Checkboxes and Select all appear after your first selection. Select all
        includes every record matching your current filters, across all pages.
        Clear selection or uncheck the last record to exit selection mode.
      </HelpTip>
    </p>
  );
}

/** Delegate gestures so paginated tables and cards share the same selection UX. */
export function SelectionSurface({
  children,
  onSelect,
  disabled = false,
  className,
}: {
  children: ReactNode;
  onSelect: (id: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const select = useRef(onSelect);
  select.current = onSelect;
  const hold = useRef<ReturnType<typeof recordHold> | null>(null);
  if (!hold.current) hold.current = recordHold((id) => select.current(id));
  const gesture = hold.current;
  useEffect(() => () => gesture.abort(), [gesture]);
  useEffect(() => {
    if (disabled) gesture.abort();
  }, [disabled, gesture]);
  const record = (target: EventTarget, container: HTMLElement) => {
    if (disabled || !(target instanceof Element)) return null;
    if (
      target.closest(
        "input, select, textarea, button, summary, [contenteditable=true]",
      )
    )
      return null;
    const row = target.closest<HTMLElement>("[data-record-id]");
    return row && container.contains(row) ? row : null;
  };
  return (
    <div
      className={className}
      data-selection-surface
      onContextMenu={(event) => {
        const row = record(event.target, event.currentTarget);
        const menu =
          row?.querySelector<HTMLButtonElement>("[data-record-menu]");
        if (!menu) return;
        event.preventDefault();
        gesture.cancel();
        if (!gesture.held())
          menu.dispatchEvent(
            new CustomEvent("record-context-menu", {
              detail: { x: event.clientX, y: event.clientY },
            }),
          );
      }}
      onPointerDown={(event) => {
        gesture.abort();
        const row = record(event.target, event.currentTarget);
        if (row && event.button === 0 && event.isPrimary)
          gesture.begin(row.dataset.recordId!, event.clientX, event.clientY);
      }}
      onPointerMove={(event) => gesture.move(event.clientX, event.clientY)}
      onPointerUp={() => gesture.end()}
      onPointerCancel={() => gesture.abort()}
      onPointerLeave={() => gesture.cancel()}
      onClickCapture={(event) => {
        if (gesture.consumeClick()) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      {children}
    </div>
  );
}
