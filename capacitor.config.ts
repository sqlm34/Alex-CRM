import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.alex.appliancerepair',
  appName: 'Alex',
  webDir: 'dist',
  server: {
    url: 'https://aleksappliancerepair.com/?appBuild=20260901-2',
    cleartext: false,
    allowNavigation: ['aleksappliancerepair.com', 'www.aleksappliancerepair.com'],
  },
  plugins: {
    LocalNotifications: {
      sound: 'nice_melodic_sound',
      smallIcon: 'ic_stat_alex_notification',
      iconColor: '#3ACF7D',
      presentationOptions: ['badge', 'sound', 'banner', 'list'],
    },
  },
};

export default config;
