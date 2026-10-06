import { Router } from "express";
import { getSetting, setSetting } from "../db.js";
import { audit } from "../audit.js";
import { type AuthedRequest, requireAuth, requirePermission } from "../auth.js";
import { companySchema, excelPasswordSchema, policySchema, zodMessage } from "../validate.js";
import { DEFAULT_POLICY } from "../../shared/policy.js";
import { settingsForViewer } from "../staffView.js";

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

export const DEFAULT_COMPANY = {
  name: "PT Salvator Inti Pratama",
  brand: "PT Salvator Inti Pratama",
  tagline: "Perlengkapan kantor B2B",
  address: "Tiang Bendera 3 No. 52-9, Jakarta Barat, DKI Jakarta",
  phone: "",
  email: "",
  npwp: "",
  bank: "",
  logo: "",
};

settingsRouter.get("/", (req: AuthedRequest, res) => {
  // Staff need the company details for documents, not the pricing policy (PE-1).
  res.json(
    settingsForViewer(req.user!.role, {
      policy: getSetting("policy", DEFAULT_POLICY),
      company: getSetting("company", DEFAULT_COMPANY),
      // PE-2: locks the "Cek harga" Excel a manager builds in the browser.
      excelPassword: getSetting("excel_password", ""),
    }),
  );
});

settingsRouter.put("/policy", requirePermission("manage_policy"), (req: AuthedRequest, res) => {
  const parsed = policySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: zodMessage(parsed.error) });
    return;
  }
  setSetting("policy", parsed.data);
  audit(req.user!.id, "settings", 0, "policy_updated", parsed.data);
  res.json({ policy: parsed.data });
});

settingsRouter.put("/company", requirePermission("manage_company"), (req: AuthedRequest, res) => {
  const parsed = companySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: zodMessage(parsed.error) });
    return;
  }
  setSetting("company", parsed.data);
  audit(req.user!.id, "settings", 0, "company_updated", parsed.data);
  res.json({ company: parsed.data });
});

settingsRouter.put("/excel-password", requirePermission("manage_company"), (req: AuthedRequest, res) => {
  const parsed = excelPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: zodMessage(parsed.error) });
    return;
  }
  setSetting("excel_password", parsed.data.password);
  // The password itself stays out of the audit trail.
  audit(req.user!.id, "settings", 0, "excel_password_updated");
  res.json({ ok: true });
});
