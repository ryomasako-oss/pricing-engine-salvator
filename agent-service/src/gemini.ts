/* ============================================================
   Gemini client — satu-satunya pintu ke LLM untuk Silvy.

   Semua panggilan Gemini lewat sini. Kalau nanti pindah dari Google
   AI Studio ke Vertex AI, hanya endpoint dan autentikasi di berkas
   ini yang berubah.
   ============================================================ */

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** Model default: sudah dites hidup di key Salvator. Ganti lewat GEMINI_MODEL. */
export const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";

export type GeminiRole = "user" | "model";
export interface GeminiMessage {
  role: GeminiRole;
  content: string;
}

export interface GeminiOptions {
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** Paksa keluaran JSON valid (responseMimeType). */
  json?: boolean;
}

/** Galat Gemini dengan pesan yang bisa dibaca orang kantor. */
export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

/**
 * Key dari .env sering membawa tanda kutip, CR, atau komentar di
 * belakangnya. Ambil token pertama saja.
 */
export function cleanApiKey(raw: string | undefined): string {
  return (raw ?? "").replace(/["'\r]/g, "").trim().split(/\s+/)[0] ?? "";
}

export function describeGeminiHttp(status: number, body: string): string {
  if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(body))
    return "Kunci Gemini ditolak. Periksa GEMINI_API_KEY di server.";
  if (status === 401 || status === 403)
    return "Gemini menolak akses. Periksa GEMINI_API_KEY dan pastikan billing project-nya aktif.";
  if (status === 404) return "Model Gemini tidak ditemukan. Periksa GEMINI_MODEL.";
  if (status === 429) return "Silvy sedang kena batas pemakaian Gemini. Coba lagi sebentar lagi.";
  if (status >= 500) return "Layanan Gemini sedang bermasalah. Coba lagi nanti.";
  return `Gemini mengembalikan error ${status}.`;
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
}

export class GeminiClient {
  private readonly apiKey: string;
  readonly model: string;

  constructor(apiKey: string, model?: string) {
    this.apiKey = cleanApiKey(apiKey);
    if (!this.apiKey) throw new Error("GEMINI_API_KEY wajib diisi");
    this.model = (model ?? "").trim() || DEFAULT_GEMINI_MODEL;
  }

  /** Kirim percakapan, kembalikan teks jawaban. */
  async chat(system: string, messages: GeminiMessage[], opts: GeminiOptions = {}): Promise<string> {
    const model = opts.model ?? this.model;
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map((m) => ({ role: m.role, parts: [{ text: m.content }] })),
      generationConfig: {
        temperature: opts.temperature ?? 0.3,
        maxOutputTokens: opts.maxOutputTokens ?? 2000,
        ...(opts.json ? { responseMimeType: "application/json" } : {}),
      },
    };

    let res: Response;
    try {
      res = await fetch(`${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        // Key lewat header, bukan query string, supaya tidak bocor ke log URL.
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify(body),
      });
    } catch {
      throw new GeminiError("Tidak bisa menghubungi Gemini. Periksa koneksi internet server.", 503);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new GeminiError(describeGeminiHttp(res.status, errText), res.status);
    }

    const json = (await res.json()) as GeminiResponse;
    const parts = json.candidates?.[0]?.content?.parts;
    if (!parts?.length) {
      const reason = json.promptFeedback?.blockReason ?? json.candidates?.[0]?.finishReason ?? "unknown";
      throw new GeminiError(`Gemini tidak mengembalikan jawaban (${reason}).`, 502);
    }
    return parts
      .filter((p) => !p.thought)
      .map((p) => p.text ?? "")
      .join("")
      .trim();
  }
}

/**
 * Ambil objek JSON dari keluaran model. Model kadang membungkusnya
 * dengan code fence atau prosa; coba parse langsung, lalu potong
 * dari kurung kurawal pertama sampai terakhir.
 */
export function extractJSON(raw: string): Record<string, unknown> | null {
  const cleaned = String(raw || "").replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    /* coba potong */
  }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}
