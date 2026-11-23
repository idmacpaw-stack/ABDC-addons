# ABDC Drive Addon

Addon Stremio/Nuvio pribadi untuk memutar file video dari folder Google Drive sendiri, lengkap dengan subtitle OpenSubtitles + SUBDL.

## Environment variable
Wajib:
- `GDRIVE_API_KEY` – API key Google Drive API
- `GDRIVE_FOLDER_ID` – ID folder Drive (dibagikan "Anyone with the link")

Subtitle (isi salah satu atau keduanya):
- `SUBDL_API_KEY` – API key dari subdl.com (cukup ini saja sudah jalan)
- `OPENSUBTITLES_API_KEY`, `OPENSUBTITLES_USERNAME`, `OPENSUBTITLES_PASSWORD` – ketiganya wajib untuk OpenSubtitles (unduhan butuh login)

Opsional: `SUB_LANGS` (default `id,en`), `SUBS_PER_LANG` (default 3), `PUBLIC_URL`, `NO_HASH=1`, `STREAM_SUBS=0`.

## Jalankan lokal
    npm install
    node server.js

## Deploy
Import repo ke Vercel, isi environment variable, lalu Deploy (setelah menambah env, **Redeploy**).
Manifest: `https://<project>.vercel.app/manifest.json`

## Cek masalah
- `/debug` – pencocokan episode IMDb <-> file Drive
- `/debug/subs?s=1&e=2` – diagnosa subtitle (env terbaca? hasil cari? login OK?)
