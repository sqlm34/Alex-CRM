package com.alex.appliancerepair;

import android.Manifest;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
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
import com.stripe.stripeterminal.external.models.CollectPaymentIntentConfiguration;
import com.stripe.stripeterminal.external.models.ConfirmPaymentIntentConfiguration;
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

@CapacitorPlugin(
    name = "StripeTerminal",
    permissions = {
        @Permission(
            alias = "location",
            strings = {
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION
            }
        )
    }
)
public class StripeTerminalPlugin extends Plugin {
    private volatile String apiUrl;
    private volatile String authToken;
    private volatile String pendingLocationId;

    @PluginMethod
    public void collectPayment(PluginCall call) {
        if (getPermissionState("location") != PermissionState.GRANTED) {
            requestPermissionForAlias("location", call, "locationPermissionCallback");
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

    private void startPayment(PluginCall call) {
        String jobId;
        try {
            apiUrl = cleanRequired(call.getString("apiUrl"), "API URL is required");
            authToken = cleanRequired(call.getString("authToken"), "Authorization token is required");
            pendingLocationId = cleanRequired(call.getString("locationId"), "Stripe Terminal location is required");
            jobId = cleanRequired(call.getString("jobId"), "Job is required");
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

        try {
            initializeTerminal();
        } catch (Exception exception) {
            call.reject(exception.getMessage());
            return;
        }

        connectReaderIfNeeded(call, () -> createPaymentIntent(call, jobId, amount, currency));
    }

    private void initializeTerminal() throws TerminalException {
        if (Terminal.isInitialized()) {
            return;
        }

        Terminal.init(
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
            },
            null
        );
    }

    private void connectReaderIfNeeded(PluginCall call, Runnable onConnected) {
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
                        call.reject("No Tap to Pay reader was found on this device.");
                        return;
                    }

                    connectDiscoveredReader(call, firstReader[0], onConnected);
                }

                @Override
                public void onFailure(TerminalException exception) {
                    call.reject(terminalError(exception));
                }
            }
        );
    }

    private void connectDiscoveredReader(PluginCall call, Reader reader, Runnable onConnected) {
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
                    call.reject(terminalError(exception));
                }
            }
        );
    }

    private void createPaymentIntent(PluginCall call, String jobId, int amount, String currency) {
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
                getActivity().runOnUiThread(() -> retrieveAndProcessPaymentIntent(call, clientSecret));
            } catch (Exception exception) {
                call.reject(exception.getMessage());
            }
        }).start();
    }

    private void retrieveAndProcessPaymentIntent(PluginCall call, String clientSecret) {
        Terminal.getInstance().retrievePaymentIntent(
            clientSecret,
            new PaymentIntentCallback() {
                @Override
                public void onSuccess(PaymentIntent paymentIntent) {
                    processPaymentIntent(call, paymentIntent);
                }

                @Override
                public void onFailure(TerminalException exception) {
                    call.reject(terminalError(exception));
                }
            }
        );
    }

    private void processPaymentIntent(PluginCall call, PaymentIntent paymentIntent) {
        Terminal.getInstance().processPaymentIntent(
            paymentIntent,
            new CollectPaymentIntentConfiguration.Builder().build(),
            new ConfirmPaymentIntentConfiguration.Builder().build(),
            new PaymentIntentCallback() {
                @Override
                public void onSuccess(PaymentIntent processedPaymentIntent) {
                    JSObject result = new JSObject();
                    result.put("paymentIntentId", processedPaymentIntent.getId());
                    result.put("status", String.valueOf(processedPaymentIntent.getStatus()));
                    result.put("amount", processedPaymentIntent.getAmount());
                    result.put("currency", processedPaymentIntent.getCurrency());
                    call.resolve(result);
                }

                @Override
                public void onFailure(TerminalException exception) {
                    call.reject(terminalError(exception));
                }
            }
        );
    }

    private boolean hasLocationPermission() {
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            || ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
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

    private String terminalError(TerminalException exception) {
        String code = exception.getErrorCode() == null ? "Stripe Terminal error" : exception.getErrorCode().toString();
        String message = exception.getErrorMessage() == null ? exception.getMessage() : exception.getErrorMessage();
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
