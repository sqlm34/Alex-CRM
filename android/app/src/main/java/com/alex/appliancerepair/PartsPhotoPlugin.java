package com.alex.appliancerepair;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Read the granted content URI natively; never hand a provider-backed File to WebView. */
@CapacitorPlugin(name = "PartsPhoto")
public class PartsPhotoPlugin extends Plugin {
    private final ExecutorService reader = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private PluginCall pending;
    private File cameraFile;
    private Uri cameraUri;
    private boolean destroyed;

    @PluginMethod
    public void pick(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (destroyed || pending != null) { call.reject("PHOTO_PICKER_BUSY"); return; }
            pending = call;
            try {
                Intent intent;
                if ("camera".equals(call.getString("source"))) {
                    cameraFile = File.createTempFile("parts-label-", ".jpg", getContext().getCacheDir());
                    cameraUri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", cameraFile);
                    intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                    intent.putExtra(MediaStore.EXTRA_OUTPUT, cameraUri);
                    intent.setClipData(ClipData.newRawUri("Appliance label", cameraUri));
                    intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
                } else {
                    intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("image/*");
                    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                }
                startActivityForResult(call, intent, "photoSelected");
            } catch (Exception error) {
                finish(call, null, "PHOTO_PICKER_UNAVAILABLE");
            }
        });
    }

    @ActivityCallback
    private void photoSelected(PluginCall call, ActivityResult result) {
        if (call == null || pending != call || destroyed) return;
        if (result.getResultCode() != Activity.RESULT_OK) {
            JSObject cancelled = new JSObject();
            cancelled.put("cancelled", true);
            finish(call, cancelled, null);
            return;
        }
        final Uri uri = cameraUri != null ? cameraUri : result.getData() == null ? null : result.getData().getData();
        final boolean camera = cameraUri != null;
        if (uri == null) { finish(call, null, "PHOTO_READ_FAILED"); return; }
        // Providers can download cloud-backed images here; keep I/O off the UI thread.
        reader.execute(() -> {
            JSObject value = null;
            String failure = null;
            try (InputStream stream = getContext().getContentResolver().openInputStream(uri);
                 ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
                if (stream == null) throw new java.io.IOException();
                byte[] buffer = new byte[32768];
                int count;
                while ((count = stream.read(buffer)) != -1) {
                    if (Thread.currentThread().isInterrupted()) throw new java.io.IOException();
                    if (bytes.size() + count > 10000000) { failure = "PHOTO_TOO_LARGE"; break; }
                    bytes.write(buffer, 0, count);
                }
                if (failure == null) {
                    if (bytes.size() == 0) throw new java.io.IOException();
                    String mime = camera ? "image/jpeg" : getContext().getContentResolver().getType(uri);
                    value = new JSObject();
                    value.put("mimeType", mime == null ? "application/octet-stream" : mime);
                    value.put("base64", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP));
                }
            } catch (Exception error) { failure = "PHOTO_READ_FAILED"; }
            final JSObject photo = value;
            final String error = failure;
            main.post(() -> finish(call, photo, error));
        });
    }

    private void finish(PluginCall call, JSObject value, String error) {
        if (pending != call) return;
        pending = null;
        clearCamera();
        if (destroyed) return;
        if (error != null) call.reject(error);
        else call.resolve(value);
    }

    private void clearCamera() {
        if (cameraUri != null) {
            getContext().revokeUriPermission(cameraUri, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            cameraUri = null;
        }
        if (cameraFile != null) { cameraFile.delete(); cameraFile = null; }
    }

    @Override
    protected void handleOnDestroy() {
        destroyed = true;
        pending = null;
        reader.shutdownNow();
        clearCamera();
    }
}
