/* Status badges for Sales Orders (labels from shared/fmsState.ts, docs/integrasi-pe-fms.md bagian 5). */

import {
  FULFILLMENT_LABEL,
  SO_STATUS_LABEL,
  SYNC_LABEL,
  type FulfillmentState,
  type SalesOrderStatus,
  type SyncState,
} from "@shared/fmsState";

const STATUS_TONE: Record<SalesOrderStatus, string> = { open: "blue", cancel_requested: "amber", cancelled: "grey", shipped: "green" };
const FULFILLMENT_TONE: Record<FulfillmentState, string> = {
  queued: "grey",
  packing: "blue",
  on_hold: "amber",
  packed: "blue",
  shipped: "green",
  cancelled: "grey",
};
const SYNC_TONE: Record<SyncState, string> = { pending: "amber", delivered: "green", failed: "red" };

export function SoStatusBadge({ status }: { status: SalesOrderStatus }) {
  return <span className={`status-chip badge ${STATUS_TONE[status]}`}>{SO_STATUS_LABEL[status] ?? status}</span>;
}

/** Where the goods are at the warehouse; "Belum diterima gudang" until FMS reports. */
export function FulfillmentBadge({ state, reason }: { state: FulfillmentState | null; reason?: string | null }) {
  if (!state) return <span className="status-chip badge grey">Belum diterima gudang</span>;
  return (
    <span className={`status-chip badge ${FULFILLMENT_TONE[state]}`} title={state === "on_hold" && reason ? reason : undefined}>
      {FULFILLMENT_LABEL[state]}
      {state === "on_hold" && reason ? `: ${reason}` : ""}
    </span>
  );
}

export function SyncBadge({ state }: { state: SyncState }) {
  return <span className={`status-chip badge ${SYNC_TONE[state]}`}>{SYNC_LABEL[state]}</span>;
}
