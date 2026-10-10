# Menjalankan Silvy (agent-service) di Cloud Run

Silvy hanya dipanggil oleh app pricing (Worker). Agent memakai Gemini; kunci Gemini
hanya ada di sini dan tidak pernah di Worker atau browser.

## Keamanan (sudah di kode)
- Semua rute **kecuali `/health`** butuh header `x-silvy-secret`. Tanpa
  `SILVY_SHARED_SECRET`, `/silvy/*` mati (503), dan layanan tidak boleh dibuka publik.
- Tanpa header CORS (tidak ada pemanggil browser).
- **Layanan dibuat PRIVAT** (`--no-allow-unauthenticated`). Kebijakan organisasi
  `salvator.co.id` (`iam.allowedPolicyMemberDomains`) melarang `allUsers`, dan pembuatan
  kunci service account baru juga dilarang (`iam.disableServiceAccountKeyCreation`). Jadi
  Worker memanggil dengan **ID token Google** (audience = URL layanan) yang dibuat dari kunci
  service account yang sudah ada di Worker (`GOOGLE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_PRIVATE_KEY`,
  `server/googleIdToken.ts`). Akun itu harus punya `roles/run.invoker` pada layanan ini.
  Rahasia bersama tetap dikirim sebagai lapisan kedua.

## Yang perlu ada dulu
- `gcloud` terpasang dan sudah `gcloud auth login` (oleh pemilik akun).
- Project GCP Salvator dengan **billing aktif**. Region contoh `asia-southeast1`.
- Kunci Gemini dari AI Studio di project itu (tier berbayar). **Jangan kirim kunci lewat chat.**

## Langkah (jalankan dari root repo)

```bash
PROJECT=<project-gcp-salvator>
REGION=asia-southeast1
gcloud config set project $PROJECT
gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com cloudbuild.googleapis.com

# 1. Registry
gcloud artifacts repositories create silvy --repository-format=docker --location=$REGION

# 2. Rahasia (kunci Gemini diketik di prompt, tidak muncul di riwayat shell)
read -rs -p "GEMINI_API_KEY: " K; echo
printf '%s' "$K" | gcloud secrets create gemini-api-key --data-file=-; unset K
openssl rand -hex 32 | tr -d '\n' | gcloud secrets create silvy-shared-secret --data-file=-

# 3. Beri akses baca ke service account Cloud Run (default compute SA)
SA=$(gcloud projects describe $PROJECT --format='value(projectNumber)')-compute@developer.gserviceaccount.com
for S in gemini-api-key silvy-shared-secret; do
  gcloud secrets add-iam-policy-binding $S --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor
done

# 4. Build + deploy
IMAGE=$REGION-docker.pkg.dev/$PROJECT/silvy/agent:$(git rev-parse --short HEAD)
gcloud builds submit --config agent-service/cloudbuild.yaml --substitutions _IMAGE=$IMAGE .
gcloud run deploy silvy-agent --image $IMAGE --region $REGION \
  --no-allow-unauthenticated --min-instances 0 --max-instances 2 \
  --concurrency 10 --timeout 120 --cpu 1 --memory 512Mi \
  --set-secrets GEMINI_API_KEY=gemini-api-key:latest,SILVY_SHARED_SECRET=silvy-shared-secret:latest \
  --set-env-vars GEMINI_MODEL=gemini-3.5-flash
URL=$(gcloud run services describe silvy-agent --region $REGION --format='value(status.url)')

# 5. Beri akun layanan Worker hak memanggil (satu akun, satu layanan; dijalankan pemilik akun)
NOTIFY_SA=halokantor-notify@galvanic-host-505711-k5.iam.gserviceaccount.com
gcloud run services add-iam-policy-binding silvy-agent --region $REGION \
  --member=serviceAccount:$NOTIFY_SA --role=roles/run.invoker

# 6. Verifikasi agent (token ID milik Anda sendiri)
URL=$(gcloud run services describe silvy-agent --region $REGION --format='value(status.url)')
T=$(gcloud auth print-identity-token)
curl -s -o /dev/null -w '%{http_code}\n' $URL/health                                  # 403 (privat)
curl -s -H "Authorization: Bearer $T" $URL/health                                      # 200
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $T" $URL/status    # 401 tanpa rahasia

# 7. Sambungkan Worker (rahasia dialirkan lewat pipe, tidak dicetak)
printf '%s' "$URL" | npx wrangler secret put SILVY_URL
gcloud secrets versions access latest --secret silvy-shared-secret | npx wrangler secret put SILVY_SHARED_SECRET
printf 'true' | npx wrangler secret put SILVY_IAM_AUTH
```

Lalu cek di app: `/api/health` harus `ai:true`, dan panel Silvy di editor menjawab.

## Catatan
- Pasang **budget alert** di Billing; setiap pertanyaan adalah satu panggilan Gemini berbayar.
- `GEMINI_MODEL`: `gemini-3.5-flash` patuh pada aturan "satu kalimat konfirmasi"; `gemini-3.1-flash-lite`
  lebih cepat dan murah tetapi pernah menambah kalimat di luar aturan. Putuskan setelah uji beberapa skenario.
- Knowledge store SQLite di `/tmp` hilang saat instance berganti. Silvy tidak memakainya;
  `/sync` dan `/recommend` butuh penyimpanan tetap sebelum dipakai di Cloud Run.
- Rollback: `gcloud run services update-traffic silvy-agent --region $REGION --to-revisions=REVISI=100`.
