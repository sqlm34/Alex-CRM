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

## Mobile app path

This project is built as a responsive PWA. The next step for App Store / Google Play packaging is to add Capacitor and wrap the same web app as native mobile builds.
