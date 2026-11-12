/* ============================================================
   Silvy on Telegram: the Home chat (server/chat.ts) in a Telegram bot.

   POST /api/telegram/webhook   Telegram calls this for every update.

   Who is talking: a Telegram account is tied to an app user once, by the
   user sharing their own contact (Telegram's "request_contact" button). The
   phone Telegram verified must match the Telegram number on an active user
   (or, when they left it empty, their WhatsApp number)
   (Pengaturan in the app). Anyone else gets only the "share your number"
   prompt; nothing reaches Gemini or the catalog without a linked user.

   What they get is what the Home chat gives that user: the same prompt, the
   same per-user throttle, and the same cost gate on catalog lookups
   (runChatSearch). /simpan saves the list as a "Dari list klien" draft and
   replies with its link; prices are still taken in the app, after review.

   Setup (once): `wrangler secret put TELEGRAM_BOT_TOKEN` and
   `TELEGRAM_WEBHOOK_SECRET`, then call setWebhook with url
   <APP_URL>/api/telegram/webhook and secret_token = TELEGRAM_WEBHOOK_SECRET.
   ============================================================ */

import { Hono } from "hono";
import { all, get, run } from "../../db.d1";
import { audit } from "../audit";
import { handleChat } from "../../chat";
import { createDraft } from "../../listDrafts";
import { canSeeCosts } from "../../staffView";
import { runChatSearch, type ChatFound } from "../chatSearch";
import { draftStore } from "./listDrafts";
import { appLink } from "../notify";
import type { RequestLine } from "../../../shared/match";
import type { Role } from "../../../shared/types";
import type { Bindings, Env } from "../env";

const MAX_HISTORY = 20;
const TG_LIMIT = 4000; // Telegram caps a message at 4096 characters.

interface TgMessage {
  chat: { id: number; type: string };
  from?: { id: number; first_name?: string };
  text?: string;
  contact?: { phone_number: string; user_id?: number };
}
export interface TgUpdate {
  message?: TgMessage;
}
type Turn = { role: "user" | "assistant"; content: string; lines?: RequestLine[] };
type Linked = { id: number; name: string; role: Role };

/** "+62 812-3456-789", "0812 3456 789" and "628123456789" are the same number. */
export const normalizePhone = (p: string): string => {
  const d = p.replace(/\D/g, "");
  return d.startsWith("0") ? `62${d.slice(1)}` : d;
};

const rupiah = (n: number) => `Rp${Math.round(n).toLocaleString("id-ID")}`;

export function formatLines(lines: RequestLine[]): string {
  if (!lines.length) return "";
  const rows = lines.map((l, i) => `${i + 1}. ${l.name}${l.qty ? ` — ${l.qty}${l.uom ? ` ${l.uom}` : ""}` : ""}`);
  return `\n\nDaftar saat ini (${lines.length} barang):\n${rows.join("\n")}\n\nKetik /simpan untuk membukanya di app, /baru untuk mulai daftar baru.`;
}

export function formatFound(found: Exclude<ChatFound, { denied: true }>): string {
  if (!found.items.length) return "\n\nTidak ada barang yang cocok di katalog.";
  const rows = found.items.map(
    (r) => `• ${r.code} ${r.name} (${r.uom}) stok ${r.stock}${r.cogs !== undefined ? ` · COGS ${rupiah(r.cogs)}` : ""}${r.problem ? ` ⚠ ${r.problem}` : ""}`,
  );
  const more = found.total > found.items.length ? `\n…dan ${found.total - found.items.length} lainnya. Lihat di app.` : "";
  return `\n\n${rows.join("\n")}${more}`;
}

const clip = (s: string) => (s.length > TG_LIMIT ? `${s.slice(0, TG_LIMIT - 1)}…` : s);

async function send(env: Bindings, chatId: number, text: string, askContact = false): Promise<void> {
  const body: Record<string, unknown> = { chat_id: chatId, text: clip(text) };
  body.reply_markup = askContact
    ? { keyboard: [[{ text: "Bagikan nomor saya", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true }
    : { remove_keyboard: true };
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch((err) => (console.error("[telegram] send error:", err), null));
  if (res && !res.ok) console.error("[telegram] send failed:", res.status, await res.text().catch(() => ""));
}

const ASK_CONTACT =
  "Halo, saya Silvy, asisten quotation Salvator. Tekan tombol \"Bagikan nomor saya\" di bawah supaya saya tahu Anda siapa. " +
  "Nomornya harus sama dengan nomor Telegram di Pengaturan akun Anda di app. Kalau nomor Telegram kosong, pakai nomor WhatsApp.";
const HELP =
  "Ketik kebutuhan klien, misalnya \"untuk PT X: pulpen 10 lusin, kertas A4 5 rim\", atau minta cari barang di katalog.\n" +
  "/simpan simpan daftar sebagai draft di app\n/baru mulai daftar baru";

async function link(env: Bindings, msg: TgMessage, tgId: number): Promise<void> {
  const c = msg.contact!;
  // Telegram fills user_id only when the shared contact is the sender's own.
  if (c.user_id !== tgId) return send(env, msg.chat.id, "Bagikan nomor Anda sendiri lewat tombol di bawah, bukan kontak orang lain.", true);
  const phone = normalizePhone(c.phone_number);
  // The Telegram number when set, else the WhatsApp one.
  const users = await all<Linked & { phone: string }>(
    env.DB,
    "SELECT id, name, role, CASE WHEN telegram_phone != '' THEN telegram_phone ELSE phone END AS phone FROM users WHERE active = 1 AND (telegram_phone != '' OR phone != '')",
  );
  const hit = users.filter((u) => normalizePhone(u.phone) === phone);
  if (hit.length !== 1)
    return send(env, msg.chat.id, "Nomor ini belum terdaftar di akun mana pun. Isi nomor Telegram Anda di Pengaturan app (bagian Telegram), lalu bagikan lagi.", true);
  await run(env.DB, "UPDATE users SET telegram_id = NULL WHERE telegram_id = ?", tgId);
  await run(env.DB, "UPDATE users SET telegram_id = ? WHERE id = ?", tgId, hit[0].id);
  await run(env.DB, "DELETE FROM telegram_chats WHERE telegram_id = ?", tgId);
  await audit(env.DB, hit[0].id, "user", hit[0].id, "telegram_linked", {});
  return send(env, msg.chat.id, `Terhubung sebagai ${hit[0].name}.\n\n${HELP}`);
}

async function history(env: Bindings, tgId: number): Promise<Turn[]> {
  const row = await get<{ messages: string }>(env.DB, "SELECT messages FROM telegram_chats WHERE telegram_id = ?", tgId);
  return row ? (JSON.parse(row.messages) as Turn[]) : [];
}

const saveHistory = (env: Bindings, tgId: number, turns: Turn[]) =>
  run(
    env.DB,
    `INSERT INTO telegram_chats(telegram_id, messages, updated_at) VALUES(?, ?, datetime('now'))
     ON CONFLICT(telegram_id) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at`,
    tgId,
    JSON.stringify(turns),
  );

async function saveDraft(env: Bindings, user: Linked, chatId: number, turns: Turn[]): Promise<void> {
  const last = [...turns].reverse().find((t) => t.role === "assistant" && t.lines?.length);
  if (!last) return send(env, chatId, "Belum ada daftar barang untuk disimpan.");
  // No choices: the app matches every row to the catalog when the draft opens (restoreRows).
  const draft = await createDraft(draftStore(env.DB), user, {
    title: "Dari Telegram",
    client_id: null,
    file_name: "",
    notes: [],
    lines: last.lines!,
    choices: [],
  });
  await audit(env.DB, user.id, "list_draft", draft.id, "draft_saved", { rows: draft.rows, created: true, via: "telegram" });
  await saveHistory(env, chatId, []);
  return send(env, chatId, `Draft tersimpan (${draft.rows} baris). Buka untuk dicocokkan ke katalog dan dibuat quotation:\n${appLink(env, `/?draft=${draft.id}`)}`);
}

/** One Telegram update, end to end. Never throws: a failure is logged and the user told to retry. */
export async function handleUpdate(env: Bindings, update: TgUpdate): Promise<void> {
  const msg = update.message;
  if (!msg?.from || msg.chat.type !== "private") return;
  const tgId = msg.from.id;
  try {
    if (msg.contact) return await link(env, msg, tgId);
    const user = await get<Linked>(env.DB, "SELECT id, name, role FROM users WHERE telegram_id = ? AND active = 1", tgId);
    if (!user) return await send(env, msg.chat.id, ASK_CONTACT, true);
    const text = (msg.text ?? "").trim();
    if (!text) return await send(env, msg.chat.id, "Untuk sekarang saya hanya bisa membaca pesan teks.");
    if (text.startsWith("/start") || text === "/bantuan") return await send(env, msg.chat.id, `Halo ${user.name}.\n\n${HELP}`);
    if (text === "/baru") return await saveHistory(env, tgId, []).then(() => send(env, msg.chat.id, "Oke, mulai daftar baru."));
    if (text === "/simpan") return await saveDraft(env, user, msg.chat.id, await history(env, tgId));

    const { success } = await env.ASSISTANT_LIMITER.limit({ key: `chat:${user.id}` });
    if (!success) return await send(env, msg.chat.id, "Terlalu banyak pesan. Tunggu sebentar.");
    const turns = [...(await history(env, tgId)), { role: "user" as const, content: text.slice(0, 4000) }].slice(-MAX_HISTORY);
    while (turns[0]?.role !== "user") turns.shift();
    const clients = (await all<{ name: string }>(env.DB, "SELECT name FROM clients ORDER BY name LIMIT 200")).map((c) => c.name);
    const costs = canSeeCosts(user.role);
    const out = await handleChat({ messages: turns, clients }, { apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL }, costs);
    if (out.status !== 200 || !("reply" in out.json)) return await send(env, msg.chat.id, "error" in out.json ? out.json.error : "Silvy gagal menjawab. Coba lagi.");
    const { reply, lines, search } = out.json;
    // A search turn keeps the list the model already had (its `lines` stays as before).
    let extra = "";
    if (search) {
      const found = await runChatSearch(env.DB, search, costs);
      extra = "denied" in found ? "\n\nMaaf, pencarian berdasarkan COGS hanya bisa dipakai manajer." : formatFound(found);
    } else extra = formatLines(lines);
    await saveHistory(env, tgId, [...turns, { role: "assistant", content: reply, lines }]);
    return await send(env, msg.chat.id, reply + extra);
  } catch (err) {
    console.error("[telegram] update failed:", err);
    await send(env, msg.chat.id, "Maaf, ada gangguan. Coba lagi sebentar.");
  }
}

export const telegramRouter = new Hono<Env>();

telegramRouter.post("/webhook", async (c) => {
  const secret = c.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || !c.env.TELEGRAM_BOT_TOKEN) return c.json({ error: "Endpoint tidak ditemukan." }, 404);
  if (c.req.header("x-telegram-bot-api-secret-token") !== secret) return c.json({ error: "Tidak diizinkan." }, 401);
  const update = (await c.req.json().catch(() => null)) as TgUpdate | null;
  // Answer Telegram at once (it re-sends an update it waits on too long); Gemini runs after.
  if (update) c.executionCtx.waitUntil(handleUpdate(c.env, update));
  return c.json({ ok: true });
});
