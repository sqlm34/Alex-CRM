import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.alex.appliancerepair',
  appName: 'Alex',
  webDir: 'dist',
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
