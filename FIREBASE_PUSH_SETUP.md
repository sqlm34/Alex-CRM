# Firebase Push Setup for Alex

The app code is ready for Firebase Cloud Messaging. To make real push notifications work on Android phones:

1. Create or open a Firebase project.
2. Add an Android app with package name:
   `com.alex.appliancerepair`
3. Download `google-services.json` and place it here:
   `android/app/google-services.json`
4. In Firebase Console, create a service account private key.
5. Add these Cloudflare Worker runtime secrets:
   - `FIREBASE_PROJECT_ID`
   - `FIREBASE_CLIENT_EMAIL`
   - `FIREBASE_PRIVATE_KEY`

After that, rebuild the APK. When the app opens on a phone, it registers the phone token with the Alex backend. When a new job is created, the Cloudflare Worker sends a Firebase push notification to registered phones.
