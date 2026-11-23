# ABDC Drive Addon

Addon Stremio/Nuvio pribadi untuk memutar file video dari folder Google Drive sendiri.

## Environment variable
- `GDRIVE_API_KEY` – API key Google Drive API
- `GDRIVE_FOLDER_ID` – ID folder Drive (dibagikan "Anyone with the link")

## Jalankan lokal
    npm install
    node server.js

## Deploy
Import repo ke Vercel, isi 2 environment variable di atas, lalu Deploy.
Manifest: `https://<project>.vercel.app/manifest.json`
