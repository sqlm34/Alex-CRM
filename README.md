# Alex Appliance Repair CRM

Alex is a mobile-friendly web app for appliance repair work: customers, jobs, service status, invoices, address lookup, and Google Maps navigation.

## Run locally

```bash
npm install
npm run dev
```

## Google Maps

Create `.env` from `.env.example` and add a Google Maps JavaScript API key with Places enabled:

```bash
VITE_GOOGLE_MAPS_API_KEY=your_key
```

Without the key, the app still works and opens navigation through Google Maps links. With the key, the live map and address autocomplete turn on.

## Neon/PostgreSQL backend

For a private PostgreSQL connection string, use the backend server. Do not put a PostgreSQL URL in the web or Android app.

1. Create `backend/.env` from `backend/.env.example`.
2. Add your Neon `DATABASE_URL`.
3. Run:

```bash
cd backend
npm install
npm run db:setup
npm run dev
```

4. In the web app `.env`, set:

```bash
VITE_API_URL=http://127.0.0.1:5000
```

For production, deploy the backend to a server such as Railway, Render, Fly.io, or a VPS, then set `VITE_API_URL` to that public HTTPS URL.

## Deploy API on Cloudflare Workers

This repo includes a Cloudflare Worker API in `worker/index.ts`.

Cloudflare Workers settings:

```bash
Build command: npm install
Deploy command: npx wrangler deploy
Root directory: /
```

Add Worker secret:

```bash
DATABASE_URL=your_neon_postgresql_connection_string
```

Optional Worker variable:

```bash
ALLOWED_ORIGIN=*
GOOGLE_CLIENT_ID=your_google_oauth_web_client_id
```

Optional Worker secret for owner-approved access:

```bash
APPROVED_EMAILS=owner@example.com,tech@example.com
```

When `APPROVED_EMAILS` is set, only listed emails can register or sign in.

After deploy, Cloudflare gives a URL like:

```bash
https://alex-crm-api.your-subdomain.workers.dev
```

Use that URL in the app:

```bash
VITE_API_URL=https://alex-crm-api.your-subdomain.workers.dev
VITE_GOOGLE_CLIENT_ID=your_google_oauth_web_client_id
```

Then rebuild Android:

```bash
npm run build
npx cap sync android
cd android
./gradlew assembleDebug
```

## Deploy backend on Render

This repo includes `render.yaml`, so Render can create the backend service from GitHub.

1. Push the latest code to GitHub.
2. Open Render and choose **New Blueprint**.
3. Select the `sqlm34/Alex-CRM` repository.
4. Render will detect `render.yaml` and create `alex-crm-backend`.
5. Add environment variable `DATABASE_URL` with your Neon PostgreSQL connection string.
6. Deploy.
7. Copy the Render HTTPS URL, for example:

```bash
https://alex-crm-backend.onrender.com
```

8. In the web/Android build, set:

```bash
VITE_API_URL=https://alex-crm-backend.onrender.com
```

Then run:

```bash
npm run build
npx cap sync android
```

## Supabase database

Use Supabase for shared web and Android data.

1. Open Supabase SQL Editor.
2. Run `supabase-schema.sql`.
3. Create `.env` from `.env.example`.
4. Add:

```bash
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your_public_anon_key
```

Do not put the database password or service role key in this app. The Android and web app should only use the public anon key with Row Level Security policies.

## Mobile app path

This project is built as a responsive PWA. The next step for App Store / Google Play packaging is to add Capacitor and wrap the same web app as native mobile builds.
