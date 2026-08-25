package com.alex.appliancerepair;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(StripeTerminalPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
