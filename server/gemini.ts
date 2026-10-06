/* One place that talks to Gemini's generateContent, shared by OCR and chat:
   the key goes in a header (never the URL), and every failure becomes a
   status and a message a salesperson can act on. */

export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";

export interface GeminiDeps {
  apiKey?: string;
  model?: string;
  fetchFn?: typeof fetch;
}

export type GeminiResult = { ok: true; text: string } | { ok: false; status: number; error: string };

/** @param body the request JSON, already serialised (OCR builds it by hand around a large base64 string) */
export async function geminiGenerate(body: string, deps: GeminiDeps, what: string): Promise<GeminiResult> {
  const model = (deps.model || DEFAULT_GEMINI_MODEL).replace(/[^\w.-]/g, "");
  let res: Response;
  try {
    res = await (deps.fetchFn ?? fetch)(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": deps.apiKey ?? "" },
      body,
    });
  } catch {
    return { ok: false, status: 503, error: `Tidak bisa menghubungi layanan ${what}. Coba lagi sebentar lagi.` };
  }
  if (res.status === 429) return { ok: false, status: 429, error: `Layanan ${what} sedang kena batas pemakaian. Coba lagi sebentar lagi.` };
  if (res.status === 401 || res.status === 403) return { ok: false, status: 502, error: "Kunci Gemini ditolak. Periksa GEMINI_API_KEY di server." };
  if (!res.ok) return { ok: false, status: 502, error: `Layanan ${what} mengembalikan error ${res.status}.` };
  try {
    const payload = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    return { ok: true, text: payload.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "" };
  } catch {
    return { ok: false, status: 502, error: `Jawaban ${what} tidak terbaca.` };
  }
}
