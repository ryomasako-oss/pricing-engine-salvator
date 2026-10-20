import { describe, expect, it } from "vitest";
import { clientKey, missingNewClientFields, missingNewClientMessage, sameClient, similarClients } from "./clients";

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

describe("missingNewClientFields", () => {
  const complete = {
    name: "PT Bahtera Adi Jaya",
    contact_name: "Dinda",
    contact_phone: "081234567890",
    contact_email: "dinda@bahtera.co.id",
  };

  it("is empty once name, PIC, phone and email are filled", () => {
    expect(missingNewClientFields(complete)).toEqual([]);
  });

  it("names the fields still empty, in form order", () => {
    expect(missingNewClientFields({})).toEqual(["name", "contact_name", "contact_phone", "contact_email"]);
    expect(missingNewClientFields({ name: "PT X" })).toEqual(["contact_name", "contact_phone", "contact_email"]);
    expect(missingNewClientFields({ ...complete, contact_phone: "" })).toEqual(["contact_phone"]);
  });

  it("treats whitespace as empty, so a space does not pass for a phone number", () => {
    expect(missingNewClientFields({ ...complete, contact_phone: "   " })).toEqual(["contact_phone"]);
    expect(missingNewClientFields({ ...complete, contact_email: "\t" })).toEqual(["contact_email"]);
  });

  it("does not ask for code, address, payment or delivery terms", () => {
    // Nothing beyond the four is required, and leaving them out is not reported.
    expect(missingNewClientFields({ ...complete })).toEqual([]);
  });
});

describe("missingNewClientMessage", () => {
  it("reads as a plain Indonesian list", () => {
    expect(missingNewClientMessage(["contact_phone"])).toBe("No. HP");
    expect(missingNewClientMessage(["contact_phone", "contact_email"])).toBe("No. HP dan Email");
    expect(missingNewClientMessage(["name", "contact_name", "contact_phone", "contact_email"])).toBe(
      "Nama perusahaan, Nama PIC, No. HP dan Email",
    );
    expect(missingNewClientMessage([])).toBe("");
  });
});
