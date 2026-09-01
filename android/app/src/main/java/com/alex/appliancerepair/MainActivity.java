package com.alex.appliancerepair;

import android.os.Bundle;
import android.view.MotionEvent;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private float backSwipeStartX;
    private float backSwipeStartY;
    private long backSwipeStartTime;
    private boolean backSwipeHandled;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(StripeTerminalPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public boolean dispatchTouchEvent(MotionEvent event) {
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                backSwipeStartX = event.getX();
                backSwipeStartY = event.getY();
                backSwipeStartTime = System.currentTimeMillis();
                backSwipeHandled = false;
                break;
            case MotionEvent.ACTION_MOVE:
                if (!backSwipeHandled && event.getPointerCount() == 1) {
                    float deltaX = event.getX() - backSwipeStartX;
                    float deltaY = Math.abs(event.getY() - backSwipeStartY);
                    long elapsed = System.currentTimeMillis() - backSwipeStartTime;

                    if (deltaX >= dpToPx(90) && deltaY <= dpToPx(80) && elapsed <= 1200) {
                        backSwipeHandled = true;
                        emitBackSwipeToWeb();
                        return true;
                    }
                }
                break;
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                backSwipeHandled = false;
                break;
            default:
                break;
        }

        return super.dispatchTouchEvent(event);
    }

    private void emitBackSwipeToWeb() {
        if (bridge == null || bridge.getWebView() == null) {
            return;
        }

        WebView webView = bridge.getWebView();
        webView.post(() -> webView.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('alexNativeBackSwipe'))",
            null
        ));
    }

    private float dpToPx(float dp) {
        return dp * getResources().getDisplayMetrics().density;
    }
}
