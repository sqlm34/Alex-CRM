package com.alex.appliancerepair;

import android.app.Application;

import com.stripe.stripeterminal.TerminalApplicationDelegate;
import com.stripe.stripeterminal.taptopay.TapToPay;

public class AlexApplication extends Application {
    @Override
    public void onCreate() {
        super.onCreate();

        if (TapToPay.isInTapToPayProcess()) {
            return;
        }

        TerminalApplicationDelegate.onCreate(this);
    }
}
