/* One place that talks to Gemini's generateContent, shared by OCR and chat:
   the key goes in a header (never the URL), and every failure becomes a
   status and a message a salesperson can act on. */

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";

export interface GeminiDeps {
  apiKey?: string;
  model?: string;
  fetchFn?: typeof fetch;
  /** Give up after this long, so the caller can answer with a message instead of Cloudflare's error page. */
  timeoutMs?: number;
}

/** How long a request may take. Cloudflare drops the connection (an HTML error page) at ~100 s. */
export const GEMINI_TIMEOUT_MS = 80_000;

export type GeminiResult =
  | { ok: true; text: string; finishReason?: string }
  | { ok: false; status: number; error: string };

/** Google's own reason for a failed call, trimmed to one short line. The key never appears in it, but it is scrubbed anyway. */
async function googleReason(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  let message = text;
  try {
    const m = (JSON.parse(text) as { error?: { message?: unknown } }).error?.message;
    message = typeof m === "string" ? m : ""; // valid JSON without a message: nothing worth showing
  } catch {
    // not JSON: use the text as it is
  }
  return message.replace(/AIza[\w-]{20,}/g, "[kunci]").replace(/\s+/g, " ").trim().slice(0, 200);
}

/** What a salesperson (or whoever looks after the server) can act on. Google answers 400, not 401, for a bad or expired key. */
export function describeFailure(what: string, status: number, detail: string): string {
  if (status === 400 && /API key (not valid|expired)|API_KEY_INVALID/i.test(detail))
    return "Kunci Gemini ditolak atau sudah kedaluwarsa. Periksa GEMINI_API_KEY di server.";
  if (status === 404) return "Model Gemini tidak ditemukan. Periksa GEMINI_MODEL di server.";
  if (status >= 500) return `Layanan ${what} sedang bermasalah di sisi Google (${status}). Coba lagi nanti.`;
  return detail
    ? `Layanan ${what} menolak permintaan (${status}): ${detail}`
    : `Layanan ${what} mengembalikan error ${status}.`;
}

/** @param body the request JSON, already serialised (OCR builds it by hand around a large base64 string) */
export async function geminiGenerate(body: string, deps: GeminiDeps, what: string): Promise<GeminiResult> {
  const model = (deps.model || DEFAULT_GEMINI_MODEL).replace(/[^\w.-]/g, "");
  let res: Response;
  try {
    res = await (deps.fetchFn ?? fetch)(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": deps.apiKey ?? "" },
      body,
      signal: AbortSignal.timeout(deps.timeoutMs ?? GEMINI_TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
      return { ok: false, status: 504, error: `Layanan ${what} terlalu lama menjawab. Coba lagi, atau pakai file yang lebih kecil.` };
    }
    return { ok: false, status: 503, error: `Tidak bisa menghubungi layanan ${what}. Coba lagi sebentar lagi.` };
  }
  if (res.status === 429) return { ok: false, status: 429, error: `Layanan ${what} sedang kena batas pemakaian. Coba lagi sebentar lagi.` };
  if (res.status === 401 || res.status === 403) return { ok: false, status: 502, error: "Kunci Gemini ditolak. Periksa GEMINI_API_KEY di server." };
  if (!res.ok) {
    const detail = await googleReason(res);
    console.error(`[gemini] ${what} ${res.status}: ${detail || "(tanpa pesan)"}`);
    return { ok: false, status: 502, error: describeFailure(what, res.status, detail) };
  }
  try {
    const payload = (await res.json()) as {
      candidates?: { finishReason?: string; content?: { parts?: { text?: string }[] } }[];
    };
    const c = payload.candidates?.[0];
    return { ok: true, text: c?.content?.parts?.map((p) => p.text ?? "").join("") ?? "", finishReason: c?.finishReason };
  } catch {
    return { ok: false, status: 502, error: `Jawaban ${what} tidak terbaca.` };
  }
}
