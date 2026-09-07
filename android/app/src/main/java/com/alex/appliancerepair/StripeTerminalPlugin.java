package com.alex.appliancerepair;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Build;

import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.stripe.stripeterminal.Terminal;
import com.stripe.stripeterminal.external.callable.Callback;
import com.stripe.stripeterminal.external.callable.ConnectionTokenCallback;
import com.stripe.stripeterminal.external.callable.ConnectionTokenProvider;
import com.stripe.stripeterminal.external.callable.DiscoveryListener;
import com.stripe.stripeterminal.external.callable.PaymentIntentCallback;
import com.stripe.stripeterminal.external.callable.ReaderCallback;
import com.stripe.stripeterminal.external.callable.TerminalListener;
import com.stripe.stripeterminal.external.models.ConnectionConfiguration;
import com.stripe.stripeterminal.external.models.ConnectionStatus;
import com.stripe.stripeterminal.external.models.ConnectionTokenException;
import com.stripe.stripeterminal.external.models.DiscoveryConfiguration;
import com.stripe.stripeterminal.external.models.PaymentIntent;
import com.stripe.stripeterminal.external.models.PaymentStatus;
import com.stripe.stripeterminal.external.models.Reader;
import com.stripe.stripeterminal.external.models.TerminalException;
import com.stripe.stripeterminal.log.LogLevel;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(
    name = "StripeTerminal",
    permissions = {
        @Permission(
            alias = "location",
            strings = {
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION
            }
        ),
        @Permission(
            alias = "bluetooth",
            strings = {
                Manifest.permission.BLUETOOTH_CONNECT,
                Manifest.permission.BLUETOOTH_SCAN
            }
        )
    }
)
public class StripeTerminalPlugin extends Plugin {
    private static final int STRIPE_PAYMENT_PROTOCOL_VERSION = 2;

    private volatile String apiUrl;
    private volatile String authToken;
    private volatile String pendingLocationId;

    @PluginMethod
    public void getCapabilities(PluginCall call) {
        JSObject result = new JSObject();
        result.put("stripePaymentProtocolVersion", STRIPE_PAYMENT_PROTOCOL_VERSION);
        result.put("supportsExternalClientSecret", true);
        result.put("supportsStructuredTerminalResult", true);
        call.resolve(result);
    }

    @PluginMethod
    public void enableBluetooth(PluginCall call) {
        if (!hasBluetoothPermission()) {
            requestPermissionForAlias("bluetooth", call, "bluetoothPermissionCallback");
            return;
        }

        requestBluetoothEnable(call);
    }

    @PermissionCallback
    private void bluetoothPermissionCallback(PluginCall call) {
        if (!hasBluetoothPermission()) {
            call.reject("Bluetooth permission is required for Tap to Pay.");
            return;
        }

        requestBluetoothEnable(call);
    }

    @PluginMethod
    public void collectPayment(PluginCall call) {
        if (getPermissionState("location") != PermissionState.GRANTED) {
            requestPermissionForAlias("location", call, "locationPermissionCallback");
            return;
        }

        if (!hasBluetoothPermission()) {
            requestPermissionForAlias("bluetooth", call, "bluetoothPaymentPermissionCallback");
            return;
        }

        startPayment(call);
    }

    @PermissionCallback
    private void locationPermissionCallback(PluginCall call) {
        if (getPermissionState("location") != PermissionState.GRANTED) {
            call.reject("Location permission is required for Tap to Pay.");
            return;
        }

        startPayment(call);
    }

    @PermissionCallback
    private void bluetoothPaymentPermissionCallback(PluginCall call) {
        if (!hasBluetoothPermission()) {
            call.reject("Bluetooth permission is required for Tap to Pay.");
            return;
        }

        startPayment(call);
    }

    private void startPayment(PluginCall call) {
        String jobId;
        String clientSecret;
        try {
            apiUrl = cleanRequired(call.getString("apiUrl"), "API URL is required");
            authToken = cleanRequired(call.getString("authToken"), "Authorization token is required");
            pendingLocationId = cleanRequired(call.getString("locationId"), "Stripe Terminal location is required");
            jobId = cleanRequired(call.getString("jobId"), "Job is required");
            clientSecret = cleanOptional(call.getString("clientSecret"));
        } catch (IllegalArgumentException exception) {
            call.reject(exception.getMessage());
            return;
        }

        int amount = call.getInt("amount", 0);
        String currency = (call.getString("currency", "usd") == null ? "usd" : call.getString("currency", "usd"))
            .toLowerCase(Locale.US);

        if (amount < 50) {
            call.reject("Payment amount must be at least $0.50.");
            return;
        }

        if (!hasLocationPermission()) {
            call.reject("Location permission is required for Tap to Pay.");
            return;
        }

        if (!isBluetoothEnabled()) {
            call.reject("Bluetooth is required for Tap to Pay. Tap Enable Bluetooth and choose Allow.");
            return;
        }

        try {
            initializeTerminal();
        } catch (Exception exception) {
            call.reject(exception.getMessage());
            return;
        }

        AtomicBoolean settled = new AtomicBoolean(false);
        connectReaderIfNeeded(call, () -> {
            if (clientSecret != null) {
                retrieveAndProcessPaymentIntent(call, clientSecret, settled);
            } else {
                createPaymentIntent(call, jobId, amount, currency, settled);
            }
        }, settled);
    }

    private void initializeTerminal() throws TerminalException {
        if (Terminal.isInitialized()) {
            return;
        }

        Terminal.initTerminal(
            getContext().getApplicationContext(),
            LogLevel.VERBOSE,
            new AlexConnectionTokenProvider(),
            new TerminalListener() {
                @Override
                public void onConnectionStatusChange(ConnectionStatus status) {
                    // No UI event is needed here; the payment call owns the visible state.
                }

                @Override
                public void onPaymentStatusChange(PaymentStatus status) {
                    // No UI event is needed here; Stripe shows the Tap to Pay collection screen.
                }
            }
        );
    }

    private void connectReaderIfNeeded(PluginCall call, Runnable onConnected, AtomicBoolean settled) {
        if (Terminal.getInstance().getConnectedReader() != null) {
            onConnected.run();
            return;
        }

        boolean simulated = isApplicationDebuggable();
        DiscoveryConfiguration config = new DiscoveryConfiguration.TapToPayDiscoveryConfiguration(simulated);
        final Reader[] firstReader = new Reader[1];

        Terminal.getInstance().discoverReaders(
            config,
            new DiscoveryListener() {
                @Override
                public void onUpdateDiscoveredReaders(List<Reader> readers) {
                    if (!readers.isEmpty() && firstReader[0] == null) {
                        firstReader[0] = readers.get(0);
                    }
                }
            },
            new Callback() {
                @Override
                public void onSuccess() {
                    if (firstReader[0] == null) {
                        rejectOnce(call, settled, "No Tap to Pay reader was found on this device.");
                        return;
                    }

                    connectDiscoveredReader(call, firstReader[0], onConnected, settled);
                }

                @Override
                public void onFailure(TerminalException exception) {
                    rejectOnce(call, settled, terminalError(exception));
                }
            }
        );
    }

    private void connectDiscoveredReader(PluginCall call, Reader reader, Runnable onConnected, AtomicBoolean settled) {
        ConnectionConfiguration config = new ConnectionConfiguration.TapToPayConnectionConfiguration(
            pendingLocationId,
            true,
            null
        );

        Terminal.getInstance().connectReader(
            reader,
            config,
            new ReaderCallback() {
                @Override
                public void onSuccess(Reader connectedReader) {
                    onConnected.run();
                }

                @Override
                public void onFailure(TerminalException exception) {
                    rejectOnce(call, settled, terminalError(exception));
                }
            }
        );
    }

    private void createPaymentIntent(PluginCall call, String jobId, int amount, String currency, AtomicBoolean settled) {
        new Thread(() -> {
            try {
                JSONObject response = postJson(
                    apiUrl + "/api/stripe/terminal/payment-intent",
                    new JSONObject()
                        .put("jobId", jobId)
                        .put("amount", amount)
                        .put("currency", currency)
                );
                String clientSecret = response.getString("clientSecret");
                getActivity().runOnUiThread(() -> retrieveAndProcessPaymentIntent(call, clientSecret, settled));
            } catch (Exception exception) {
                rejectOnce(call, settled, exception.getMessage());
            }
        }).start();
    }

    private void retrieveAndProcessPaymentIntent(PluginCall call, String clientSecret, AtomicBoolean settled) {
        Terminal.getInstance().retrievePaymentIntent(
            clientSecret,
            new PaymentIntentCallback() {
                @Override
                public void onSuccess(PaymentIntent paymentIntent) {
                    processPaymentIntent(call, paymentIntent, settled);
                }

                @Override
                public void onFailure(TerminalException exception) {
                    rejectOnce(call, settled, terminalError(exception));
                }
            }
        );
    }

    private void processPaymentIntent(PluginCall call, PaymentIntent paymentIntent, AtomicBoolean settled) {
        Terminal.getInstance().collectPaymentMethod(
            paymentIntent,
            new PaymentIntentCallback() {
                @Override
                public void onSuccess(PaymentIntent collectedPaymentIntent) {
                    confirmPaymentIntent(call, collectedPaymentIntent, settled);
                }

                @Override
                public void onFailure(TerminalException exception) {
                    rejectOnce(call, settled, terminalError(exception));
                }
            }
        );
    }

    private void confirmPaymentIntent(PluginCall call, PaymentIntent paymentIntent, AtomicBoolean settled) {
        Terminal.getInstance().confirmPaymentIntent(
            paymentIntent,
            new PaymentIntentCallback() {
                @Override
                public void onSuccess(PaymentIntent confirmedPaymentIntent) {
                    JSObject result = new JSObject();
                    result.put("paymentIntentId", confirmedPaymentIntent.getId());
                    result.put("status", String.valueOf(confirmedPaymentIntent.getStatus()));
                    result.put("amount", confirmedPaymentIntent.getAmount());
                    result.put("currency", confirmedPaymentIntent.getCurrency());
                    resolveOnce(call, settled, result);
                }

                @Override
                public void onFailure(TerminalException exception) {
                    rejectOnce(call, settled, terminalError(exception));
                }
            }
        );
    }

    private boolean hasLocationPermission() {
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasBluetoothPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return true;
        }

        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
            && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED;
    }

    private BluetoothAdapter getBluetoothAdapter() {
        BluetoothManager manager = (BluetoothManager) getContext().getSystemService(android.content.Context.BLUETOOTH_SERVICE);
        return manager == null ? null : manager.getAdapter();
    }

    private boolean isBluetoothEnabled() {
        BluetoothAdapter adapter = getBluetoothAdapter();
        return adapter != null && adapter.isEnabled();
    }

    private void requestBluetoothEnable(PluginCall call) {
        BluetoothAdapter adapter = getBluetoothAdapter();
        if (adapter == null) {
            call.reject("Bluetooth is not available on this device.");
            return;
        }

        if (adapter.isEnabled()) {
            resolveBluetooth(call, true);
            return;
        }

        Intent enableIntent = new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE);
        startActivityForResult(call, enableIntent, "bluetoothEnableCallback");
    }

    @ActivityCallback
    private void bluetoothEnableCallback(PluginCall call, ActivityResult result) {
        resolveBluetooth(call, isBluetoothEnabled());
    }

    private void resolveBluetooth(PluginCall call, boolean enabled) {
        JSObject result = new JSObject();
        result.put("enabled", enabled);
        call.resolve(result);
    }

    private boolean isApplicationDebuggable() {
        return (getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    private String cleanRequired(String value, String message) {
        if (value == null || value.trim().isEmpty()) {
            throw new IllegalArgumentException(message);
        }
        return value.trim();
    }

    private String cleanOptional(String value) {
        String cleaned = value == null ? "" : value.trim();
        return cleaned.isEmpty() ? null : cleaned;
    }

    private void resolveOnce(PluginCall call, AtomicBoolean settled, JSObject result) {
        if (settled.compareAndSet(false, true)) {
            call.resolve(result);
        }
    }

    private void rejectOnce(PluginCall call, AtomicBoolean settled, String message) {
        if (settled.compareAndSet(false, true)) {
            call.reject(message);
        }
    }

    private String terminalError(TerminalException exception) {
        String code = exception.getErrorCode() == null ? "Stripe Terminal error" : exception.getErrorCode().toString();
        String message = exception.getErrorMessage() == null ? exception.getMessage() : exception.getErrorMessage();
        if (code.contains("TAP_TO_PAY_UNSUPPORTED_DEVICE")) {
            return "This phone does not support Stripe Tap to Pay. Use a compatible Android phone with NFC, Android 13 or newer, Google Play services, a recent security update, and hardware-backed security, or use a Stripe card reader.";
        }
        return code + ": " + message;
    }

    private JSONObject postJson(String url, JSONObject payload) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(20000);
        connection.setReadTimeout(45000);
        connection.setDoOutput(true);
        connection.setRequestProperty("Authorization", "Bearer " + authToken);
        connection.setRequestProperty("Content-Type", "application/json");

        try (BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(connection.getOutputStream(), StandardCharsets.UTF_8))) {
            writer.write(payload.toString());
        }

        int status = connection.getResponseCode();
        String body = readResponse(status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream());
        JSONObject json = body.isEmpty() ? new JSONObject() : new JSONObject(body);
        if (status < 200 || status >= 300) {
            String message = json.optString("error", "Request failed");
            throw new IllegalStateException(message);
        }
        return json;
    }

    private String postEmpty(String url) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(20000);
        connection.setReadTimeout(45000);
        connection.setRequestProperty("Authorization", "Bearer " + authToken);
        connection.setRequestProperty("Content-Type", "application/json");

        int status = connection.getResponseCode();
        String body = readResponse(status >= 200 && status < 300 ? connection.getInputStream() : connection.getErrorStream());
        JSONObject json = body.isEmpty() ? new JSONObject() : new JSONObject(body);
        if (status < 200 || status >= 300) {
            String message = json.optString("error", "Request failed");
            throw new IllegalStateException(message);
        }
        return json.getString("secret");
    }

    private String readResponse(InputStream stream) throws Exception {
        if (stream == null) {
            return "";
        }

        StringBuilder result = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                result.append(line);
            }
        }
        return result.toString();
    }

    private class AlexConnectionTokenProvider implements ConnectionTokenProvider {
        @Override
        public void fetchConnectionToken(ConnectionTokenCallback callback) {
            new Thread(() -> {
                try {
                    callback.onSuccess(postEmpty(apiUrl + "/api/stripe/terminal/connection-token"));
                } catch (Exception exception) {
                    callback.onFailure(new ConnectionTokenException(exception.getMessage(), exception));
                }
            }).start();
        }
    }
}
