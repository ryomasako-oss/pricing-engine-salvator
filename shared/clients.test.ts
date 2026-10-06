import { describe, expect, it } from "vitest";
import { clientKey, sameClient, similarClients } from "./clients";

describe("clientKey", () => {
  it("ignores case, punctuation, word order and the legal form", () => {
    const k = clientKey("PT Bahtera Adi Jaya");
    expect(clientKey("BAHTERA ADI JAYA PT")).toBe(k);
    expect(clientKey("Bahtera Adi Jaya, PT.")).toBe(k);
    expect(clientKey("pt. bahtera  adi-jaya")).toBe(k);
    expect(clientKey("PT Bahtera Adi Jaya Tbk")).toBe(k);
  });
  it("keeps different companies apart", () => {
    expect(clientKey("PT Bahtera Adi Jaya")).not.toBe(clientKey("PT Bahtera Jaya"));
    expect(clientKey("CV Maju")).not.toBe(clientKey("CV Maju Bersama"));
  });
  it("is empty when only a legal form was typed", () => {
    expect(clientKey("PT")).toBe("");
    expect(clientKey("  ")).toBe("");
  });
});

describe("similarClients", () => {
  const clients = [
    { id: 1, name: "BAHTERA ADI JAYA PT" },
    { id: 2, name: "PT Bahtera Jaya Logistik" },
    { id: 3, name: "PT Agrinesia" },
  ];
  it("puts the same company first, then close names; unrelated ones are left out", () => {
    // The same company first (score 1); a name sharing 2 of 3 words is offered too.
    expect(similarClients("PT Bahtera Adi Jaya", clients).map((x) => x.client.id)).toEqual([1, 2]);
    expect(similarClients("PT Bahtera Adi Jaya", clients)[0].score).toBe(1);
    expect(similarClients("Bahtera Jaya", clients).map((x) => x.client.id)).toEqual([1, 2]);
    expect(similarClients("Agrinesia", clients).map((x) => x.client.id)).toEqual([3]);
    expect(similarClients("Sinar Dunia", clients)).toEqual([]);
  });
  it("returns nothing for an empty or legal-form-only name", () => {
    expect(similarClients("", clients)).toEqual([]);
    expect(similarClients("PT", clients)).toEqual([]);
  });
});

describe("sameClient", () => {
  const saved = [
    { id: 1, name: "PT Bahtera Adi Jaya" },
    { id: 2, name: "PT Bahtera Jaya Logistik" },
  ];
  it("finds the saved copy under another spelling, but not the client being edited", () => {
    expect(sameClient("BAHTERA ADI JAYA, PT.", saved)?.id).toBe(1);
    expect(sameClient("Bahtera Adi Jaya PT", saved, 1)).toBeUndefined();
  });
  it("is undefined for a different company or a name that is only a legal form", () => {
    expect(sameClient("PT Bahtera Jaya", saved)).toBeUndefined();
    expect(sameClient("PT", [{ id: 9, name: "CV" }])).toBeUndefined();
  });
});
