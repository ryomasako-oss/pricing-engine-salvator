/* Riwayat Audit as Excel: every row matching the filter, in plain words plus the raw detail. */

import * as XLSX from "xlsx";
import { auditActionLabel, auditDetailText, auditEntityLabel } from "@shared/auditLog";
import { fmtDateTime } from "@shared/format";
import type { AuditEntry } from "@shared/types";

export function auditSheet(rows: AuditEntry[]): XLSX.WorkBook {
  const sheet = XLSX.utils.json_to_sheet(
    rows.map((r) => ({
      Waktu: fmtDateTime(r.created_at),
      Oleh: r.actor_name,
      Data: auditEntityLabel(r.entity),
      "ID Data": r.entity_id,
      Aksi: auditActionLabel(r.action),
      Keterangan: auditDetailText(r.detail, 2000),
      "Detail asli": r.detail,
    })),
  );
  sheet["!cols"] = [{ wch: 20 }, { wch: 20 }, { wch: 16 }, { wch: 8 }, { wch: 24 }, { wch: 80 }, { wch: 60 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Riwayat audit");
  return wb;
}

export function exportAudit(rows: AuditEntry[], from: string, to: string): void {
  XLSX.writeFile(auditSheet(rows), `riwayat-audit-${from}-sd-${to}.xlsx`);
}
