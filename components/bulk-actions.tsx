"use client";
import type { ReactNode } from "react";
import { Button } from "./ui";

/** Every list selects its complete filtered set, independent of pagination. */
export function BulkActions({
  count,
  total,
  allSelected,
  onSelectAll,
  onClear,
  busy,
  children,
}: {
  count: number;
  total: number;
  allSelected: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  busy?: boolean;
  children?: ReactNode;
}) {
  if (!count) return null;
  return (
    <div
      className="bulk-action-toolbar"
      aria-label="Bulk actions"
      aria-busy={busy}
    >
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={allSelected && total > 0}
          disabled={busy || !total}
          onChange={onSelectAll}
        />{" "}
        Select all {total} filtered results
      </label>
      <strong role="status">{count} selected</strong>
      {count > 0 && (
        <>
          <Button variant="ghost" disabled={busy} onClick={onClear}>
            Clear selection
          </Button>
          {children}
        </>
      )}
    </div>
  );
}
