/* Dokumen yang bisa dibuat Silvy. Dipakai agent (prompt) dan app (daftar di panel). */

export const DOCS: Record<string, { title: string; desc: string; prompt: string }> = {
  briefing: {
    title: "Briefing untuk atasan",
    desc: "Ringkasan satu halaman, siap diteruskan",
    prompt:
      "Tulis briefing untuk atasan (maksimal 230 kata): satu paragraf ringkasan, lalu satu bagian per skenario dengan angka kunci, lalu bagian risiko, lalu 2 sampai 3 keputusan yang perlu diambil.",
  },
  faq: {
    title: "FAQ tim sales",
    desc: "Pertanyaan procurement dan jawabannya",
    prompt:
      "Buat 5 tanya jawab yang kemungkinan ditanyakan procurement klien atau tim sales tentang penawaran ini (maksimal 260 kata). Tiap pertanyaan sebagai judul '## ', jawaban 1 sampai 3 kalimat berbasis data.",
  },
  risk: {
    title: "Cek risiko harga",
    desc: "Item dan asumsi yang rawan",
    prompt:
      "Buat daftar risiko harga (maksimal 230 kata): item yang mentok di RRP, item margin tipis atau di bawah modal, ketergantungan subsidi S2 pada volume item profit, COGS estimasi, dan pelanggaran kebijakan. Urutkan dari yang paling berdampak, sebut angka.",
  },
  negotiation: {
    title: "Amunisi negosiasi",
    desc: "Argumen dan batas bawah per item",
    prompt:
      "Buat catatan negosiasi (maksimal 250 kata): 3 argumen nilai yang bisa dipakai sales, item mana yang masih punya ruang turun harga beserta batas bawahnya menurut kebijakan, dan item mana yang tidak boleh diturunkan lagi. Sebut angka.",
  },
};

/**
 * A scenario action names the scenario as shown to people and to the model:
 * 1, 2, 3 for S1, S2, S3 (the editor turns it into the 0-based index). One
 * list for the agent's filter and the editor, which once disagreed (0-2 vs
 * 1-3) and so dropped every switch to S3.
 */
export const SCENARIO_ACTION_VALUES = [1, 2, 3] as const;
export const isScenarioActionValue = (v: unknown): v is (typeof SCENARIO_ACTION_VALUES)[number] =>
  (SCENARIO_ACTION_VALUES as readonly unknown[]).includes(v);
