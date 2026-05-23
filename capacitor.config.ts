import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.alex.appliancerepair',
  appName: 'Alex',
  webDir: 'dist',
  plugins: {
    LocalNotifications: {
      sound: 'alex_chime.wav',
      presentationOptions: ['badge', 'sound', 'banner', 'list'],
    },
  },
};

export default config;
