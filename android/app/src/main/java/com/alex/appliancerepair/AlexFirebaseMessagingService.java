package com.alex.appliancerepair;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.capacitorjs.plugins.pushnotifications.PushNotificationsPlugin;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

public class AlexFirebaseMessagingService extends FirebaseMessagingService {
    private static final String CHANNEL_ID = "alex-new-orders-v5";
    private static final String WEBSITE_CHANNEL_ID = "alex-website-orders-v1";

    @Override
    public void onMessageReceived(@NonNull RemoteMessage remoteMessage) {
        PushNotificationsPlugin.sendRemoteMessage(remoteMessage);

        Map<String, String> data = remoteMessage.getData();
        RemoteMessage.Notification notification = remoteMessage.getNotification();
        String title = firstValue(data.get("title"), notification != null ? notification.getTitle() : null, "Alex CRM updated");
        String body = firstValue(data.get("body"), notification != null ? notification.getBody() : null, "Job information changed");

        showNotification(remoteMessage, data, title, body);
    }

    @Override
    public void onNewToken(@NonNull String token) {
        PushNotificationsPlugin.onNewToken(token);
    }

    private void showNotification(RemoteMessage remoteMessage, Map<String, String> data, String title, String body) {
        boolean websiteOrder = "created".equals(data.get("event")) && "website".equals(data.get("bookingSource"));
        initializeChannels(this);

        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        intent.putExtra("google.message_id", firstValue(remoteMessage.getMessageId(), data.get("jobId"), String.valueOf(System.currentTimeMillis())));
        for (Map.Entry<String, String> entry : data.entrySet()) {
            intent.putExtra(entry.getKey(), entry.getValue());
        }

        PendingIntent pendingIntent = PendingIntent.getActivity(
            this,
            (int) (System.currentTimeMillis() % Integer.MAX_VALUE),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Bitmap largeIcon = BitmapFactory.decodeResource(getResources(), R.drawable.alex_notification_large);
        Uri soundUri = getSoundUri(this, websiteOrder);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, websiteOrder ? WEBSITE_CHANNEL_ID : CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_alex_notification)
            .setLargeIcon(largeIcon)
            .setColor(Color.parseColor("#3ACF7D"))
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setAutoCancel(true)
            .setSound(soundUri)
            .setVibrate(new long[] { 0, 250, 120, 250 })
            .setContentIntent(pendingIntent);

        NotificationManagerCompat.from(this).notify(
            (int) (System.currentTimeMillis() % Integer.MAX_VALUE),
            builder.build()
        );
    }

    public static void initializeChannels(Context context) {
        createChannel(context, false);
        createChannel(context, true);
    }

    private static void createChannel(Context context, boolean websiteOrder) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;

        String channelId = websiteOrder ? WEBSITE_CHANNEL_ID : CHANNEL_ID;
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null || manager.getNotificationChannel(channelId) != null) return;

        Uri soundUri = getSoundUri(context, websiteOrder);
        AudioAttributes audioAttributes = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();

        NotificationChannel channel = new NotificationChannel(channelId, websiteOrder ? "Website orders" : "New orders", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("Alerts when a new Alex job is created");
        channel.setSound(soundUri, audioAttributes);
        channel.enableVibration(true);
        channel.enableLights(true);
        channel.setLightColor(Color.parseColor("#3ACF7D"));

        manager.createNotificationChannel(channel);
    }

    private static Uri getSoundUri(Context context, boolean websiteOrder) {
        return Uri.parse(ContentResolver.SCHEME_ANDROID_RESOURCE + "://" + context.getPackageName() + "/raw/" + (websiteOrder ? "website_order" : "nice_melodic_sound"));
    }

    private String firstValue(String first, String second, String fallback) {
        if (first != null && !first.isEmpty()) return first;
        if (second != null && !second.isEmpty()) return second;
        return fallback;
    }
}
