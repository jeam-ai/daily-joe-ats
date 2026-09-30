import type {
  IssuanceInventory,
  IssuanceRecord,
  IssuanceStatus,
} from "@/types";

/** A released item is no longer pending; receipt and signature remain separate. */
export function statusAfterReleaseDate(
  status: IssuanceStatus,
  issuedAt?: string,
) {
  const date = issuedAt?.trim() || "";
  const validDate =
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(date)) &&
    new Date(date).toISOString().slice(0, 10) === date;
  return status === "Pending" && validDate ? "Issued" : status;
}

const countedStatuses = new Set<IssuanceRecord["status"]>([
  "Issued",
  "Incomplete",
  "For Replacement",
]);

function comparable(value?: string) {
  return String(value || "")
    .trim()
    .toLocaleLowerCase();
}

/** A release only reduces stock while the asset remains with the employee. */
export function countsAgainstStock(record: IssuanceRecord) {
  return countedStatuses.has(record.status) && !record.returnedAt;
}

/**
 * Inventory rows are item-based. A size-specific stock row only receives
 * releases for that size; a non-sized row intentionally aggregates every size
 * of that item.
 */
export function releasedForStock(
  stock: Pick<IssuanceInventory, "category" | "item" | "size">,
  records: IssuanceRecord[],
) {
  const category = comparable(stock.category);
  const item = comparable(stock.item);
  const size = comparable(stock.size);
  return records.reduce((total, record) => {
    if (
      !countsAgainstStock(record) ||
      comparable(record.category) !== category ||
      comparable(record.item) !== item ||
      (size && comparable(record.size) !== size)
    )
      return total;
    return total + record.quantity;
  }, 0);
}

/**
 * Automatic stock is the default. HR can retain a verified physical-count
 * correction by opting into manualCountOverride for that individual row.
 */
export function reconcileInventory(
  inventory: IssuanceInventory[],
  records: IssuanceRecord[],
) {
  return inventory.map((stock) => {
    if (stock.manualCountOverride) return stock;
    const issued = releasedForStock(stock, records);
    const onHand = Math.max(0, stock.beginning - issued);
    return stock.issued === issued && stock.onHand === onHand
      ? stock
      : { ...stock, issued, onHand };
  });
}
