package com.alex.appliancerepair;

import android.Manifest;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;

@CapacitorPlugin(name = "PartsSpeech", permissions = {
    @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
})
public class PartsSpeechPlugin extends Plugin {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private SpeechRecognizer recognizer;
    private PluginCall pending;
    private Runnable timeout;

    @PluginMethod
    public void available(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSObject value = new JSObject();
            value.put("available", SpeechRecognizer.isRecognitionAvailable(getContext()));
            call.resolve(value);
        });
    }

    @PluginMethod
    public void start(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (pending != null) { call.reject("RECOGNITION_FAILED"); return; }
            if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
                call.reject("SPEECH_RECOGNITION_UNAVAILABLE"); return;
            }
            pending = call;
            timeout = () -> fail(call, "NO_SPEECH_DETECTED");
            handler.postDelayed(timeout, 35000);
            if (getPermissionState("microphone") != PermissionState.GRANTED) {
                requestPermissionForAlias("microphone", call, "microphonePermission");
            } else {
                listen(call);
            }
        });
    }

    @PermissionCallback
    private void microphonePermission(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            // A cancelled permission request must never start recording later.
            if (pending != call) return;
            if (getPermissionState("microphone") != PermissionState.GRANTED) {
                fail(call, "MICROPHONE_PERMISSION_DENIED");
            } else {
                listen(call);
            }
        });
    }

    private void state(PluginCall call, String status) {
        if (pending != call) return;
        JSObject value = new JSObject();
        value.put("session", call.getString("session"));
        value.put("status", status);
        notifyListeners("state", value);
    }

    private void listen(PluginCall call) {
        try {
            recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
            recognizer.setRecognitionListener(new RecognitionListener() {
                public void onReadyForSpeech(Bundle params) { state(call, "listening"); }
                public void onBeginningOfSpeech() { state(call, "listening"); }
                public void onRmsChanged(float rms) {}
                public void onBufferReceived(byte[] buffer) {}
                public void onEndOfSpeech() { state(call, "recognizing"); }
                public void onPartialResults(Bundle results) {}
                public void onEvent(int type, Bundle params) {}
                public void onError(int error) {
                    String code = error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS ? "MICROPHONE_PERMISSION_DENIED"
                        : error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT ? "NO_SPEECH_DETECTED"
                        : error == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED || error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE ? "SPEECH_RECOGNITION_UNAVAILABLE"
                        : "RECOGNITION_FAILED";
                    fail(call, code);
                }
                public void onResults(Bundle results) {
                    if (pending != call) return;
                    ArrayList<String> matches = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                    if (matches == null || matches.isEmpty() || matches.get(0).trim().isEmpty()) {
                        fail(call, "NO_SPEECH_DETECTED"); return;
                    }
                    JSObject value = new JSObject();
                    value.put("text", matches.get(0));
                    cleanup();
                    call.resolve(value);
                }
            });
            Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "ru-RU".equals(call.getString("language")) ? "ru-RU" : "en-US");
            intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
            intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, false);
            recognizer.startListening(intent);
        } catch (SecurityException error) {
            fail(call, "MICROPHONE_PERMISSION_DENIED");
        } catch (Exception error) {
            fail(call, "RECOGNITION_FAILED");
        }
    }

    private void fail(PluginCall call, String code) {
        if (pending != call) return;
        cleanup();
        call.reject(code);
    }

    private void cleanup() {
        pending = null;
        if (timeout != null) handler.removeCallbacks(timeout);
        timeout = null;
        SpeechRecognizer previous = recognizer;
        recognizer = null;
        if (previous != null) { previous.cancel(); previous.destroy(); }
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (pending != null && pending.getString("session", "").equals(call.getString("session", ""))) {
                fail(pending, "CANCELLED");
            }
            call.resolve();
        });
    }

    @Override
    protected void handleOnPause() {
        // Android's permission dialog also pauses the Activity; no recording exists yet.
        if (recognizer != null && pending != null) fail(pending, "CANCELLED");
    }

    @Override
    protected void handleOnStop() {
        if (pending != null) fail(pending, "CANCELLED");
    }

    @Override
    protected void handleOnDestroy() {
        if (pending != null) fail(pending, "CANCELLED");
        else cleanup();
    }
}
