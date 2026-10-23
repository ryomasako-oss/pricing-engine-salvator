/* Pencocokan (top menu, /pencocokan): the workbench, open on arrival.

   Everything is the real app on the real Worker (wrangler dev) and a throwaway
   database (e2e/serve.ts), /api/familiarity/* included. The bodies the screen
   sends are read off the wire and checked against the route's contract
   (src/familiarityApi.ts). Rules persist in that database across tests, so a
   test that needs a clean slate makes its own client. */

import type { Page } from "@playwright/test";
import { THEMES, csvFile, expect, expectReadable, expectTheme, test } from "./helpers";

/**
 * What the real matcher makes of each line against the e2e catalog (e2e/serve.ts).
 * The barang baru differs per theme run: once requested, a barang baru is a
 * candidate for every later list, so the second run would find the first's.
 */
const NEW_ITEM: Record<string, string> = { light: "Tisu gulung nice", dark: "Sabun cuci piring sunlight" };
const listFor = (theme: string) => [
  "Kertas HVS Sinar Dunia A4 70gr", // Pasti: K-SD70
  "Lakban bening", // Pasti: LKB-48
  NEW_ITEM[theme], // Adjustment: nothing like it
  NEW_ITEM[theme].toUpperCase(), // its twin: same wording once normalized
  "NO. ITEM DESCRIPTION", // Adjustment: a header row
  "Gunting kecil biru", // Perlu dicek: GNT-KC 63%
  "Spidol snowman hitam", // Pasti (Cocok): SP-HTM
  "Kertas sidu", // Adjustment, with weak candidates (GNT-KC, K-SD70, K-BD70)
];
const PASTE = listFor("light").join("\n");

function familiarityCalls(page: Page) {
  const calls = { feed: [] as Record<string, unknown>[], resolve: [] as Record<string, unknown>[] };
  page.on("request", (r) => {
    if (r.url().endsWith("/api/familiarity/feed")) calls.feed.push(r.postDataJSON());
    else if (/\/api\/familiarity\/sessions\/\d+\/resolve$/.test(r.url())) calls.resolve.push(r.postDataJSON());
  });
  return calls;
}

/** A client of the test's own, so rules other tests stored do not answer for it. */
async function newClient(page: Page, name: string): Promise<number> {
  const res = await page.request.post("/api/clients", { data: { name: `${name} ${Date.now()}` } });
  expect(res.ok(), await res.text()).toBe(true);
  const body = await res.json();
  return (body.client ?? body).id;
}

async function itemId(page: Page, code: string): Promise<string> {
  const res = await page.request.get(`/api/catalog?q=${encodeURIComponent(code)}`);
  const item = (await res.json()).items.find((i: { code: string }) => i.code === code);
  return String(item.id);
}

async function openWorkbench(page: Page) {
  return page.getByRole("region", { name: "Latih Pencocokan" });
}

const badge = (wb: ReturnType<Page["getByRole"]>, word: string) => wb.locator(".badge", { hasText: new RegExp(`^\\d+ ${word}$`) });

for (const theme of THEMES) {
  test.describe(theme, () => {
    test.use({ theme });

    test("a client's list is trained row by row, and the next list of that client arrives already familiar", async ({ page, errors }) => {
      void errors;
      const clientId = await newClient(page, `Latihan ${theme}`);
      const calls = familiarityCalls(page);
      await page.goto("/pencocokan");
      await expectTheme(page, theme);
      const wb = await openWorkbench(page);

      await expect(wb.getByRole("option", { name: "+ Klien baru…" })).toHaveCount(1);
      await wb.getByRole("combobox", { name: "Klien" }).selectOption(String(clientId));
      await wb.getByLabel("Judul feed").fill("List Oktober");
      const list = listFor(theme);
      await wb.getByLabel("Tempel daftar barang").fill(list.join("\n"));
      await wb.getByRole("button", { name: "Cocokkan" }).click();
      expect(calls.feed).toEqual([{ client_id: clientId, title: "List Oktober", raw_lines: list.map((text) => ({ text })) }]);

      const adjustment = badge(wb, "adjustment");
      const review = badge(wb, "perlu dicek");
      const todo = wb.getByRole("button", { name: /^Perlu Dibereskan/ });
      const familiar = wb.getByRole("button", { name: /^Sudah Familiar/ });
      await expect(adjustment).toHaveText("4 adjustment");
      await expect(review).toHaveText("1 perlu dicek");
      await expect(todo).toHaveText("Perlu Dibereskan (5)");
      await expect(familiar).toHaveText("Sudah Familiar (0)");
      await expectReadable(adjustment);
      await expectReadable(review);
      // A client is chosen: no session-only warning.
      await expect(wb.getByText(/Latihan tanpa klien/)).toHaveCount(0);

      // 1. A candidate pill: one click, sent as the catalog id, kept for this client.
      const gunting = wb.getByRole("row", { name: /Gunting kecil biru/ });
      const guntingPill = gunting.getByRole("button", { name: /GUNTING KERTAS JOYKO KECIL/ });
      await expectReadable(guntingPill);
      await guntingPill.click();
      await expect(review).toHaveCount(0);
      expect(calls.resolve.at(-1)).toEqual({ row_id: expect.any(Number), action: "verify_item", item_id: await itemId(page, "GNT-KC"), apply_to_client_only: true });
      await expect(gunting).toContainText("Sudah dibereskan");

      // 2. The inline search reaches the real catalog.
      const sidu = wb.getByRole("row", { name: /Kertas sidu/ });
      await sidu.getByRole("button", { name: "Cari di katalog untuk Kertas sidu" }).click();
      await sidu.getByLabel("Kata kunci katalog").fill("sinar dunia");
      await sidu.getByRole("button", { name: "Cari", exact: true }).click();
      await sidu.getByRole("button", { name: /KERTAS HVS SINAR DUNIA A4 70GR/ }).click();
      await expect(adjustment).toHaveText("3 adjustment");
      expect(calls.resolve.at(-1)).toMatchObject({ action: "verify_item", item_id: await itemId(page, "K-SD70") });

      // 3. A barang baru: requested once, and both spellings settle with it.
      const tisu = wb.getByRole("row", { name: new RegExp(`^${list[2]}`) });
      await tisu.getByRole("button", { name: "Barang Baru" }).click();
      await page.getByRole("button", { name: "Buat & tambahkan" }).click();
      await expect(adjustment).toHaveText("1 adjustment");
      // Pointed at by name: the server refuses a BARU-… code in the payload and finds the request it just made by its name.
      expect(calls.resolve.at(-1)).toEqual({ row_id: expect.any(Number), action: "create_new_item", new_item_payload: { name: list[2], uom: "Pcs" }, apply_to_client_only: true });
      const requested = (await (await page.request.get("/api/pending-items")).json()).items.filter((p: { name: string }) => p.name === list[2]);
      expect(requested.length, "one barang baru for both spellings").toBe(1);
      await expect(wb.getByRole("row", { name: new RegExp(`^${list[3]}`) })).toContainText("Sudah dibereskan");

      // 4. Not an item.
      const header = wb.getByRole("row", { name: /NO\. ITEM DESCRIPTION/ });
      await header.getByRole("button", { name: "Bukan Barang / Header" }).click();
      await expect(adjustment).toHaveCount(0);
      await expect(header.locator(".badge")).toHaveText("Header");
      expect(calls.resolve.at(-1)).toMatchObject({ action: "ignore_row", apply_to_client_only: true });

      // 5. A guess the matcher was sure of, and right: one click makes it a rule.
      const spidol = wb.getByRole("row", { name: /Spidol snowman hitam/ });
      await expectReadable(spidol.getByRole("button", { name: "Benar" }));
      await spidol.getByRole("button", { name: "Benar" }).click();
      await expect(spidol).toContainText("Sudah dibereskan");

      await expect(todo).toHaveText("Perlu Dibereskan (0)");
      await expect(familiar).toHaveText("Sudah Familiar (5)");
      await familiar.click();
      await expect(wb.locator("tbody tr")).toHaveCount(5);

      // The point of training: the same client's next list, fed again, is already settled.
      await wb.getByRole("button", { name: "Feed baru" }).click();
      await wb.getByRole("combobox", { name: "Klien" }).selectOption(String(clientId));
      await wb.getByRole("button", { name: "Cocokkan" }).click();
      await expect(familiar).toHaveText("Sudah Familiar (5)");
      await expect(todo).toHaveText("Perlu Dibereskan (0)");
      await expect(wb.getByRole("row", { name: /NO\. ITEM DESCRIPTION/ }).locator(".badge")).toHaveText("Header");
      await expect(wb.getByRole("row", { name: /Kertas sidu/ })).toContainText("KERTAS HVS SINAR DUNIA A4 70GR");
    });

    test("a settled row can be corrected, and a correction cancelled sends nothing", async ({ page, errors }) => {
      void errors;
      const clientId = await newClient(page, `Koreksi ${theme}`);
      const calls = familiarityCalls(page);
      await page.goto("/pencocokan");
      const wb = await openWorkbench(page);
      await wb.getByRole("combobox", { name: "Klien" }).selectOption(String(clientId));
      await wb.getByLabel("Tempel daftar barang").fill(PASTE);
      await wb.getByRole("button", { name: "Cocokkan" }).click();

      // A wrong "Pasti": corrected through the catalog search.
      const kertas = wb.getByRole("row", { name: /Kertas HVS Sinar Dunia A4 70gr/ });
      await kertas.getByRole("button", { name: "Koreksi" }).click();
      await expect(kertas.getByText(/Sekarang: KERTAS HVS SINAR DUNIA/)).toBeVisible();
      // The item it is paired with now is not offered as a correction of itself.
      await expect(kertas.getByRole("button", { name: /K-SD70/ })).toHaveCount(0);
      await kertas.getByRole("button", { name: /KERTAS HVS BOLA DUNIA A4 70GR/ }).click();
      expect(calls.resolve.at(-1)).toMatchObject({ action: "verify_item", item_id: await itemId(page, "K-BD70") });
      await expect(kertas).toContainText("KERTAS HVS BOLA DUNIA A4 70GR (K-BD70)");

      // Corrected again, back to Sinar Dunia: a settled row is never final.
      await kertas.getByRole("button", { name: "Koreksi" }).click();
      await expect(kertas.getByRole("button", { name: /K-BD70/ })).toHaveCount(0);
      await kertas.getByRole("button", { name: /KERTAS HVS SINAR DUNIA A4 70GR/ }).click();
      await expect(kertas).toContainText("KERTAS HVS SINAR DUNIA A4 70GR (K-SD70)");

      // Opening a correction and backing out sends nothing.
      const sent = calls.resolve.length;
      await kertas.getByRole("button", { name: "Koreksi" }).click();
      await expect(kertas.getByRole("button", { name: "Barang Baru" })).toBeVisible();
      await kertas.getByRole("button", { name: "Batal" }).click();
      await expect(kertas.getByRole("button", { name: "Barang Baru" })).toHaveCount(0);
      expect(calls.resolve.length).toBe(sent);
    });
  });
}

test("a manager's rule for every client is opt-in: unticked it stays in the session, ticked it reaches any client", async ({ page, errors }) => {
  void errors;
  // Clients the screen must already list (it loads them once).
  const others = [await newClient(page, "Klien lain 1"), await newClient(page, "Klien lain 2")];
  const calls = familiarityCalls(page);
  await page.goto("/pencocokan");
  const wb = await openWorkbench(page);
  await expect(wb.getByText(/kecuali Anda mencentang "semua klien"/)).toBeVisible();
  await expectReadable(wb.getByText(/kecuali Anda mencentang/));
  const anotherClientSees = async () => {
    await wb.getByRole("button", { name: "Feed baru" }).click();
    await wb.getByRole("combobox", { name: "Klien" }).selectOption(String(others.shift()));
    await wb.getByRole("button", { name: "Cocokkan" }).click();
    const row = wb.getByRole("row", { name: /Lakban bening/ });
    await expect(row.locator(".badge")).not.toHaveText("");
    const text = await row.locator(".badge").innerText();
    await wb.getByRole("button", { name: "Feed baru" }).click();
    await wb.getByRole("combobox", { name: "Klien" }).selectOption("");
    return text;
  };

  // Not a line the sales test uses: once ticked, this rule answers for every client.
  await wb.getByLabel("Tempel daftar barang").fill("Lakban bening");
  await wb.getByRole("button", { name: "Cocokkan" }).click();
  const everyone = wb.getByRole("checkbox", { name: /semua klien/ });
  await expect(everyone).not.toBeChecked();
  await expect(wb.getByText(/Latihan tanpa klien/)).toBeVisible();

  // Unticked: kept for this session only, so another client's list does not know it.
  await wb.getByRole("button", { name: "Benar" }).click();
  expect(calls.resolve.at(-1)).toMatchObject({ action: "verify_item", item_id: await itemId(page, "LKB-48"), apply_to_client_only: true });
  expect(await anotherClientSees()).toBe("Cocok");

  // Ticked: every client.
  await wb.getByRole("button", { name: "Cocokkan" }).click();
  await everyone.check();
  await expect(wb.getByText(/Latihan tanpa klien/)).toHaveCount(0);
  await wb.getByRole("button", { name: "Benar" }).click();
  expect(calls.resolve.at(-1)).toMatchObject({ action: "verify_item", apply_to_client_only: false });
  expect(await anotherClientSees()).toBe("Sudah dibereskan");
});

test("Pencocokan is its own item in the top menu, and the workbench is open without a toggle", async ({ page, errors }) => {
  void errors;
  await page.goto("/quotes");
  const nav = page.getByRole("navigation", { name: "Navigasi utama" });
  await nav.getByRole("link", { name: "Pencocokan" }).click();
  await expect(page).toHaveURL(/\/pencocokan$/);
  await expect(nav.getByRole("link", { name: "Pencocokan" })).toHaveClass(/active/);
  await expect(page.getByRole("heading", { name: "Pencocokan barang" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Latih Pencocokan" }).getByLabel("Tempel daftar barang")).toBeVisible();
  // Managers see how the matcher is doing, under the workbench.
  await expect(page.getByRole("heading", { name: "Pembelajaran pencocokan" })).toBeVisible();
  // Katalog is the catalog again.
  await nav.getByRole("link", { name: "Katalog" }).click();
  await expect(page.getByRole("heading", { name: "Pembelajaran pencocokan" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Latih Pencocokan" })).toHaveCount(0);
});

test.describe("report unavailable", () => {
  test.use({ expectedConsole: [/\/api\/catalog\/match-learning/] });

  test("a failed report does not take the workbench with it", async ({ page, errors }) => {
    void errors;
    await page.route("**/api/catalog/match-learning", (route) => route.fulfill({ status: 500, json: { error: "x" } }));
    await page.goto("/pencocokan");
    await openWorkbench(page);
    await expect(page.getByRole("region", { name: "Latih Pencocokan" }).getByLabel("Tempel daftar barang")).toBeVisible();
  });
});

test("a client's file is fed with the codes, quantities and units the parser read", async ({ page, errors }) => {
  void errors;
  const calls = familiarityCalls(page);
  await page.goto("/pencocokan");
  const wb = await openWorkbench(page);
  await wb.locator('input[type="file"]').setInputFiles(
    csvFile("list-cgv.csv", [
      ["NO", "ITEM CODE", "DES", "QTY", "Satuan"],
      ["1", "100591", "ATK_LAKBAN BENING", "12", "Roll"],
      ["2", "", "Teh kotak 300ml", "24", "Pcs"],
    ]),
  );
  await expect(wb.getByText("list-cgv.csv")).toBeVisible();
  await expect(wb.getByLabel("Tempel daftar barang")).toBeDisabled();
  await wb.getByRole("button", { name: "Cocokkan" }).click();
  await expect(wb.locator("tbody tr")).toHaveCount(2);
  // The name comes from DES, the client's code stays its own field (not glued into the wording).
  expect(calls.feed).toEqual([
    {
      client_id: null,
      title: "",
      raw_lines: [
        { text: "ATK_LAKBAN BENING", qty: 12, unit: "Roll", code: "100591" },
        { text: "Teh kotak 300ml", qty: 24, unit: "Pcs" },
      ],
    },
  ]);
});

test.describe("PDF", () => {
  test.use({ expectedConsole: [/\/api\/ocr\/extract/] });

  test("a past quotation as PDF is read through the OCR and fed like any list", async ({ page, errors }) => {
    void errors;
    // Gemini is the one outside service: only the OCR answer is canned, the rest is the real server.
    const sent: { mime: string | null; base64: string }[] = [];
    let refuse = true;
    await page.route("**/api/ocr/extract", async (route) => {
      const req = route.request();
      sent.push({ mime: req.headers()["x-file-mime"] ?? null, base64: req.postData() ?? "" });
      if (refuse) {
        refuse = false;
        return route.fulfill({ status: 503, json: { error: "Pembacaan PDF belum aktif." } });
      }
      return route.fulfill({
        json: {
          lines: [
            { name: "Kertas HVS Sinar Dunia A4 70gr", qty: 5, uom: "Rim", code: "K-SD70" },
            { name: "Gunting kecil biru", qty: 2, uom: "Pcs" },
          ],
        },
      });
    });
    await page.goto("/pencocokan");
    const wb = await openWorkbench(page);
    const pdf = { name: "quotation-lama.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%e2e\n") };
    const input = wb.locator('input[type="file"]');
    await expect(input).toHaveAttribute("accept", /\.pdf/);

    // A refusal is shown and leaves nothing half-read.
    await input.setInputFiles(pdf);
    await expect(wb.getByText("Pembacaan PDF belum aktif.")).toBeVisible();
    await expect(wb.getByRole("button", { name: "Cocokkan" })).toBeDisabled();

    // The same file picked again is read again.
    await input.setInputFiles(pdf);
    await expect(wb.getByText("quotation-lama.pdf")).toBeVisible();
    await expect(wb.getByText(/2 baris dibaca otomatis dari file/)).toBeVisible();
    expect(sent.map((s) => s.mime)).toEqual(["application/pdf", "application/pdf"]);
    expect(Buffer.from(sent[1].base64, "base64").toString()).toBe("%PDF-1.4\n%e2e\n");

    const calls = familiarityCalls(page);
    await wb.getByRole("button", { name: "Cocokkan" }).click();
    await expect(wb.locator("tbody tr")).toHaveCount(2);
    expect(calls.feed[0]).toMatchObject({
      raw_lines: [
        { text: "Kertas HVS Sinar Dunia A4 70gr", qty: 5, unit: "Rim", code: "K-SD70" },
        { text: "Gunting kecil biru", qty: 2, unit: "Pcs" },
      ],
    });
    await expect(wb.getByRole("row", { name: /Gunting kecil biru/ })).toContainText("Perlu dicek");
  });
});

test("a file dropped on the drop area is read, not opened by the browser", async ({ page, errors }) => {
  void errors;
  await page.goto("/pencocokan");
  const wb = await openWorkbench(page);
  await wb.getByLabel("Judul feed").fill("Tetap ada");
  const data = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["Nama Barang,Qty\nLakban bening,3\n"], "drop.csv", { type: "text/csv" }));
    return dt;
  });
  const zone = wb.locator(".drop");
  await zone.dispatchEvent("dragover", { dataTransfer: data });
  await zone.dispatchEvent("drop", { dataTransfer: data });
  await expect(wb.getByText("drop.csv")).toBeVisible();
  await expect(page).toHaveURL(/\/pencocokan$/);
  await expect(wb.getByLabel("Judul feed")).toHaveValue("Tetap ada");
});

test.describe("sales", () => {
  test.use({ storageState: "e2e/.auth/rep.json" });

  test("a sales rep trains with a client and it sticks; without one it lasts only the session", async ({ page, errors }) => {
    void errors;
    await page.goto("/pencocokan");
    await expect(page.getByText("Sales", { exact: true })).toBeVisible();
    // The learning report stays with managers.
    await expect(page.getByText(/dipakai apa adanya/)).toHaveCount(0);
    const wb = await openWorkbench(page);

    // Without a client: told up front, and again on the session.
    await expect(wb.getByText(/Pilih klien supaya sistem belajar/)).toBeVisible();
    await wb.getByLabel("Tempel daftar barang").fill("Gunting kecil biru");
    await wb.getByRole("button", { name: "Cocokkan" }).click();
    await expect(wb.getByText(/Latihan tanpa klien/)).toBeVisible();
    await expectReadable(wb.getByText(/Latihan tanpa klien/));
    // A rep cannot store a rule for every client: no such switch.
    await expect(wb.getByRole("checkbox")).toHaveCount(0);
    await wb.getByRole("button", { name: /GUNTING KERTAS JOYKO KECIL/ }).click();
    await expect(wb.getByRole("row", { name: /Gunting kecil biru/ })).toContainText("Sudah dibereskan");
    await wb.getByRole("button", { name: "Feed baru" }).click();
    await wb.getByRole("button", { name: "Cocokkan" }).click();
    await expect(wb.getByRole("row", { name: /Gunting kecil biru/ })).toContainText("Perlu dicek");

    // With a client: the same choice is there on the next list.
    await wb.getByRole("button", { name: "Feed baru" }).click();
    await wb.getByRole("combobox", { name: "Klien" }).selectOption({ label: "PT Agrinesia" });
    await wb.getByRole("button", { name: "Cocokkan" }).click();
    await wb.getByRole("button", { name: /GUNTING KERTAS JOYKO KECIL/ }).click();
    await wb.getByRole("button", { name: "Feed baru" }).click();
    await wb.getByRole("combobox", { name: "Klien" }).selectOption({ label: "PT Agrinesia" });
    await wb.getByRole("button", { name: "Cocokkan" }).click();
    await expect(wb.getByRole("row", { name: /Gunting kecil biru/ })).toContainText("Sudah dibereskan");
  });
});
