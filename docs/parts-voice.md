# Parts Search voice input

Android uses the in-repository PartsSpeech Capacitor 8 plugin wrapping Android
SpeechRecognizer. It follows the existing local-plugin registration pattern;
there is no new package dependency, server, LLM transcription or agent.

Sources checked during implementation:
- https://developer.android.com/reference/android/speech/SpeechRecognizer
- https://capacitorjs.com/docs/plugins/android
- Installed Capacitor 8 Plugin.java permission and lifecycle APIs.

The system recognizer may send speech to its provider (for example Google).
The CRM does not record, persist or upload audio. Only final text enters the
existing form. Search never runs automatically. EN/RU selects one recognition
language per session. Unsupported languages/services show an error.

By Model dictates the existing Model identity field, invalidates its previous
catalog confirmation and focuses it for review. The existing Part needed query
is retained. By Part Number and By Name dictate the query field. Explicit spoken
single digits are converted; ambiguous letters/phrases are never inferred.

Android adds RECORD_AUDIO and the RecognitionService package-visibility query.
Permission is requested only after tapping the microphone. Sessions time out
after 35 seconds; cancel, screen close and Activity background stop/destroy the
recognizer. Stale callbacks cannot update a later session. Granting permission
after cancellation cannot restart recording. Browser fallback is feature-detected
Web Speech in a secure context, not an Android WebView substitute.

## Release and phone verification

A website deployment alone CANNOT add the native plugin to an installed APK.
An APK update signed with the existing application's signing key is required.
Older APKs show Update the Android app to enable voice input, not a broken mic.

On the updated physical Android app:
1. Open Job > Parts. In By Model tap mic, grant permission, say WTW 5057 LW zero.
   Check Model is WTW5057LW0, no automatic catalog/search request.
2. By Part Number: say W one one three nine nine four three seven. Check
   W11399437; tap Search suppliers manually and check both supplier sections.
3. By Name, after confirming a model: test EN drain pump and RU сливная помпа.
4. Deny microphone permission via Android settings; retry, allow, and retry.
5. Test silence, Cancel, double tap, restart, mode change and close Parts while
   listening. Return and confirm no stale text or microphone remains active.
6. While listening press Home, return and confirm recording is stopped; start a
   new session. Repeat while the permission dialog is open.
7. Verify typing, clearing, camera/gallery, model selection and supplier search.

Mock browser tests verify UI lifecycle and transcript routing, not microphone
hardware, speech accuracy or Android permission dialogs.

## Verification 2026-10-08

- TypeScript and production Vite build: passed.
- Production bundle guard: passed.
- ESLint on new voice modules: passed.
- Parts voice + supplier/catalog tests: 35 passed.
- Playwright voice and existing parts flow: 6 passed (390px and 1280px).
- Capacitor sync in isolated build directory: passed.
- Gradle :app:assembleDebug :app:testDebugUnitTest: passed.
- adb devices: no physical device connected. Real Android speech/permission
  verification remains required using the checklist above.
- Release signing environment: not configured. No release APK, installation,
  signing-key replacement or version change performed. Website deployment is
  separate from delivery of the required signed Android update.
