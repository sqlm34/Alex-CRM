package com.alex.appliancerepair;

import android.content.Intent;
import android.net.Uri;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "SmsComposer")
public class SmsComposerPlugin extends Plugin {
    @PluginMethod
    public void open(PluginCall call) {
        String phone = call.getString("phone", "");
        String body = call.getString("body", "");
        if (!phone.matches("\\+?[0-9]{10,15}") || body.isEmpty() || body.length() > 1000) {
            call.reject("Cannot open SMS. Invalid recipient or message.");
            return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                Intent intent = new Intent(Intent.ACTION_SENDTO, Uri.fromParts("smsto", phone, null));
                intent.putExtra("sms_body", body);
                getActivity().startActivity(intent);
                call.resolve();
            } catch (Exception error) {
                call.reject("Cannot open SMS. No SMS application is available.");
            }
        });
    }
}
