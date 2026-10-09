/* ============================================================
   Silvy: /silvy/ask dan /silvy/document.

   Pure functions (tanpa HTTP) supaya bisa dites. Aplikasi pricing
   adalah gerbangnya: ia yang mengautentikasi user, menolak role
   staff (data berisi COGS), membatasi laju, mencatat audit, dan
   mengirim kebijakan harga yang berlaku. Agent hanya memvalidasi
   bentuk permintaan dan merakit jawaban.
   ============================================================ */

import { timingSafeEqual, createHash } from "node:crypto";
import { GeminiError, extractJSON, type GeminiMessage, type GeminiOptions } from "../gemini.js";
import { DOCS, buildContext, chatSystem, docSystem } from "./context.js";
import type { PricingPolicy, QuoteSnapshot, ScenarioIndex } from "../../../shared/types.js";

export interface Llm {
  chat(system: string, messages: GeminiMessage[], opts?: GeminiOptions): Promise<string>;
}

export interface Result {
  status: number;
  body: Record<string, unknown>;
}

const fail = (status: number, error: string): Result => ({ status, body: { error } });

/** Bandingkan rahasia bersama tanpa membocorkan panjang atau isi lewat waktu. */
export function secretMatches(provided: string | undefined, expected: string): boolean {
  if (!expected || !provided) return false;
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(provided), h(expected));
}

/**
 * Pagar untuk server HTTP agent. Begitu SILVY_SHARED_SECRET diisi, semua rute
 * selain /health butuh rahasia itu, jadi /sync, /recommend dan /status tidak
 * terbuka ke internet saat agent dijalankan sebagai layanan publik. Tanpa
 * secret (pemakaian lokal) perilaku lama tetap: rute lama terbuka, /silvy/* mati.
 */
export function authorize(path: string, provided: string | undefined, secret: string): "ok" | "unauthorized" {
  if (path === "/health") return "ok";
  if (!secret) return path.startsWith("/silvy/") ? "unauthorized" : "ok";
  return secretMatches(provided, secret) ? "ok" : "unauthorized";
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number, fallback = ""): string => (typeof v === "string" ? v.slice(0, max) : fallback);

interface Parsed {
  quote: QuoteSnapshot & { scenario: ScenarioIndex; number: string; title: string; status: string };
  policy: PricingPolicy;
  clientName: string;
  notes: { id: string; title: string; text: string }[];
  sections: Record<string, boolean>;
}

function parseContext(body: Record<string, unknown>): Parsed | string {
  const c = body.context;
  if (!isObj(c) || !isObj(c.snapshot)) return "Konteks quotation tidak ada.";
  const s = c.snapshot;
  if (!isObj(s.assumptions) || !Array.isArray(s.items) || !Array.isArray(s.regions))
    return "Snapshot quotation tidak lengkap.";
  if (s.items.length > 2000) return "Terlalu banyak item.";
  if (!isObj(body.policy)) return "Kebijakan harga tidak dikirim.";
  const scenario = ([0, 1, 2] as const).find((n) => n === s.scenario);
  if (scenario === undefined) return "Skenario tidak valid.";

  const sections: Record<string, boolean> = {};
  if (isObj(c.sections)) for (const [k, v] of Object.entries(c.sections)) if (typeof v === "boolean") sections[k.slice(0, 64)] = v;

  const notes = (Array.isArray(c.notes) ? c.notes : [])
    .filter(isObj)
    .slice(0, 20)
    .map((n) => ({ id: str(n.id, 64), title: str(n.title, 200), text: str(n.text, 20000) }));

  return {
    quote: {
      ...(s as unknown as QuoteSnapshot),
      scenario,
      number: str(c.number, 64),
      title: str(c.title, 200),
      status: str(c.status, 32, "draft"),
    },
    policy: body.policy as unknown as PricingPolicy,
    clientName: str(c.clientName, 200, "Klien"),
    notes,
    sections,
  };
}

function contextOrError(body: Record<string, unknown>): { ctx: string } | Result {
  const p = parseContext(body);
  if (typeof p === "string") return fail(400, p);
  try {
    return { ctx: buildContext({ quote: p.quote, policy: p.policy, clientName: p.clientName, notes: p.notes, sections: p.sections }) };
  } catch {
    return fail(400, "Data quotation tidak bisa dihitung.");
  }
}

function llmError(err: unknown): Result {
  if (err instanceof GeminiError) return fail(err.status === 429 ? 429 : err.status === 503 ? 503 : 502, err.message);
  return fail(500, "Silvy gagal menjawab karena kesalahan tak terduga.");
}

const SET_RATE_KEYS = new Set(["opex", "targetMargin", "leaderMargin", "profitDiscount", "rrpDiscount", "marginFloor", "ppn"]);
const SET_INT_KEYS = new Set(["step", "months"]);
const ITEM_FIELDS = new Set(["qty", "cogs", "rrp", "role"]);
const ROLES = new Set(["LEADER", "CORE", "PROFIT"]);

/**
 * Model yang menentukan usulan aksi, jadi usulan disaring ke daftar
 * yang dikenal. Aksi yang bentuknya meleset dibuang, bukan diteruskan.
 */
export function sanitizeActions(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  const out: Record<string, unknown>[] = [];
  for (const a of raw.slice(0, 50)) {
    if (out.length >= 10) break;
    if (!isObj(a)) continue;
    const num = typeof a.value === "number" && Number.isFinite(a.value);
    if (a.type === "set" && typeof a.key === "string") {
      if (SET_RATE_KEYS.has(a.key) && num && (a.value as number) >= 0 && (a.value as number) <= 1) out.push({ type: "set", key: a.key, value: a.value });
      else if (SET_INT_KEYS.has(a.key) && num && Number.isInteger(a.value) && (a.value as number) > 0) out.push({ type: "set", key: a.key, value: a.value });
      else if (a.key === "includeLogistics" && typeof a.value === "boolean") out.push({ type: "set", key: a.key, value: a.value });
    } else if (a.type === "item" && Number.isInteger(a.no) && typeof a.field === "string" && ITEM_FIELDS.has(a.field)) {
      if (a.field === "role" ? typeof a.value === "string" && ROLES.has(a.value) : num && (a.value as number) >= 0)
        out.push({ type: "item", no: a.no, field: a.field, value: a.value });
    } else if (a.type === "scenario" && (a.value === 0 || a.value === 1 || a.value === 2)) {
      out.push({ type: "scenario", value: a.value });
    }
  }
  return out;
}

export async function silvyAsk(llm: Llm, body: unknown): Promise<Result> {
  if (!isObj(body)) return fail(400, "Permintaan tidak valid.");
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length < 1 || messages.length > 20) return fail(400, "Jumlah pesan harus 1 sampai 20.");
  const turns: GeminiMessage[] = [];
  for (const m of messages) {
    if (!isObj(m) || (m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string" || m.content.length > 8000)
      return fail(400, "Format pesan tidak valid.");
    turns.push({ role: m.role === "assistant" ? "model" : "user", content: m.content });
  }
  if (turns[turns.length - 1].role !== "user") return fail(400, "Pesan terakhir harus dari user.");

  const built = contextOrError(body);
  if ("status" in built) return built;
  try {
    // JSON dipaksa lewat responseMimeType; 2000 token cukup untuk jawaban ~160 kata + aksi.
    const raw = await llm.chat(chatSystem(built.ctx), turns, { json: true, maxOutputTokens: 2000 });
    const json = extractJSON(raw) ?? { answer: raw };
    return {
      status: 200,
      body: {
        answer: String(json.answer ?? raw),
        sources: Array.isArray(json.sources) ? json.sources.filter((s) => typeof s === "string").slice(0, 10) : [],
        actions: sanitizeActions(json.actions),
        followups: Array.isArray(json.followups) ? json.followups.filter((s) => typeof s === "string").slice(0, 3) : [],
      },
    };
  } catch (err) {
    return llmError(err);
  }
}

export async function silvyDocument(llm: Llm, body: unknown): Promise<Result> {
  if (!isObj(body)) return fail(400, "Permintaan tidak valid.");
  const kind = body.kind;
  if (typeof kind !== "string" || !Object.hasOwn(DOCS, kind)) return fail(400, "Jenis dokumen tidak dikenal.");
  const built = contextOrError(body);
  if ("status" in built) return built;
  try {
    const content = await llm.chat(docSystem(built.ctx), [{ role: "user", content: DOCS[kind].prompt }], { maxOutputTokens: 4000 });
    return { status: 200, body: { content } };
  } catch (err) {
    return llmError(err);
  }
}
