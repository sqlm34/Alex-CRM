import { Capacitor } from '@capacitor/core'
import { LocalNotifications } from '@capacitor/local-notifications'
import { PushNotifications } from '@capacitor/push-notifications'
import { registerPushToken } from './api'
import type { JobRow } from './supabase'

const newOrdersChannelId = 'alex-new-orders'
const pushSyncEventName = 'alex-push-sync'

let notificationsReady = false
let soundUnlocked = false
let pushListenersReady = false

export async function prepareOrderNotifications() {
  unlockWebChime()

  if (!Capacitor.isNativePlatform() || notificationsReady) return

  const permission = await LocalNotifications.checkPermissions()
  if (permission.display !== 'granted') {
    await LocalNotifications.requestPermissions()
  }

  await LocalNotifications.createChannel({
    id: newOrdersChannelId,
    name: 'New orders',
    description: 'Alerts when a new Alex job is created',
    importance: 5,
    visibility: 1,
    sound: 'alex_chime.wav',
    vibration: true,
    lights: true,
    lightColor: '#177245',
  })

  await prepareFirebasePush()
  notificationsReady = true
}

export async function notifyNewOrder(job: JobRow) {
  playOrderChime()

  if (!Capacitor.isNativePlatform()) return

  await prepareOrderNotifications()

  await LocalNotifications.schedule({
    notifications: [
      {
        id: Math.floor(Date.now() % 2147483647),
        title: 'New job in Alex',
        body: `${job.customer} - ${job.appliance}`,
        summaryText: job.address,
        channelId: newOrdersChannelId,
        sound: 'alex_chime.wav',
        schedule: { at: new Date(Date.now() + 250) },
      },
    ],
  })
}

export function unlockWebChime() {
  if (soundUnlocked) return
  soundUnlocked = true
  void playOrderChime(0.001)
}

async function prepareFirebasePush() {
  if (pushListenersReady) return
  pushListenersReady = true

  await PushNotifications.addListener('registration', (token) => {
    void registerPushToken(token.value, Capacitor.getPlatform()).catch(() => undefined)
  })

  await PushNotifications.addListener('registrationError', () => undefined)

  await PushNotifications.addListener('pushNotificationReceived', (notification) => {
    playOrderChime()
    window.dispatchEvent(new CustomEvent(pushSyncEventName, { detail: notification.data }))

    void LocalNotifications.schedule({
      notifications: [
        {
          id: Math.floor(Date.now() % 2147483647),
          title: notification.title || 'Alex CRM updated',
          body: notification.body || 'Job information changed',
          channelId: newOrdersChannelId,
          sound: 'alex_chime.wav',
          schedule: { at: new Date(Date.now() + 250) },
        },
      ],
    })
  })

  const pushPermission = await PushNotifications.checkPermissions()
  if (pushPermission.receive !== 'granted') {
    const requested = await PushNotifications.requestPermissions()
    if (requested.receive !== 'granted') return
  }

  await PushNotifications.register()
}

export function onPushSync(callback: () => void) {
  const listener = () => callback()
  window.addEventListener(pushSyncEventName, listener)

  return () => {
    window.removeEventListener(pushSyncEventName, listener)
  }
}

function playOrderChime(volume = 0.18) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext
  if (!AudioContextClass) return

  const context = new AudioContextClass()
  const masterGain = context.createGain()
  masterGain.gain.setValueAtTime(volume, context.currentTime)
  masterGain.connect(context.destination)

  const notes = [
    { frequency: 1318.51, start: 0, length: 0.16 },
    { frequency: 1760, start: 0.12, length: 0.18 },
    { frequency: 2093, start: 0.27, length: 0.24 },
  ]

  notes.forEach((note) => {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(note.frequency, context.currentTime + note.start)
    gain.gain.setValueAtTime(0, context.currentTime + note.start)
    gain.gain.linearRampToValueAtTime(1, context.currentTime + note.start + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + note.start + note.length)
    oscillator.connect(gain)
    gain.connect(masterGain)
    oscillator.start(context.currentTime + note.start)
    oscillator.stop(context.currentTime + note.start + note.length + 0.03)
  })

  window.setTimeout(() => void context.close(), 900)
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext
  }
}
