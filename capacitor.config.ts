import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.alex.appliancerepair',
  appName: 'Alex',
  webDir: 'dist',
  server: {
    url: 'https://aleksappliancerepair.com',
    cleartext: false,
  },
  plugins: {
    LocalNotifications: {
      sound: 'alex_chime',
      smallIcon: 'ic_stat_alex_notification',
      iconColor: '#3ACF7D',
      presentationOptions: ['badge', 'sound', 'banner', 'list'],
    },
  },
};

export default config;
