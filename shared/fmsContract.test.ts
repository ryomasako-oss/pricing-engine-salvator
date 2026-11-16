import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { ackSchema, anyEventSchema, FMS_STATES } from "./fmsContract";
import { FULFILLMENT_LABEL, fulfillmentFromFms } from "./fmsState";
import { signHex, verifySignature } from "../server/worker/fms/signing";

/* contract-fixtures/ is shared verbatim with the FMS repo: valid-* must pass,
   invalid-* must fail; *-ack-* files are acks, the rest are events. */
const dir = path.resolve(import.meta.dirname, "../contract-fixtures");
const fixtures = readdirSync(dir).filter((f) => /^(valid|invalid)-.*\.json$/.test(f));
const load = (f: string) => JSON.parse(readFileSync(path.join(dir, f), "utf8"));

describe("contract fixtures", () => {
  it("has valid and invalid examples of every kind", () => {
    for (const p of ["valid-so-created", "invalid-so-created", "valid-so-cancel", "invalid-so-cancel", "valid-outbound", "invalid-outbound", "valid-ack", "invalid-ack"]) {
      expect(fixtures.some((f) => f.startsWith(p)), p).toBe(true);
    }
  });

  for (const f of fixtures) {
    it(`${f} is ${f.startsWith("valid") ? "accepted" : "rejected"}`, () => {
      const schema = f.includes("-ack-") ? ackSchema : anyEventSchema;
      expect(schema.safeParse(load(f)).success).toBe(f.startsWith("valid"));
    });
  }

  it("signature vector: PE signs and verifies the shared example exactly", async () => {
    const v = load("signature-vector.json");
    expect(await signHex(v.secret, `${v.timestamp}.${v.rawBody}`)).toBe(v.signature);
    const at = Number(v.timestamp) * 1000;
    expect(await verifySignature(v.secret, v.timestamp, v.signature, (ts) => `${ts}.${v.rawBody}`, at)).toBe(true);
    expect(await verifySignature(v.secret, v.timestamp, v.signature, (ts) => `${ts}.${v.rawBody} `, at)).toBe(false);
    expect(await verifySignature(v.secret, v.timestamp, v.signature, (ts) => `${ts}.${v.rawBody}`, at + 301_000)).toBe(false);
    expect(await verifySignature(v.secret, undefined, v.signature, (ts) => `${ts}.${v.rawBody}`, at)).toBe(false);
    expect(await verifySignature(v.secret, v.timestamp, "zz", (ts) => `${ts}.${v.rawBody}`, at)).toBe(false);
  });
});

describe("FMS status -> PE fulfillment_state (docs/integrasi-pe-fms.md bagian 5)", () => {
  const table: [string, string, string][] = [
    ["AWAITING_PAYMENT", "queued", "Antre di gudang"],
    ["IMPORTED", "queued", "Antre di gudang"],
    ["READY_TO_PACK", "queued", "Antre di gudang"],
    ["PACKING", "packing", "Sedang dipacking"],
    ["RECHECK", "packing", "Sedang dipacking"],
    ["TUNDA", "on_hold", "Tertahan"],
    ["WAITING_SPV", "on_hold", "Tertahan"],
    ["ACTION_REQUIRED", "on_hold", "Tertahan"],
    ["FULFILLMENT_SPLIT", "on_hold", "Tertahan"],
    ["AWAITING_HANDOVER", "packed", "Siap kirim"],
    ["HANDING_OVER", "packed", "Siap kirim"],
    ["HANDED_OVER", "shipped", "Sudah diserahkan"],
    ["CANCELLED", "cancelled", "Dibatalkan gudang"],
  ];
  it.each(table)("%s -> %s (%s)", (fms, pe, label) => {
    const state = fulfillmentFromFms(fms as (typeof FMS_STATES)[number]);
    expect(state).toBe(pe);
    expect(FULFILLMENT_LABEL[state]).toBe(label);
  });
  it("covers every FMS state", () => {
    expect(table.map((r) => r[0]).sort()).toEqual([...FMS_STATES].sort());
  });
});
