# Android label photo reading (1.8 / versionCode 9)

The reported error came from readLabelFile after three NotReadableError failures
on the same WebView provider-backed File. No scan request had been made yet.
Retrying the same inaccessible File does not repair its Android URI grant.

PartsPhoto now receives ACTION_OPEN_DOCUMENT results and immediately reads the
granted content URI via ContentResolver on a background executor. Only bounded
image bytes (maximum 10 MB) are passed to JavaScript, which constructs a stable
in-memory File. Scan label uses ACTION_IMAGE_CAPTURE with a FileProvider URI;
its temporary cache file is deleted after success/error/cancellation. No broad
storage or camera permission is added: the system camera activity handles capture.
The original gallery photo is never altered or deleted. Photos are not added to
job Attachments. Existing HEIC conversion and server scan logic are retained.

Native picker cancellation retains the current search. A new selected photo
clears the previous query/model/results before recognition. Closing Parts before
the picker returns prevents a scan request. Browser and older APK versions keep
their existing HTML picker fallback; install 1.8 to get the native fix.

References:
- https://developer.android.com/training/data-storage/shared/documents-files
- https://developer.android.com/reference/android/provider/MediaStore#ACTION_IMAGE_CAPTURE
- https://capacitorjs.com/docs/plugins/android

Verification: TypeScript/Vite build, Capacitor sync, release build/unit tests,
release lint and browser regressions. Native bridge mock tests cover gallery,
camera, cancellation, read failure, one scan per selection, reset and no attachment
writes. These do not prove behavior of a physical Android photo provider.

Phone check: install 1.8 over the existing app. In Parts select the same previously
failing photo once, then select a second photo, cancel a third selection, and test
Scan label. Check preview/model, no duplicates in Attachments, and microphone.
No physical phone was connected during development.
