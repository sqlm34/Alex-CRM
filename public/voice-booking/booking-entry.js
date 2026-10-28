import { mountVoiceBooking } from './widget.js'

// Same widget and public configuration used by alex-repair.com/js/script.js.
mountVoiceBooking({
  endpoint: 'https://alex-crm-api.alexeasyrepair.workers.dev/api/receptionist/web/start',
  siteKey: '0x4AAAAAAEjTM8M7o8G6b16z',
})
