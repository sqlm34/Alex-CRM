import { Autocomplete, useJsApiLoader } from '@react-google-maps/api'
import { App as CapacitorApp } from '@capacitor/app'
import { Capacitor, registerPlugin } from '@capacitor/core'
import {
  ArrowLeft,
  CalendarDays,
  CalendarPlus,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  CreditCard,
  LogOut,
  Mail,
  MapPin,
  MessageSquare,
  Paperclip,
  Phone,
  PlayCircle,
  Plus,
  Power,
  Search,
  Send,
  Settings,
  Smartphone,
  Tag,
  Trash2,
  Truck,
  Upload,
  UserPlus,
  UserRound,
  UsersRound,
  Wrench,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, FormEvent, SetStateAction } from 'react'
import './App.css'
import {
  addApprovedUser,
  configuredApiUrl,
  createPublicBooking,
  fetchBookingConfig,
  fetchBookingAvailability,
  fetchCurrentUser,
  fetchApprovedUsers,
  fetchAvailabilityBlocks,
  fetchStripeTerminalConfig,
  fetchJobsFromApi,
  isApiConfigured,
  loginWithGoogle,
  loginWithPassword,
  requestSmsLogin,
  registerWithPassword,
  deleteJobFromApi,
  deleteAvailabilityBlock,
  saveJobToApi,
  saveAvailabilityBlock,
  sendInvoiceEmail,
  sendHeartbeat,
  sendOffline,
  sendPublicBookingOtp,
  startPublicBooking,
  updateJobInApi,
  verifyPublicBookingOtp,
  verifySmsCode,
} from './api'
import type { ApprovedUser, AuthLoginResponse, AuthSession, AvailabilityBlock, PendingApprovalResponse, TwoFactorChallenge } from './api'
import { notifyNewOrder, onPushSync, prepareOrderNotifications, unlockWebChime } from './notifications'
import { isSupabaseConfigured, supabase } from './supabase'
import type { JobRow } from './supabase'

type JobStatus = 'new' | 'scheduled' | 'in_progress' | 'complete' | 'canceled'
type Page = 'dashboard' | 'schedule' | 'clients' | 'clientEdit' | 'job' | 'new' | 'owner'
type Toast = {
  id: number
  message: string
  detail?: string
  type: 'success' | 'error'
}
type AuthMode = 'login' | 'register'
type AuthFormState = {
  name: string
  email: string
  password: string
  phone: string
}

type WebOtpCredential = Credential & {
  code?: string
}

type WebOtpCredentialRequestOptions = CredentialRequestOptions & {
  otp: {
    transport: ['sms']
  }
}

type TwoFactorState = TwoFactorChallenge & {
  email: string
}

type Job = {
  id: string
  createdAt?: string
  customer: string
  phone: string
  email: string
  address: string
  appliance: string
  issue: string
  date: string
  window: string
  status: JobStatus
  invoice: number
  paid: boolean
  financeItems: FinanceItem[]
  payments: PaymentEntry[]
  modelPhotoAttachments?: ModelPhotoAttachment[]
  lat: number
  lng: number
  createdByUserId?: string | null
  technicianName?: string | null
  technicianEmail?: string | null
}

type FinanceItem = {
  id: string
  label: string
  amount: number
}

type PaymentEntry = {
  id: string
  amount: number
  createdAt: string
  method?: string
  paymentIntentId?: string
  status?: string
}

type ModelPhotoAttachment = {
  filename: string
  contentType: string
  content: string
  size: number
}

type StripeTerminalPlugin = {
  enableBluetooth(): Promise<{ enabled: boolean }>
  collectPayment(options: {
    apiUrl: string
    authToken: string
    jobId: string
    amount: number
    currency: string
    locationId: string
  }): Promise<{ paymentIntentId?: string; status?: string; amount?: number; currency?: string }>
}

const StripeTerminal = registerPlugin<StripeTerminalPlugin>('StripeTerminal')

type FormState = Omit<Job, 'id' | 'status' | 'invoice' | 'paid' | 'financeItems' | 'payments' | 'lat' | 'lng'>

const googleLibraries: 'places'[] = ['places']
const googleMapsKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined
const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined

const statusLabels: Record<JobStatus, string> = {
  new: 'New lead',
  scheduled: 'Scheduled',
  in_progress: 'On site',
  complete: 'Done',
  canceled: 'Canceled',
}

const bookingServices = ['Dryer repair', 'Washer repair', 'Dishwasher repair', 'Oven repair', 'Refrigerator repair']
const bookingWindows = ['9:00 AM - 11:00 AM', '11:00 AM - 1:00 PM', '1:00 PM - 3:00 PM', '3:00 PM - 5:00 PM']
const bookingSteps = ['Service', 'Schedule', 'Details', 'Summary']

const starterJobs: Job[] = [
  {
    id: 'J-1042',
    customer: 'Maria Johnson',
    phone: '317-555-0148',
    email: '',
    address: '350 Massachusetts Ave, Indianapolis, IN',
    appliance: 'Samsung refrigerator',
    issue: 'Not cooling, freezer works sometimes',
    date: '2026-05-23',
    window: '9:00 AM - 11:00 AM',
    status: 'scheduled',
    invoice: 189,
    paid: false,
    financeItems: defaultFinanceItems(189),
    payments: [],
    lat: 39.7716,
    lng: -86.1539,
  },
  {
    id: 'J-1043',
    customer: 'David Smith',
    phone: '317-555-0199',
    email: '',
    address: '110 W Washington St, Indianapolis, IN',
    appliance: 'LG washer',
    issue: 'Drain pump noise and leak',
    date: '2026-05-23',
    window: '1:00 PM - 3:00 PM',
    status: 'in_progress',
    invoice: 245,
    paid: false,
    financeItems: defaultFinanceItems(245),
    payments: [],
    lat: 39.7672,
    lng: -86.1606,
  },
  {
    id: 'J-1044',
    customer: 'Angela Brown',
    phone: '317-555-0120',
    email: '',
    address: '401 E Michigan St, Indianapolis, IN',
    appliance: 'Whirlpool dryer',
    issue: 'No heat, drum turns',
    date: '2026-05-24',
    window: '9:00 AM - 11:00 AM',
    status: 'new',
    invoice: 0,
    paid: false,
    financeItems: defaultFinanceItems(0),
    payments: [],
    lat: 39.7739,
    lng: -86.1499,
  },
]

const emptyForm: FormState = {
  customer: '',
  phone: '',
  email: '',
  address: '',
  appliance: '',
  issue: '',
  date: formatLocalDate(),
  window: '9:00 AM - 11:00 AM',
}
const emptyAuthForm: AuthFormState = {
  name: '',
  email: '',
  password: '',
  phone: '',
}

function App() {
  const [auth, setAuth] = useStoredAuth()
  const authToken = auth?.token
  const isNativeApp = Capacitor.isNativePlatform()
  const [jobs, setJobs] = useStoredJobs(authToken)
  const [activeId, setActiveId] = useState(jobs[0]?.id ?? '')
  const [page, setPage] = useState<Page>('dashboard')
  const [query, setQuery] = useState('')
  const [form, setForm] = useState<FormState>(emptyForm)
  const [toast, setToast] = useState<Toast | null>(null)
  const [paymentBusyId, setPaymentBusyId] = useState<string | null>(null)
  const [selectedCoords, setSelectedCoords] = useState({ lat: 39.7684, lng: -86.1581 })
  const [technicians, setTechnicians] = useState<ApprovedUser[]>([])
  const [availabilityBlocks, setAvailabilityBlocks] = useState<AvailabilityBlock[]>([])
  const [timeOffOpen, setTimeOffOpen] = useState(false)
  const autocompleteRef = useRef<google.maps.places.Autocomplete | null>(null)
  const knownJobIdsRef = useRef(new Set(jobs.map((job) => job.id)))
  const dirtyJobIdsRef = useRef(new Set<string>())
  const emailSaveTimersRef = useRef(new Map<string, number>())
  const toastTimerRef = useRef<number | null>(null)
  const backSwipeStartRef = useRef<{ x: number; y: number; time: number; handled: boolean } | null>(null)

  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: googleMapsKey || 'missing-key',
    libraries: googleLibraries,
    preventGoogleFontsLoading: true,
  })

  const todayDate = useMemo(() => formatLocalDate(), [])
  const todayLabel = useMemo(
    () =>
      new Intl.DateTimeFormat('en-US', {
        day: 'numeric',
        month: 'short',
      }).format(new Date()),
    [],
  )
  const filteredJobs = useMemo(() => {
    const search = query.trim().toLowerCase()
    if (!search) return jobs

    return jobs.filter((job) => matchesJobSearch(job, search))
  }, [jobs, query])

  const scheduledJobs = useMemo(() => filteredJobs.filter(isActiveScheduleJob), [filteredJobs])
  const scheduleGroups = useMemo(() => groupJobsByScheduleDate(scheduledJobs), [scheduledJobs])

  const activeJob = jobs.find((job) => job.id === activeId) ?? jobs[0]
  const orderNumbers = useMemo(() => createOrderNumbers(jobs), [jobs])
  const activeOrderNumber = activeJob ? orderNumbers.get(activeJob.id) || formatOrderNumber(1) : ''
  const isBookingPage = window.location.pathname.replace(/\/+$/, '') === '/booking'
  const canAssignTechnicians = auth?.user.role === 'owner'
  const goBackToJobs = useCallback(() => {
    setPage('dashboard')
  }, [])

  useEffect(() => {
    const enabled = !isBookingPage && page !== 'dashboard'

    const handleNativeBackSwipe = () => {
      if (!enabled) return
      goBackToJobs()
    }

    const handleTouchStart = (event: TouchEvent) => {
      if (!enabled) return
      if (event.touches.length !== 1) return
      if (isTextEditingSwipeTarget(event.target)) return

      const touch = event.touches[0]
      backSwipeStartRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now(), handled: false }
    }

    const handleTouchMove = (event: TouchEvent) => {
      const start = backSwipeStartRef.current
      if (!enabled || !start) return
      if (start.handled) return

      const touch = event.touches[0]
      if (!touch) return

      const deltaX = touch.clientX - start.x
      const deltaY = Math.abs(touch.clientY - start.y)
      const elapsed = Date.now() - start.time
      if (deltaX >= 90 && deltaY <= 80 && elapsed <= 1200) {
        start.handled = true
        event.preventDefault()
        goBackToJobs()
      }
    }

    const clearTouchStart = () => {
      backSwipeStartRef.current = null
    }

    const handlePointerStart = (event: PointerEvent) => {
      if (!enabled) return
      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return
      if (isTextEditingSwipeTarget(event.target)) return
      backSwipeStartRef.current = { x: event.clientX, y: event.clientY, time: Date.now(), handled: false }
    }

    const handlePointerMove = (event: PointerEvent) => {
      const start = backSwipeStartRef.current
      if (!enabled || !start || start.handled) return

      const deltaX = event.clientX - start.x
      const deltaY = Math.abs(event.clientY - start.y)
      const elapsed = Date.now() - start.time
      if (deltaX >= 90 && deltaY <= 80 && elapsed <= 1200) {
        start.handled = true
        event.preventDefault()
        goBackToJobs()
      }
    }

    document.addEventListener('touchstart', handleTouchStart, { capture: true, passive: true })
    document.addEventListener('touchmove', handleTouchMove, { capture: true, passive: false })
    document.addEventListener('touchend', clearTouchStart, { capture: true, passive: true })
    document.addEventListener('touchcancel', clearTouchStart, { capture: true, passive: true })
    document.addEventListener('pointerdown', handlePointerStart, { capture: true, passive: true })
    document.addEventListener('pointermove', handlePointerMove, { capture: true, passive: false })
    document.addEventListener('pointerup', clearTouchStart, { capture: true, passive: true })
    document.addEventListener('pointercancel', clearTouchStart, { capture: true, passive: true })
    window.addEventListener('alexNativeBackSwipe', handleNativeBackSwipe)

    return () => {
      document.removeEventListener('touchstart', handleTouchStart, { capture: true })
      document.removeEventListener('touchmove', handleTouchMove, { capture: true })
      document.removeEventListener('touchend', clearTouchStart, { capture: true })
      document.removeEventListener('touchcancel', clearTouchStart, { capture: true })
      document.removeEventListener('pointerdown', handlePointerStart, { capture: true })
      document.removeEventListener('pointermove', handlePointerMove, { capture: true })
      document.removeEventListener('pointerup', clearTouchStart, { capture: true })
      document.removeEventListener('pointercancel', clearTouchStart, { capture: true })
      window.removeEventListener('alexNativeBackSwipe', handleNativeBackSwipe)
    }
  }, [goBackToJobs, isBookingPage, page])

  useEffect(() => {
    if (!authToken || !canAssignTechnicians) {
      setTechnicians([])
      return
    }

    let ignore = false
    const token = authToken

    async function loadTechnicians() {
      try {
        const rows = await fetchApprovedUsers(token)
        if (!ignore) {
          setTechnicians(
            rows.filter((user) => user.role === 'technician' && user.approved !== false && Boolean(user.user_id)),
          )
        }
      } catch {
        if (!ignore) setTechnicians([])
      }
    }

    void loadTechnicians()
    const refreshTimer = window.setInterval(() => {
      void loadTechnicians()
    }, 10000)

    return () => {
      ignore = true
      window.clearInterval(refreshTimer)
    }
  }, [authToken, canAssignTechnicians])

  const loadAvailabilityBlocks = useCallback(() => {
    if (!authToken || !canAssignTechnicians) {
      setAvailabilityBlocks([])
      return
    }

    void fetchAvailabilityBlocks(authToken)
      .then((blocks) => setAvailabilityBlocks(blocks))
      .catch(() => undefined)
  }, [authToken, canAssignTechnicians])

  useEffect(() => {
    loadAvailabilityBlocks()
  }, [loadAvailabilityBlocks])

  const markOffline = useCallback((token?: string, options: { beacon?: boolean } = {}) => {
    if (!token || !isApiConfigured) return
    void sendOffline(token, options).catch(() => undefined)
  }, [])

  const signOut = useCallback(() => {
    markOffline(authToken, { beacon: false })
    setAuth(null)
    setJobs([])
    setActiveId('')
    setPage('dashboard')
  }, [authToken, markOffline, setAuth, setJobs])

  const exitApp = useCallback(() => {
    if (!Capacitor.isNativePlatform()) return
    const token = authToken
    if (!token || !isApiConfigured) {
      void CapacitorApp.exitApp()
      return
    }

    void sendOffline(token, { beacon: false })
      .catch(() => undefined)
      .finally(() => {
        void CapacitorApp.exitApp()
      })
  }, [authToken])

  const showToast = useCallback((toastMessage: Omit<Toast, 'id'>) => {
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current)
    }

    setToast({ ...toastMessage, id: Date.now() })
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null)
      toastTimerRef.current = null
    }, toastMessage.type === 'error' ? 6500 : 4200)
  }, [])

  const handleAuthSuccess = useCallback(
    (session: AuthSession) => {
      setAuth(session)
      showToast({
        type: 'success',
        message: 'Signed in',
        detail: session.user.email,
      })
    },
    [setAuth, showToast],
  )

  const syncJobs = useCallback(
    async ({ notifyNew = false }: { notifyNew?: boolean } = {}) => {
      if (!isApiConfigured) return
      if (!authToken) return

      const data = await fetchJobsFromApi(authToken)
      if (!data) return

      const knownIds = knownJobIdsRef.current
      const newRows = notifyNew ? data.filter((row) => !knownIds.has(row.id)) : []

      const remoteJobs = data.map(rowToJob)
      setJobs((current) => {
        const localById = new Map(current.map((job) => [job.id, job]))
        return remoteJobs.map((job) => (dirtyJobIdsRef.current.has(job.id) ? localById.get(job.id) || job : job))
      })
      knownJobIdsRef.current = new Set(data.map((row) => row.id))

      for (const row of newRows.reverse()) {
        await notifyNewOrder(row).catch(() => undefined)
        showToast({
          type: 'success',
          message: 'New order created',
          detail: `${row.customer} - ${row.appliance}`,
        })
      }
    },
    [authToken, setJobs, showToast],
  )

  useEffect(() => {
    if (!jobs.some((job) => job.id === activeId)) {
      setActiveId(jobs[0]?.id ?? '')
    }
  }, [activeId, jobs])

  useEffect(() => {
    knownJobIdsRef.current = new Set(jobs.map((job) => job.id))
  }, [jobs])

  useEffect(() => {
    if (isApiConfigured && !authToken) return
    void prepareOrderNotifications(authToken).catch(() => undefined)
  }, [authToken])

  useEffect(() => {
    if (!isApiConfigured || !authToken) return

    void sendHeartbeat(authToken).catch(() => undefined)
    const heartbeatTimer = window.setInterval(() => {
      void sendHeartbeat(authToken).catch(() => undefined)
    }, 5000)

    const handleOffline = () => markOffline(authToken, { beacon: true })
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        markOffline(authToken, { beacon: !Capacitor.isNativePlatform() })
      } else {
        void sendHeartbeat(authToken).catch(() => undefined)
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('pagehide', handleOffline)
    window.addEventListener('beforeunload', handleOffline)

    let appStateListener: { remove: () => Promise<void> } | undefined
    if (Capacitor.isNativePlatform()) {
      void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
        if (isActive) {
          void sendHeartbeat(authToken).catch(() => undefined)
        } else {
          markOffline(authToken, { beacon: false })
        }
      }).then((listener) => {
        appStateListener = listener
      })
    }

    return () => {
      window.clearInterval(heartbeatTimer)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('pagehide', handleOffline)
      window.removeEventListener('beforeunload', handleOffline)
      void appStateListener?.remove()
    }
  }, [authToken, markOffline])

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current)
      }
      emailSaveTimersRef.current.forEach((timer) => window.clearTimeout(timer))
      emailSaveTimersRef.current.clear()
    }
  }, [])

  useEffect(() => {
    if (!isApiConfigured) return
    if (!authToken) return

    let stopped = false
    let inFlight = false

    async function checkForNewJobs(notifyNew = true) {
      if (stopped || inFlight || document.visibilityState === 'hidden') return
      inFlight = true

      try {
        await syncJobs({ notifyNew })
      } finally {
        inFlight = false
      }
    }

    const syncNow = (notifyNew = true) => {
      void checkForNewJobs(notifyNew).catch(() => undefined)
    }

    const syncFromPush = (detail?: { event?: string; title?: string; body?: string }) => {
      if (detail?.event === 'deleted') {
        showToast({
          type: 'success',
          message: detail.title || 'Order deleted',
          detail: detail.body,
        })
      }

      void syncJobs().catch(() => undefined)
    }

    syncNow(false)

    const timer = window.setInterval(() => {
      syncNow()
    }, 2500)

    const syncOnResume = () => {
      void syncJobs().catch(() => undefined)
    }

    const unsubscribePushSync = onPushSync(syncFromPush)
    window.addEventListener('focus', syncOnResume)
    window.addEventListener('online', syncOnResume)
    document.addEventListener('visibilitychange', syncOnResume)

    return () => {
      stopped = true
      window.clearInterval(timer)
      unsubscribePushSync()
      window.removeEventListener('focus', syncOnResume)
      window.removeEventListener('online', syncOnResume)
      document.removeEventListener('visibilitychange', syncOnResume)
    }
  }, [authToken, showToast, syncJobs])

  useEffect(() => {
    if (!isApiConfigured || !authToken) return

    let ignore = false
    const token = authToken

    async function loadProfile() {
      try {
        const user = await fetchCurrentUser(token)
        if (!ignore && user) setAuth((current) => (current ? { ...current, user } : current))
      } catch {
        if (!ignore) signOut()
      }
    }

    void loadProfile()

    return () => {
      ignore = true
    }
  }, [authToken, setAuth, signOut])

  const updateStatus = (id: string, status: JobStatus) => {
    setJobs((current) => current.map((job) => (job.id === id ? { ...job, status } : job)))
    void syncJobPatch(id, { status }, authToken).catch((error) => {
      showToast({
        type: 'error',
        message: 'Unable to update status',
        detail: errorMessage(error),
      })
    })
  }

  const collectPayment = (id: string, amountDollars: number) => {
    const job = jobs.find((currentJob) => currentJob.id === id)
    if (!job) return

    const amount = Math.round(Number(amountDollars || 0) * 100)
    if (amount < 50) {
      showToast({
        type: 'error',
        message: 'Enter payment amount',
        detail: 'Payment amount must be at least $0.50 before collecting.',
      })
      return
    }

    const currentBalance = jobBalance(job)
    if (currentBalance > 0 && amountDollars - currentBalance > 0.005) {
      showToast({
        type: 'error',
        message: 'Payment is too high',
        detail: 'Payment amount cannot be higher than the order balance.',
      })
      return
    }

    if (!isNativeApp) {
      addManualPayment(id, amountDollars)
      return
    }

    if (!configuredApiUrl || !authToken) {
      showToast({
        type: 'error',
        message: 'Stripe payment is not ready',
        detail: 'API session is missing. Please sign in again.',
      })
      return
    }

    const apiUrl = configuredApiUrl
    let completedJob: Job | null = null
    setPaymentBusyId(id)
    void StripeTerminal.enableBluetooth()
      .then((result) => {
        if (!result.enabled) throw new Error('Bluetooth is required for Tap to Pay.')
        showToast({
          type: 'success',
          message: 'Tap to Pay is connecting',
          detail: 'Stripe is preparing the phone reader.',
        })
        return fetchStripeTerminalConfig(authToken)
      })
      .then((config) => {
        if (!config.ready || !config.locationId) {
          throw new Error('Stripe Terminal is not configured yet')
        }

        return StripeTerminal.collectPayment({
          apiUrl,
          authToken,
          jobId: id,
          amount,
          currency: config.currency || 'usd',
          locationId: config.locationId,
        })
      })
      .then((result) => {
        const paidJob = appendPayment(job, amountDollars, {
          method: 'Tap to Pay',
          paymentIntentId: result.paymentIntentId,
          status: result.status,
        })
        completedJob = paidJob

        setJobs((current) => current.map((currentJob) => (currentJob.id === id ? paidJob : currentJob)))
        return syncJobPatch(id, {
          invoice: paidJob.invoice,
          finance_items: paidJob.financeItems,
          paid: paidJob.paid,
          payments: paidJob.payments,
        }, authToken)
      })
      .then(() => {
        showToast({
          type: 'success',
          message: 'Payment collected',
          detail: `${job.customer} - ${formatMoney(amountDollars)}`,
        })
        if (completedJob) askToSendInvoice(completedJob)
      })
      .catch((error) => {
        showToast({
          type: 'error',
          message: 'Unable to collect payment',
          detail: errorMessage(error),
        })
      })
      .finally(() => setPaymentBusyId(null))
  }

  const addManualPayment = (id: string, amountDollars: number) => {
    const job = jobs.find((currentJob) => currentJob.id === id)
    if (!job) return

    const paidJob = appendPayment(job, amountDollars, { method: 'Manual' })
    setJobs((current) => current.map((currentJob) => (currentJob.id === id ? paidJob : currentJob)))
    void syncJobPatch(id, {
      invoice: paidJob.invoice,
      finance_items: paidJob.financeItems,
      paid: paidJob.paid,
      payments: paidJob.payments,
    }, authToken)
      .then(() => {
        showToast({
          type: 'success',
          message: 'Payment added',
          detail: `${job.customer} - ${formatMoney(amountDollars)}`,
        })
        askToSendInvoice(paidJob)
      })
      .catch((error) => {
        showToast({
          type: 'error',
          message: 'Unable to save payment',
          detail: errorMessage(error),
        })
      })
  }

  const askToSendInvoice = (job: Job) => {
    if (!job.email) {
      showToast({
        type: 'error',
        message: 'Client email is missing',
        detail: 'Add client email to send the invoice.',
      })
      return
    }

    const shouldSend = window.confirm(`Send invoice to ${job.email}?`)
    if (!shouldSend) return
    sendInvoice(job.id)
  }

  const sendInvoice = (id: string) => {
    const job = jobs.find((currentJob) => currentJob.id === id)
    if (!job) return

    if (!job.email) {
      showToast({
        type: 'error',
        message: 'Client email is missing',
        detail: 'Open Clients and add the customer email address.',
      })
      return
    }

    void sendInvoiceEmail(id, authToken)
      .then(() => {
        showToast({
          type: 'success',
          message: 'Invoice sent',
          detail: job.email,
        })
      })
      .catch((error) => {
        showToast({
          type: 'error',
          message: 'Unable to send invoice',
          detail: errorMessage(error),
        })
      })
  }

  const enableTapToPayBluetooth = () => {
    if (!isNativeApp) {
      showToast({
        type: 'error',
        message: 'Bluetooth is only needed on Android',
        detail: 'Open the Android app to use Stripe Tap to Pay.',
      })
      return
    }

    void StripeTerminal.enableBluetooth()
      .then((result) => {
        showToast({
          type: result.enabled ? 'success' : 'error',
          message: result.enabled ? 'Tap to Pay is connecting' : 'Bluetooth denied',
          detail: result.enabled ? 'Bluetooth is ready for Stripe Tap to Pay.' : 'Allow Bluetooth to collect card payments.',
        })
      })
      .catch((error) => {
        showToast({
          type: 'error',
          message: 'Bluetooth is not ready',
          detail: errorMessage(error),
        })
      })
  }

  const updateFinanceItems = (id: string, financeItems: FinanceItem[]) => {
    const invoice = financeTotal(financeItems)
    setJobs((current) =>
      current.map((job) => {
        if (job.id !== id) return job
        const nextJob = { ...job, financeItems, invoice, paid: jobPaymentsTotal(job.payments) >= invoice && invoice > 0 }
        return nextJob
      }),
    )

    void syncJobPatch(id, { finance_items: financeItems, invoice }, authToken).catch((error) => {
      showToast({
        type: 'error',
        message: 'Unable to save finance',
        detail: errorMessage(error),
      })
    })
  }

  const createInvoice = (id: string) => {
    const job = jobs.find((currentJob) => currentJob.id === id)
    if (!job) return

    const invoice = jobTotal(job)
    const paid = invoice > 0 && jobPaymentsTotal(job.payments) >= invoice
    setJobs((current) => current.map((currentJob) => (currentJob.id === id ? { ...currentJob, invoice, paid } : currentJob)))
    void syncJobPatch(id, { invoice, paid, finance_items: job.financeItems }, authToken)
      .then(() => {
        showToast({
          type: 'success',
          message: 'Invoice created',
          detail: `${job.customer} - ${formatMoney(invoice)}`,
        })
      })
      .catch((error) => {
        showToast({
          type: 'error',
          message: 'Unable to create invoice',
          detail: errorMessage(error),
        })
      })
  }

  const togglePaid = (id: string) => {
    const job = jobs.find((currentJob) => currentJob.id === id)
    if (!job) return

    if (job.paid) {
      const nextJob = { ...job, paid: false, payments: [] }
      setJobs((current) => current.map((currentJob) => (currentJob.id === id ? nextJob : currentJob)))
      void syncJobPatch(id, { paid: false, payments: [] }, authToken).catch((error) => {
        showToast({
          type: 'error',
          message: 'Unable to update payment',
          detail: errorMessage(error),
        })
      })
      return
    }

    collectPayment(id, jobBalance(job))
  }

  const updateClientField = (id: string, field: 'customer' | 'phone' | 'email' | 'address', value: string) => {
    dirtyJobIdsRef.current.add(id)
    setJobs((current) => current.map((job) => (job.id === id ? { ...job, [field]: value } : job)))
    if (field === 'email') {
      const existingTimer = emailSaveTimersRef.current.get(id)
      if (existingTimer) window.clearTimeout(existingTimer)

      const nextTimer = window.setTimeout(() => {
        emailSaveTimersRef.current.delete(id)
        void syncJobPatch(id, { email: value }, authToken)
          .then(() => {
            dirtyJobIdsRef.current.delete(id)
          })
          .catch((error) => {
            showToast({
              type: 'error',
              message: 'Unable to save email',
              detail: errorMessage(error),
            })
          })
      }, 450)
      emailSaveTimersRef.current.set(id, nextTimer)
    }
  }

  const updateJobSchedule = (id: string, date: string, window: string) => {
    const previousJob = jobs.find((currentJob) => currentJob.id === id)
    if (!previousJob) return Promise.resolve(false)
    const nextDate = normalizeBookingDateValue(date)
    const nextWindow = normalizeServiceWindowValue(window)
    if (!nextDate || !bookingWindows.includes(nextWindow)) return Promise.resolve(false)
    if (previousJob.date === nextDate && normalizeServiceWindowValue(previousJob.window) === nextWindow) return Promise.resolve(true)

    const nextJob = { ...previousJob, date: nextDate, window: nextWindow }
    dirtyJobIdsRef.current.add(id)
    setJobs((current) => current.map((job) => (job.id === id ? nextJob : job)))

    return syncJobPatch(id, { service_date: nextDate, service_window: nextWindow }, authToken)
      .then((savedRow) => {
        const savedJob = savedRow ? rowToJob(savedRow) : nextJob
        if (savedJob.date !== nextDate || normalizeServiceWindowValue(savedJob.window) !== nextWindow) {
          dirtyJobIdsRef.current.delete(id)
          setJobs((current) => current.map((job) => (job.id === id ? previousJob : job)))
          showToast({
            type: 'error',
            message: 'Schedule was not saved',
            detail: 'The server returned a different appointment time. Please try again.',
          })
          return false
        }

        dirtyJobIdsRef.current.delete(id)
        setJobs((current) => current.map((job) => (job.id === id ? savedJob : job)))
        void syncJobs()
        showToast({
          type: 'success',
          message: 'Schedule updated',
          detail: formatJobScheduleLine(savedJob.date, savedJob.window),
        })
        return true
      })
      .catch((error) => {
        dirtyJobIdsRef.current.delete(id)
        setJobs((current) => current.map((job) => (job.id === id ? previousJob : job)))
        showToast({
          type: 'error',
          message: 'Unable to update schedule',
          detail: errorMessage(error),
        })
        return false
      })
  }

  const addJobAttachments = (id: string, files: File[]) => {
    const previousJob = jobs.find((currentJob) => currentJob.id === id)
    if (!previousJob || !files.length) return

    void filesToModelPhotoAttachments(files)
      .then((newAttachments) => {
        const attachments = [...normalizeModelPhotoAttachments(previousJob.modelPhotoAttachments || []), ...newAttachments].slice(0, 8)
        const nextJob = { ...previousJob, modelPhotoAttachments: attachments }
        setJobs((current) => current.map((job) => (job.id === id ? nextJob : job)))

        return syncJobPatch(id, { model_photo_attachments: attachments }, authToken)
      })
      .then(() => {
        showToast({
          type: 'success',
          message: 'Attachment added',
          detail: `${files.length} file${files.length === 1 ? '' : 's'} saved`,
        })
      })
      .catch((error) => {
        showToast({
          type: 'error',
          message: 'Unable to save attachment',
          detail: errorMessage(error),
        })
      })
  }

  const saveTimeOff = (date: string, allDay: boolean, windows: string[], reason: string) => {
    void saveAvailabilityBlock({ blocked_date: date, all_day: allDay, service_windows: windows, reason }, authToken)
      .then(() => {
        loadAvailabilityBlocks()
        setTimeOffOpen(false)
        showToast({
          type: 'success',
          message: 'Time off saved',
          detail: allDay ? `${formatDisplayDate(date)} all day` : `${formatDisplayDate(date)} ${windows.length} slot${windows.length === 1 ? '' : 's'}`,
        })
      })
      .catch((error) => {
        showToast({
          type: 'error',
          message: 'Unable to save time off',
          detail: errorMessage(error),
        })
      })
  }

  const removeTimeOff = (id: string) => {
    void deleteAvailabilityBlock(id, authToken)
      .then(() => {
        setAvailabilityBlocks((current) => current.filter((block) => block.id !== id))
        showToast({
          type: 'success',
          message: 'Time off removed',
        })
      })
      .catch((error) => {
        showToast({
          type: 'error',
          message: 'Unable to remove time off',
          detail: errorMessage(error),
        })
      })
  }

  const saveClient = (id: string) => {
    const job = jobs.find((currentJob) => currentJob.id === id)
    if (!job) return

    void syncJobPatch(id, {
      customer: job.customer,
      phone: job.phone,
      email: job.email,
      address: job.address,
    }, authToken)
      .then(() => {
        dirtyJobIdsRef.current.delete(id)
        showToast({
          type: 'success',
          message: 'Client saved',
          detail: `${job.customer} updated`,
        })
      })
      .catch((error) => {
        showToast({
          type: 'error',
          message: 'Unable to save client',
          detail: errorMessage(error),
        })
    })
  }

  const assignTechnician = (id: string, technicianUserId: string) => {
    if (!canAssignTechnicians) return

    const previousJob = jobs.find((currentJob) => currentJob.id === id)
    if (!previousJob) return

    const technician = technicians.find((user) => user.user_id === technicianUserId)
    const nextJob = {
      ...previousJob,
      createdByUserId: technicianUserId || null,
      technicianName: technician?.name || null,
      technicianEmail: technician?.email || null,
    }

    setJobs((current) => current.map((job) => (job.id === id ? nextJob : job)))

    void syncJobPatch(id, { created_by_user_id: technicianUserId || null }, authToken)
      .then(() => {
        showToast({
          type: 'success',
          message: technician ? 'Technician assigned' : 'Technician removed',
          detail: technician ? `${previousJob.customer} -> ${technician.name || technician.email}` : previousJob.customer,
        })
      })
      .catch((error) => {
        setJobs((current) => current.map((job) => (job.id === id ? previousJob : job)))
        showToast({
          type: 'error',
          message: 'Unable to assign technician',
          detail: errorMessage(error),
        })
      })
  }

  const openClient = (id: string) => {
    setActiveId(id)
    setPage('clientEdit')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const deleteOrder = (id: string) => {
    const job = jobs.find((currentJob) => currentJob.id === id)
    if (!job) return

    const shouldDelete = window.confirm(`Delete ORDER# ${orderNumbers.get(job.id) || formatOrderNumber(1)} for ${job.customer}?`)
    if (!shouldDelete) return

    setJobs((current) => current.filter((currentJob) => currentJob.id !== id))
    setActiveId((current) => {
      if (current !== id) return current
      const nextJob = jobs.find((currentJob) => currentJob.id !== id)
      return nextJob?.id ?? ''
    })
    setPage('dashboard')

    void deleteJob(id, authToken, activeOrderNumber)
      .then(() => {
        showToast({
          type: 'success',
          message: `ORDER# ${activeOrderNumber} deleted`,
          detail: `${job.customer} removed`,
        })
      })
      .catch((error) => {
        setJobs((current) => [job, ...current])
        setActiveId(id)
        setPage('job')
        showToast({
          type: 'error',
          message: 'Unable to delete order',
          detail: errorMessage(error),
        })
      })
  }

  const addJob = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form.customer || !form.phone || !form.address || !form.appliance) return

    const nextJob: Job = {
      ...form,
      id: createJobId(),
      status: 'new',
      invoice: 0,
      paid: false,
      financeItems: defaultFinanceItems(0),
      payments: [],
      lat: selectedCoords.lat,
      lng: selectedCoords.lng,
    }

    const orderNumber = formatOrderNumber(jobs.length + 1)
    setJobs((current) => [nextJob, ...current])
    setQuery('')
    void saveJob(nextJob, authToken)
      .then((savedRow) => {
        showToast({
          type: 'success',
          message: `ORDER# ${orderNumber} created`,
          detail: `${nextJob.customer} - ${nextJob.appliance}`,
        })

        if (!savedRow || savedRow.id === nextJob.id) return

        const savedJob = rowToJob(savedRow)
        setJobs((current) => current.map((job) => (job.id === nextJob.id ? savedJob : job)))
        setActiveId(savedJob.id)
      })
      .catch((error) => {
        showToast({
          type: 'error',
          message: 'Unable to create order',
          detail: errorMessage(error),
        })
      })
    setActiveId(nextJob.id)
    setPage('job')
    setForm(emptyForm)
  }

  const handlePlaceChanged = () => {
    const place = autocompleteRef.current?.getPlace()
    if (!place) return

    const address = place.formatted_address || place.name || form.address
    const location = place.geometry?.location
    setForm((current) => ({ ...current, address }))

    if (location) {
      setSelectedCoords({ lat: location.lat(), lng: location.lng() })
    }
  }

  const openJob = (id: string) => {
    setActiveId(id)
    setPage('job')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const openNewJob = () => {
    unlockWebChime()
    setPage('new')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const showNewJobButton = !['clients', 'clientEdit', 'owner'].includes(page)

  if (isBookingPage) {
    return (
      <BookingPage
        googleMapsReady={Boolean(googleMapsKey && isLoaded)}
      />
    )
  }

  if (isApiConfigured && !auth) {
    return (
      <main className="app-shell auth-shell">
        <ToastBanner toast={toast} />
        <AuthPage onAuthSuccess={handleAuthSuccess} onToast={showToast} />
      </main>
    )
  }

  return (
    <main className="app-shell">
      <ToastBanner toast={toast} />
      <aside className="sidebar">
        <button className="brand-row brand-button" type="button" onClick={() => setPage('owner')}>
          <div className="app-icon" aria-label="Alex app icon">
            <img src="/favicon.png" alt="" />
          </div>
          <div>
            <p className="eyebrow">Appliance repair CRM</p>
            <h1>Alex</h1>
          </div>
        </button>

        <div className="search-box">
          <Search size={18} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search customer, phone, address"
          />
        </div>

        <nav className="side-nav" aria-label="Main">
          <button className={page === 'dashboard' ? 'active' : ''} type="button" onClick={() => setPage('dashboard')}>
            <ClipboardList size={18} />
            Jobs
          </button>
          <button className={page === 'clients' ? 'active' : ''} type="button" onClick={() => setPage('clients')}>
            <UserRound size={18} />
            Clients
          </button>
          <button className={page === 'schedule' ? 'active' : ''} type="button" onClick={() => setPage('schedule')}>
            <CalendarDays size={18} />
            Schedule
          </button>
          <button type="button">
            <CreditCard size={18} />
            Payments
          </button>
          <button type="button">
            <Settings size={18} />
            Settings
          </button>
        </nav>

        <div className="mobile-ready session-card">
          <Smartphone size={20} aria-hidden="true" />
          <div>
            <strong>{auth?.user.name || 'Alex Field'}</strong>
            <span>{auth?.user.email || 'Online crew workspace'}</span>
            {auth ? (
              <div className="session-actions">
                <button type="button" onClick={signOut}>
                  <LogOut size={16} />
                  Log out
                </button>
                {isNativeApp ? (
                  <button type="button" onClick={exitApp}>
                    <Power size={16} />
                    Exit app
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </aside>

      <section className="workspace">
        <header className={`topbar ${page === 'job' ? 'job-shell-topbar' : ''}`}>
          {page !== 'dashboard' && page !== 'schedule' ? (
            <button className="back-button" type="button" onClick={() => setPage('dashboard')}>
              <ArrowLeft size={18} />
              Back to jobs
            </button>
          ) : (
            <div>
              <p className="eyebrow">Today, {todayLabel}</p>
              <h2>{page === 'schedule' ? 'Schedule' : 'Jobs'}</h2>
            </div>
          )}
          {showNewJobButton ? (
            <div className="topbar-actions">
              {canAssignTechnicians ? (
                <button className="secondary-action" type="button" onClick={() => setTimeOffOpen(true)}>
                  <CalendarDays size={18} />
                  Time off
                </button>
              ) : null}
              <button className="primary-action" type="button" onClick={openNewJob}>
                <Plus size={18} />
                New job
              </button>
            </div>
          ) : null}
        </header>

        {page === 'dashboard' || page === 'schedule' ? (
          <ScheduleTimeline
            groups={scheduleGroups}
            orderNumbers={orderNumbers}
            todayDate={todayDate}
            onOpenJob={openJob}
            onDoneJob={(id) => updateStatus(id, 'complete')}
            onCancelJob={(id) => updateStatus(id, 'canceled')}
            onDeleteJob={deleteOrder}
          />
        ) : page === 'clients' ? (
          <ClientsPage
            jobs={filteredJobs}
            onAddClient={openNewJob}
            onOpenClient={openClient}
          />
        ) : page === 'clientEdit' ? (
          <ClientEditPage
            client={activeJob}
            onFieldChange={updateClientField}
            onOpenJob={openJob}
            onSave={saveClient}
          />
        ) : page === 'new' ? (
          <section className="new-customer-page">
            <form className="new-job-panel standalone" id="new-job" onSubmit={addJob}>
            <div className="panel-heading">
              <h3>New customer</h3>
              <span>Fast entry</span>
            </div>

            <label>
              Customer
              <input value={form.customer} onChange={(event) => setForm({ ...form, customer: event.target.value })} required />
            </label>
            <label>
              Phone
              <input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} required />
            </label>
            <label>
              Email
              <input
                autoComplete="email"
                type="email"
                value={form.email}
                onChange={(event) => setForm({ ...form, email: event.target.value })}
              />
            </label>
            <label>
              Address
              {googleMapsKey && isLoaded ? (
                <Autocomplete onLoad={(instance) => (autocompleteRef.current = instance)} onPlaceChanged={handlePlaceChanged}>
                  <input
                    value={form.address}
                    onChange={(event) => setForm({ ...form, address: event.target.value })}
                    placeholder="Start typing address"
                    required
                  />
                </Autocomplete>
              ) : (
                <input
                  value={form.address}
                  onChange={(event) => setForm({ ...form, address: event.target.value })}
                  placeholder="Start typing address"
                  required
                />
              )}
            </label>
            <label>
              Appliance
              <input
                value={form.appliance}
                onChange={(event) => setForm({ ...form, appliance: event.target.value })}
                placeholder="GE oven, LG washer..."
                required
              />
            </label>
            <label>
              Problem
              <textarea value={form.issue} onChange={(event) => setForm({ ...form, issue: event.target.value })} rows={3} />
            </label>
            <div className="form-row">
              <label>
                Date
                <input value={form.date} type="date" onChange={(event) => setForm({ ...form, date: event.target.value })} />
              </label>
              <label>
                Time
                <select value={form.window} onChange={(event) => setForm({ ...form, window: event.target.value })}>
                  {bookingWindows.map((window) => (
                    <option key={window}>{window}</option>
                  ))}
                </select>
              </label>
            </div>
            <button className="primary-action wide" type="submit">
              <CheckCircle2 size={18} />
              Save job
            </button>
            </form>
          </section>
        ) : page === 'owner' && auth ? (
          <OwnerCabinet auth={auth} onToast={showToast} />
        ) : (
          <section className="job-page">
            {activeJob ? (
              <JobDetails
                activeJob={activeJob}
                orderNumber={activeOrderNumber}
                onBack={() => setPage('dashboard')}
                onOpenClient={openClient}
                onStatusChange={updateStatus}
                onTogglePaid={togglePaid}
                onCollectPayment={collectPayment}
                onEnableBluetooth={enableTapToPayBluetooth}
                onFinanceItemsChange={updateFinanceItems}
                onCreateInvoice={createInvoice}
                onSendInvoice={sendInvoice}
                onEmailChange={(id, value) => updateClientField(id, 'email', value)}
                onScheduleChange={updateJobSchedule}
                onAddAttachments={addJobAttachments}
                technicians={technicians}
                canAssignTechnicians={canAssignTechnicians}
                onAssignTechnician={assignTechnician}
                paymentBusy={paymentBusyId === activeJob.id}
                isNativeApp={isNativeApp}
              />
            ) : (
              <div className="empty-state">No matching jobs</div>
            )}
          </section>
        )}
      </section>
      {timeOffOpen ? (
        <TimeOffDialog
          blocks={availabilityBlocks}
          onClose={() => setTimeOffOpen(false)}
          onDelete={removeTimeOff}
          onSave={saveTimeOff}
        />
      ) : null}
    </main>
  )
}

function ToastBanner({ toast }: { toast: Toast | null }) {
  if (!toast) return null

  return (
    <div className={`toast-banner ${toast.type}`} role="status" aria-live="polite">
      <strong>{toast.message}</strong>
      {toast.detail ? <span>{toast.detail}</span> : null}
    </div>
  )
}

function BookingPage({ googleMapsReady }: { googleMapsReady: boolean }) {
  const [step, setStep] = useState(0)
  const [service, setService] = useState('')
  const [date, setDate] = useState('')
  const [windowValue, setWindowValue] = useState('')
  const [details, setDetails] = useState({
    firstName: '',
    lastName: '',
    phone: '',
    email: '',
    address: '',
    city: '',
    state: 'Indiana',
    zip: '',
    issue: '',
  })
  const [website, setWebsite] = useState('')
  const [modelPhotos, setModelPhotos] = useState<File[]>([])
  const [weekOffset, setWeekOffset] = useState(0)
  const [bookingSessionId, setBookingSessionId] = useState('')
  const [otpChallenge, setOtpChallenge] = useState<{ challengeId: string; maskedPhone: string } | null>(null)
  const [otpCode, setOtpCode] = useState('')
  const [phoneVerified, setPhoneVerified] = useState(false)
  const [turnstileSiteKey, setTurnstileSiteKey] = useState('')
  const [turnstileToken, setTurnstileToken] = useState('')
  const [bookedWindows, setBookedWindows] = useState<string[]>([])
  const [availabilityBusy, setAvailabilityBusy] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmedJob, setConfirmedJob] = useState<JobRow | null>(null)
  const bookingAutocompleteRef = useRef<google.maps.places.Autocomplete | null>(null)
  const bookingOtpInputRefs = useRef<Array<HTMLInputElement | null>>([])
  const turnstileContainerRef = useRef<HTMLDivElement | null>(null)
  const turnstileWidgetIdRef = useRef<string | null>(null)
  const toastTimerRef = useRef<number | null>(null)
  const bookingStepRef = useRef(step)
  const startedAtRef = useRef(Date.now())
  const availableDates = useMemo(() => createBookingWeek(weekOffset), [weekOffset])
  const selectedDate = availableDates.find((option) => option.value === date)
  const bookedWindowSet = useMemo(() => new Set(bookedWindows), [bookedWindows])
  const selectedWindowIsBooked = Boolean(date && windowValue && bookedWindowSet.has(windowValue))
  const modelPhotoNames = useMemo(() => modelPhotos.map((file) => file.name), [modelPhotos])
  const fullName = `${details.firstName.trim()} ${details.lastName.trim()}`.trim()
  const fullAddress = formatBookingAddress(details)

  const showBookingToast = useCallback((toastMessage: Omit<Toast, 'id'>) => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
    setToast({ ...toastMessage, id: Date.now() })
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null)
      toastTimerRef.current = null
    }, toastMessage.type === 'error' ? 6500 : 4200)
  }, [])

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current)
    }
  }, [])

  useEffect(() => {
    bookingStepRef.current = step
  }, [step])

  useEffect(() => {
    if (step !== 1 || date) return
    const firstAvailableDate = availableDates.find((option) => !option.disabled)?.value || ''
    if (firstAvailableDate) setDate(firstAvailableDate)
  }, [availableDates, date, step])

  useEffect(() => {
    const currentBuildAsset = getCurrentAppBuildAsset()
    if (!currentBuildAsset) return

    let stopped = false

    const refreshIfNewBuildIsLive = () => {
      if (bookingStepRef.current > 1) return

      void fetch(`${window.location.pathname}?buildcheck=${Date.now()}`, {
        cache: 'no-store',
        headers: {
          'Cache-Control': 'no-cache',
        },
      })
        .then((response) => (response.ok ? response.text() : ''))
        .then((html) => {
          if (stopped) return
          const liveBuildAsset = getBuildAssetFromHtml(html)
          if (liveBuildAsset && liveBuildAsset !== currentBuildAsset) {
            window.location.replace(`${window.location.pathname}?fresh=${Date.now()}${window.location.hash}`)
          }
        })
        .catch(() => undefined)
    }

    const timerId = window.setInterval(refreshIfNewBuildIsLive, 15000)
    window.addEventListener('focus', refreshIfNewBuildIsLive)
    document.addEventListener('visibilitychange', refreshIfNewBuildIsLive)

    return () => {
      stopped = true
      window.clearInterval(timerId)
      window.removeEventListener('focus', refreshIfNewBuildIsLive)
      document.removeEventListener('visibilitychange', refreshIfNewBuildIsLive)
    }
  }, [])

  useEffect(() => {
    void fetchBookingConfig()
      .then((config) => setTurnstileSiteKey(config.turnstileSiteKey || ''))
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!date) {
      setBookedWindows([])
      setAvailabilityBusy(false)
      return
    }

    let ignore = false
    let firstLoad = true
    let requestInFlight = false

    const refreshAvailability = () => {
      if (requestInFlight) return
      requestInFlight = true
      if (firstLoad) setAvailabilityBusy(true)

      void fetchBookingAvailability(date)
        .then((availability) => {
          if (ignore) return
          const nextWindows = availability.bookedWindows || []
          setBookedWindows((current) => (stringArraysEqual(current, nextWindows) ? current : nextWindows))
        })
        .catch(() => undefined)
        .finally(() => {
          requestInFlight = false
          if (!ignore) {
            if (firstLoad) {
              firstLoad = false
              setAvailabilityBusy(false)
            }
          }
        })
    }

    const refreshNow = () => refreshAvailability()

    refreshAvailability()
    const intervalId = window.setInterval(refreshNow, 1000)
    window.addEventListener('focus', refreshNow)
    document.addEventListener('visibilitychange', refreshNow)

    return () => {
      ignore = true
      window.clearInterval(intervalId)
      window.removeEventListener('focus', refreshNow)
      document.removeEventListener('visibilitychange', refreshNow)
    }
  }, [date])

  useEffect(() => {
    if (!date) return
    if (windowValue && bookedWindowSet.has(windowValue)) setWindowValue('')
  }, [bookedWindowSet, date, windowValue])

  useEffect(() => {
    if (!turnstileSiteKey || step !== 2 || !turnstileContainerRef.current || turnstileWidgetIdRef.current) return

    let stopped = false
    loadTurnstileScript()
      .then(() => {
        if (stopped || !turnstileContainerRef.current) return
        const turnstile = getTurnstile()
        turnstileWidgetIdRef.current = turnstile.render(turnstileContainerRef.current, {
          sitekey: turnstileSiteKey,
          callback: (token: string) => setTurnstileToken(token),
          'expired-callback': () => setTurnstileToken(''),
          'error-callback': () => setTurnstileToken(''),
        })
      })
      .catch(() => undefined)

    return () => {
      stopped = true
    }
  }, [step, turnstileSiteKey])

  const handlePlaceChanged = () => {
    const place = bookingAutocompleteRef.current?.getPlace()
    if (!place) return

    const parsedAddress = parseGoogleAddress(place)
    setDetails((current) => ({
      ...current,
      address: parsedAddress.address || place.name || current.address,
      city: parsedAddress.city || current.city,
      state: parsedAddress.state || current.state,
      zip: parsedAddress.zip || current.zip,
    }))
  }

  const goToNextStep = () => {
    if (step === 0 && !service) {
      showBookingToast({ type: 'error', message: 'Choose a service', detail: 'Select the appliance service you need.' })
      return
    }

    if (step === 1 && (!date || !windowValue)) {
      showBookingToast({ type: 'error', message: 'Choose a time', detail: 'Select the appointment date and arrival window.' })
      return
    }

    if (step === 1 && selectedWindowIsBooked) {
      showBookingToast({ type: 'error', message: 'Time unavailable', detail: 'This appointment time is already booked. Please choose another time.' })
      return
    }

    if (step === 2) {
      const validationError = validateBookingDetails(details, modelPhotoNames)
      if (validationError) {
        showBookingToast({ type: 'error', message: 'Check your details', detail: validationError })
        return
      }

      void ensureBookingVerification()
      return
    }

    setStep((current) => Math.min(current + 1, bookingSteps.length - 1))
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const ensureBookingVerification = () => {
    if (phoneVerified) {
      setStep(3)
      window.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }

    if (otpChallenge) {
      const code = otpCode.replace(/\D/g, '')
      if (!/^\d{6}$/.test(code)) {
        showBookingToast({ type: 'error', message: 'Enter SMS code', detail: 'The verification code must have 6 digits.' })
        return
      }

      setBusy(true)
      void verifyPublicBookingOtp(bookingSessionId, otpChallenge.challengeId, code)
        .then(() => {
          setPhoneVerified(true)
          setStep(3)
          window.scrollTo({ top: 0, behavior: 'smooth' })
        })
        .catch((error) => {
          showBookingToast({ type: 'error', message: 'SMS verification failed', detail: errorMessage(error) })
        })
        .finally(() => setBusy(false))
      return
    }

    if (turnstileSiteKey && !turnstileToken) {
      showBookingToast({ type: 'error', message: 'Verification required', detail: 'Please complete the security check.' })
      return
    }

    setBusy(true)
    void startPublicBooking({
      device_id: getBookingDeviceId(),
      started_at: startedAtRef.current,
      website,
      turnstile_token: turnstileToken,
      referrer: document.referrer,
      source: new URLSearchParams(window.location.search).get('utm_source') || undefined,
    })
      .then((session) => {
        setBookingSessionId(session.sessionId)
        return sendPublicBookingOtp(session.sessionId, details.phone)
      })
      .then((challenge) => {
        if (challenge.smsUnavailable) {
          setOtpChallenge(null)
          setOtpCode('')
          setPhoneVerified(true)
          setStep(3)
          window.scrollTo({ top: 0, behavior: 'smooth' })
          showBookingToast({
            type: 'success',
            message: 'Phone accepted',
            detail: 'SMS verification is temporarily unavailable. You can finish booking now.',
          })
          return
        }

        setOtpChallenge({ challengeId: challenge.challengeId, maskedPhone: challenge.maskedPhone })
        setOtpCode('')
        showBookingToast({ type: 'success', message: 'SMS code sent', detail: `Enter the 6 digit code sent to ${challenge.maskedPhone}.` })
      })
      .catch((error) => {
        showBookingToast({ type: 'error', message: 'Unable to verify booking', detail: errorMessage(error) })
      })
      .finally(() => setBusy(false))
  }

  const submitBooking = (event: FormEvent) => {
    event.preventDefault()

    const validationError = validateBookingDetails(details, modelPhotoNames)
    if (!service || !date || !windowValue || validationError) {
      showBookingToast({
        type: 'error',
        message: 'Appointment is incomplete',
        detail: validationError || 'Please choose service, date, and time.',
      })
      return
    }

    if (selectedWindowIsBooked) {
      showBookingToast({
        type: 'error',
        message: 'Time unavailable',
        detail: 'This appointment time is already booked. Please choose another time.',
      })
      setStep(1)
      return
    }

    if (!bookingSessionId || !phoneVerified) {
      showBookingToast({
        type: 'error',
        message: 'Phone verification required',
        detail: 'Please verify your phone number before booking.',
      })
      setStep(2)
      return
    }

    setBusy(true)
    void createPublicBooking({
      session_id: bookingSessionId,
      customer: fullName,
      phone: details.phone.trim(),
      email: details.email.trim(),
      address: fullAddress,
      appliance: service,
      issue: details.issue.trim(),
      model_photo_names: modelPhotoNames,
      model_photos: modelPhotos,
      service_date: date,
      service_window: windowValue,
      lat: 39.7684,
      lng: -86.1581,
      device_id: getBookingDeviceId(),
      started_at: startedAtRef.current,
      website,
    })
      .then((job) => {
        setConfirmedJob(job)
        showBookingToast({
          type: 'success',
          message: 'Appointment booked',
          detail: 'Alex Appliance Repair received your request.',
        })
      })
      .catch((error) => {
        showBookingToast({
          type: 'error',
          message: 'Unable to book appointment',
          detail: errorMessage(error),
        })
      })
      .finally(() => setBusy(false))
  }

  const updateBookingOtpCode = useCallback((nextCode: string, focusIndex?: number) => {
    const cleanCode = nextCode.replace(/\D/g, '').slice(0, 6)
    setOtpCode(cleanCode)
    if (focusIndex === undefined) return

    window.requestAnimationFrame(() => {
      bookingOtpInputRefs.current[Math.min(focusIndex, 5)]?.focus()
    })
  }, [])

  const changeBookingOtpDigit = (index: number, value: string) => {
    const pastedDigits = value.replace(/\D/g, '')
    if (pastedDigits.length > 1) {
      updateBookingOtpCode(pastedDigits, pastedDigits.length >= 6 ? 5 : pastedDigits.length)
      return
    }

    const digits = otpCode.padEnd(6, ' ').split('')
    digits[index] = pastedDigits || ' '
    updateBookingOtpCode(digits.join('').replace(/\s/g, ''), pastedDigits ? index + 1 : index)
  }

  const keyBookingOtpDigit = (index: number, key: string) => {
    if (key !== 'Backspace') return
    if (otpCode[index]) return
    window.requestAnimationFrame(() => {
      bookingOtpInputRefs.current[Math.max(index - 1, 0)]?.focus()
    })
  }

  useEffect(() => {
    if (step !== 2 || !otpChallenge || phoneVerified) return
    if (!('credentials' in navigator) || !window.isSecureContext) return

    const controller = new AbortController()
    void navigator.credentials
      .get({
        otp: { transport: ['sms'] },
        signal: controller.signal,
      } as WebOtpCredentialRequestOptions)
      .then((credential) => {
        const code = (credential as WebOtpCredential | null)?.code || ''
        if (/^\d{6}$/.test(code)) updateBookingOtpCode(code, 5)
      })
      .catch(() => undefined)

    return () => controller.abort()
  }, [otpChallenge, phoneVerified, step, updateBookingOtpCode])

  return (
    <main className="booking-shell">
      <ToastBanner toast={toast} />
      <header className="booking-header">
        <div className="booking-brand">
          <img src="/favicon.png" alt="Alex Appliance Repair" />
          <div>
            <strong>Alex Appliance Repair</strong>
            <span>SERVICE CALL - $89</span>
          </div>
        </div>
      </header>

      <section className="booking-flow" aria-label="Book an appointment">
        <div className="booking-stepper" aria-label="Booking progress">
          {bookingSteps.map((label, index) => (
            <div className={`booking-step ${index === step ? 'active' : ''} ${index < step ? 'done' : ''}`} key={label}>
              <span>{index < step ? <CheckCircle2 size={14} /> : index + 1}</span>
              <strong>{label}</strong>
            </div>
          ))}
        </div>

        {confirmedJob ? (
          <>
            <h1 className="booking-page-title">Booking summary</h1>
            <div className="booking-confirmation">
              <div className="booking-confirm-card">
                <CheckCircle2 size={48} />
                <h2>Thank you for choosing us!</h2>
                <span>Booking confirmed</span>
              </div>
              <div className="booking-confirm-info">
                <div className="booking-appointment-time">
                  <strong>{formatBookingLongDate(confirmedJob.service_date)}</strong>
                  <span>{formatBookingWindow(confirmedJob.service_window)}</span>
                </div>
                <div className="booking-location">
                  <strong>LOCATION</strong>
                  <span>{confirmedJob.address}</span>
                  <iframe
                    title="Service location map"
                    loading="lazy"
                    src={`https://www.google.com/maps?q=${encodeURIComponent(confirmedJob.address)}&output=embed`}
                  />
                </div>
              </div>
            </div>
            <div className="booking-contact-row">
              <strong>CONTACT US:</strong>
              <a href="mailto:alexeasyrepair@gmail.com">
                <Mail size={14} />
                alexeasyrepair@gmail.com
              </a>
              <span>•</span>
              <a href="tel:4632488429">
                <Phone size={14} />
                4632488429
              </a>
            </div>
          </>
        ) : (
          <form className="booking-card" onSubmit={submitBooking}>
            <label className="booking-honey-field" aria-hidden="true">
              Website
              <input
                autoComplete="off"
                tabIndex={-1}
                value={website}
                onChange={(event) => setWebsite(event.target.value)}
              />
            </label>

            {step === 0 ? (
              <>
                <h1>What service do you need?</h1>
                <div className="booking-choice-list">
                  {bookingServices.map((option) => (
                    <button
                      className={`booking-choice ${service === option ? 'selected' : ''}`}
                      key={option}
                      type="button"
                      onClick={() => {
                        setService(option)
                        setWeekOffset(0)
                        setDate('')
                        setWindowValue('')
                        setStep(1)
                      }}
                    >
                      <span>{option}</span>
                      {service === option ? <CheckCircle2 size={20} /> : null}
                    </button>
                  ))}
                </div>
              </>
            ) : null}

            {step === 1 ? (
              <>
                <h1>When works best for you?</h1>
                <div className="booking-section">
                  <div className="booking-schedule-heading">
                    <h2>{selectedDate ? formatBookingLongDate(selectedDate.value) : 'Select a date'}</h2>
                    <div>
                      <button type="button" onClick={() => setWeekOffset((current) => Math.max(0, current - 1))} disabled={weekOffset === 0}>
                        <ChevronLeft size={18} />
                      </button>
                      <button type="button" onClick={() => setWeekOffset((current) => current + 1)}>
                        <ChevronRight size={18} />
                      </button>
                    </div>
                  </div>
                  <div className="booking-week-grid">
                    {availableDates.map((option) => (
                      <button
                        className={`booking-week-day ${date === option.value ? 'selected' : ''} ${option.disabled ? 'disabled' : ''}`}
                        key={option.value}
                        type="button"
                        disabled={option.disabled}
                        onClick={() => {
                          setDate(option.value)
                          setWindowValue('')
                        }}
                      >
                        <span>{option.weekday}</span>
                        <strong>{option.day}</strong>
                      </button>
                    ))}
                  </div>
                  <p className="booking-local-time">Times are shown in the business's local time.</p>
                  <h2>Select a visit time</h2>
                  {availabilityBusy ? <p className="booking-availability-note">Checking available times...</p> : null}
                  <div className="booking-time-grid">
                    {bookingWindows.map((option) => {
                      const leadTimeClosed = Boolean(date && !isPublicBookingWindowInLeadTime(date, option))
                      const booked = Boolean(date && (bookedWindowSet.has(option) || leadTimeClosed))
                      return (
                        <button
                          className={`booking-time ${windowValue === option && !booked ? 'selected' : ''} ${booked ? 'booked' : ''}`}
                          key={option}
                          type="button"
                          disabled={!date || booked}
                          onClick={() => setWindowValue(option)}
                        >
                          <span>{formatBookingWindow(option)}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
                <BookingActions onBack={() => setStep(0)} onNext={goToNextStep} />
              </>
            ) : null}

            {step === 2 ? (
              <>
                <h1>Please provide your contact info</h1>
                <div className="booking-details-panel">
                  <div className="booking-details-grid">
                    <label>
                      First name <sup>*</sup>
                      <input
                        autoComplete="given-name"
                        placeholder="First name"
                        value={details.firstName}
                        onChange={(event) => setDetails({ ...details, firstName: event.target.value })}
                        required
                      />
                    </label>
                    <label>
                      Last name <sup>*</sup>
                      <input
                        autoComplete="family-name"
                        placeholder="Last name"
                        value={details.lastName}
                        onChange={(event) => setDetails({ ...details, lastName: event.target.value })}
                        required
                      />
                    </label>
                    <label>
                      Email address <sup>*</sup>
                      <input
                        autoComplete="email"
                        inputMode="email"
                        placeholder="Email address"
                        type="email"
                        value={details.email}
                        onChange={(event) => setDetails({ ...details, email: event.target.value })}
                        required
                      />
                    </label>
                    <label>
                      Phone number <sup>*</sup>
                      <input
                        autoComplete="tel"
                        inputMode="tel"
                        placeholder="Phone number"
                        type="tel"
                        value={details.phone}
                        onChange={(event) => setDetails({ ...details, phone: event.target.value })}
                        required
                      />
                    </label>
                    <label>
                      Address <sup>*</sup>
                      {googleMapsReady ? (
                        <Autocomplete onLoad={(instance) => (bookingAutocompleteRef.current = instance)} onPlaceChanged={handlePlaceChanged}>
                          <input
                            autoComplete="street-address"
                            placeholder="Address"
                            value={details.address}
                            onChange={(event) => setDetails({ ...details, address: event.target.value })}
                            required
                          />
                        </Autocomplete>
                      ) : (
                        <input
                          autoComplete="street-address"
                          placeholder="Address"
                          value={details.address}
                          onChange={(event) => setDetails({ ...details, address: event.target.value })}
                          required
                        />
                      )}
                    </label>
                    <label>
                      City <sup>*</sup>
                      <input
                        autoComplete="address-level2"
                        placeholder="City"
                        value={details.city}
                        onChange={(event) => setDetails({ ...details, city: event.target.value })}
                        required
                      />
                    </label>
                    <label className="booking-state-field">
                      State <sup>*</sup>
                      <select
                        autoComplete="address-level1"
                        value={details.state}
                        onChange={(event) => setDetails({ ...details, state: event.target.value })}
                      >
                        <option>Indiana</option>
                        <option>Illinois</option>
                        <option>Ohio</option>
                        <option>Kentucky</option>
                      </select>
                    </label>
                    <label>
                      Zip code <sup>*</sup>
                      <input
                        autoComplete="postal-code"
                        inputMode="numeric"
                        placeholder="Zip code"
                        value={details.zip}
                        onChange={(event) => setDetails({ ...details, zip: event.target.value })}
                        required
                      />
                    </label>
                  </div>
                  <div className="booking-details-side">
                    <label className="booking-upload-box">
                      <Upload size={24} />
                      <strong>Model number sticker photo <sup>*</sup></strong>
                      <span>{modelPhotoNames.length ? modelPhotoNames.join(', ') : 'Upload a clear label photo'}</span>
                      <small>Attach the model/serial number sticker from the appliance.</small>
                      <input
                        multiple
                        accept="image/*"
                        capture="environment"
                        type="file"
                        required
                        onChange={(event) => setModelPhotos(Array.from(event.currentTarget.files || []))}
                      />
                    </label>
                    <textarea
                      rows={5}
                      value={details.issue}
                      onChange={(event) => setDetails({ ...details, issue: event.target.value })}
                      placeholder="Add your description here..."
                      required
                    />
                  </div>
                </div>
                {turnstileSiteKey ? <div className="booking-turnstile" ref={turnstileContainerRef} /> : null}
                {otpChallenge ? (
                  <div className="booking-otp-panel">
                    <strong>Enter SMS code</strong>
                    <span>We sent a 6 digit code to {otpChallenge.maskedPhone}.</span>
                    <div className="otp-field booking-otp-field" aria-label="Booking SMS code">
                      {Array.from({ length: 6 }, (_, index) => (
                        <input
                          key={index}
                          autoComplete={index === 0 ? 'one-time-code' : 'off'}
                          inputMode="numeric"
                          maxLength={1}
                          name={index === 0 ? 'one-time-code' : `booking-code-${index + 1}`}
                          pattern="[0-9]*"
                          ref={(element) => {
                            bookingOtpInputRefs.current[index] = element
                          }}
                          value={otpCode[index] || ''}
                          onChange={(event) => changeBookingOtpDigit(index, event.target.value)}
                          onKeyDown={(event) => keyBookingOtpDigit(index, event.key)}
                          onPaste={(event) => {
                            event.preventDefault()
                            updateBookingOtpCode(event.clipboardData.getData('text'), 5)
                          }}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}
                <BookingActions
                  nextLabel={phoneVerified ? 'Continue' : otpChallenge ? 'Verify SMS code' : 'Send SMS code'}
                  busy={busy}
                  onBack={() => setStep(1)}
                  onNext={goToNextStep}
                />
              </>
            ) : null}

            {step === 3 ? (
              <>
                <h1>Review your appointment</h1>
                <div className="booking-summary">
                  <div>
                    <strong>Service</strong>
                    <span>{service}</span>
                  </div>
                  <div>
                    <strong>Schedule</strong>
                    <span>
                      {formatBookingLongDate(date)}, {formatBookingWindow(windowValue)}
                    </span>
                  </div>
                  <div>
                    <strong>Customer</strong>
                    <span>{fullName}</span>
                  </div>
                  <div>
                    <strong>Phone</strong>
                    <span>{details.phone}</span>
                  </div>
                  <div>
                    <strong>Email</strong>
                    <span>{details.email}</span>
                  </div>
                  <div>
                    <strong>Model sticker photo</strong>
                    <span>{modelPhotoNames.join(', ')}</span>
                  </div>
                  <div>
                    <strong>Address</strong>
                    <span>{fullAddress}</span>
                  </div>
                  {details.issue ? (
                    <div>
                      <strong>Problem</strong>
                      <span>{details.issue}</span>
                    </div>
                  ) : null}
                </div>
                <div className="booking-actions">
                  <button className="booking-secondary" type="button" onClick={() => setStep(2)}>
                    Back
                  </button>
                  <button className="booking-primary" type="submit" disabled={busy}>
                    {busy ? 'Booking...' : 'Book appointment'}
                  </button>
                </div>
              </>
            ) : null}
          </form>
        )}
      </section>

      <footer className="booking-footer">
        {confirmedJob ? (
          <button className="booking-secondary add-calendar-button" type="button" onClick={() => downloadBookingCalendar(confirmedJob)}>
            <CalendarPlus size={18} />
            Add to calendar
          </button>
        ) : null}
        <span>Powered by Alex Appliance Repair</span>
      </footer>
    </main>
  )
}

function BookingActions({
  busy = false,
  nextLabel = 'Continue',
  onBack,
  onNext,
}: {
  busy?: boolean
  nextLabel?: string
  onBack: () => void
  onNext: () => void
}) {
  return (
    <div className="booking-actions">
      <button className="booking-secondary" type="button" onClick={onBack} disabled={busy}>
        Back
      </button>
      <button className="booking-primary" type="button" onClick={onNext} disabled={busy}>
        {busy ? 'Please wait...' : nextLabel}
      </button>
    </div>
  )
}

function AuthPage({
  onAuthSuccess,
  onToast,
}: {
  onAuthSuccess: (session: AuthSession) => void
  onToast: (toast: Omit<Toast, 'id'>) => void
}) {
  const [mode, setMode] = useState<AuthMode>('login')
  const [form, setForm] = useState<AuthFormState>(emptyAuthForm)
  const [twoFactor, setTwoFactor] = useState<TwoFactorState | null>(null)
  const [smsCode, setSmsCode] = useState('')
  const otpInputRefs = useRef<Array<HTMLInputElement | null>>([])
  const [busy, setBusy] = useState(false)
  const [ownerLoginVisible, setOwnerLoginVisible] = useState(false)
  const ownerTapCountRef = useRef(0)
  const ownerTapTimerRef = useRef<number | null>(null)
  const ownerPressTimerRef = useRef<number | null>(null)
  const googleButtonRef = useRef<HTMLDivElement | null>(null)
  const isNativeApp = Capacitor.isNativePlatform()

  useEffect(() => {
    if (!googleClientId || !googleButtonRef.current) return

    let stopped = false
    const clientId = googleClientId

    async function setupGoogleButton() {
      try {
        await loadGoogleIdentityScript()
        if (stopped || !googleButtonRef.current) return

        googleButtonRef.current.innerHTML = ''
        getGoogleIdentity().accounts.id.initialize({
          client_id: clientId,
          callback: (response: { credential?: string }) => {
            if (!response.credential) return

            setBusy(true)
            void loginWithGoogle(response.credential, { ownerOnly: isNativeApp })
              .then(onAuthSuccess)
              .catch((error) => {
                onToast({
                  type: 'error',
                  message: isNativeApp ? 'Owner Google sign in failed' : 'Google sign in failed',
                  detail: errorMessage(error),
                })
              })
              .finally(() => setBusy(false))
          },
        })
        getGoogleIdentity().accounts.id.renderButton(googleButtonRef.current, {
          shape: 'rectangular',
          size: 'large',
          text: isNativeApp ? 'signin_with' : 'continue_with',
          theme: 'outline',
          width: 320,
        })
      } catch (error) {
        onToast({
          type: 'error',
          message: 'Google sign in unavailable',
          detail: errorMessage(error),
        })
      }
    }

    void setupGoogleButton()

    return () => {
      stopped = true
    }
  }, [onAuthSuccess, onToast])

  useEffect(() => {
    return () => {
      if (ownerTapTimerRef.current) {
        window.clearTimeout(ownerTapTimerRef.current)
      }
      if (ownerPressTimerRef.current) {
        window.clearTimeout(ownerPressTimerRef.current)
      }
    }
  }, [])

  const openOwnerLogin = () => {
    if (ownerTapTimerRef.current) {
      window.clearTimeout(ownerTapTimerRef.current)
      ownerTapTimerRef.current = null
    }
    if (ownerPressTimerRef.current) {
      window.clearTimeout(ownerPressTimerRef.current)
      ownerPressTimerRef.current = null
    }
    ownerTapCountRef.current = 0
    setOwnerLoginVisible(true)
    setTwoFactor(null)
    setSmsCode('')
    setForm(emptyAuthForm)
  }

  const revealOwnerLogin = () => {
    ownerTapCountRef.current += 1
    if (ownerTapCountRef.current >= 5) {
      openOwnerLogin()
      return
    }

    ownerTapTimerRef.current = window.setTimeout(() => {
      ownerTapCountRef.current = 0
      ownerTapTimerRef.current = null
    }, 4000)
  }

  const startOwnerLongPress = () => {
    if (ownerPressTimerRef.current) {
      window.clearTimeout(ownerPressTimerRef.current)
    }
    ownerPressTimerRef.current = window.setTimeout(openOwnerLogin, 900)
  }

  const cancelOwnerLongPress = () => {
    if (ownerPressTimerRef.current) {
      window.clearTimeout(ownerPressTimerRef.current)
      ownerPressTimerRef.current = null
    }
  }

  const submitOwnerLogin = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form.email || !form.password) return

    setBusy(true)
    void loginWithPassword(form.email, form.password, {
      trustedDeviceId: getTrustedDeviceId(),
      platform: isNativeApp ? 'android' : 'web',
    })
      .then((response) => {
        if (isTwoFactorChallenge(response) || isPendingApproval(response)) {
          throw new Error('Owner account is required')
        }

        onAuthSuccess(response)
      })
      .catch((error) => {
        onToast({
          type: 'error',
          message: 'Owner sign in failed',
          detail: errorMessage(error),
        })
      })
      .finally(() => setBusy(false))
  }

  const submitAuth = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const isNativeSmsLogin = isNativeApp && mode === 'login'
    const isNativeRegistration = isNativeApp && mode === 'register'
    if (!form.email || (!isNativeSmsLogin && !form.password) || (mode === 'register' && (!form.name || (isNativeApp && !form.phone)))) return

    if (isNativeRegistration && !isValidUsPhoneNumber(form.phone)) {
      onToast({
        type: 'error',
        message: 'Invalid phone number',
        detail: 'Use a valid US phone number with 10 digits.',
      })
      return
    }

    setBusy(true)
    const request =
      isNativeSmsLogin
        ? requestSmsLogin(form.email, {
            platform: 'android',
          })
        : mode === 'register'
        ? registerWithPassword(form.name, form.email, form.password, {
            phone: form.phone,
            platform: isNativeApp ? 'android' : 'web',
          })
        : loginWithPassword(form.email, form.password, {
            trustedDeviceId: getTrustedDeviceId(),
            platform: isNativeApp ? 'android' : 'web',
          })

    void request
      .then((response) => {
        if (isTwoFactorChallenge(response)) {
          setTwoFactor({ ...response, email: form.email })
          setSmsCode('')
          onToast({
            type: 'success',
            message: 'SMS code sent',
            detail: `Code sent to ${response.maskedPhone}`,
          })
          return
        }

        if (isPendingApproval(response)) {
          setMode('login')
          setForm({ ...emptyAuthForm, email: response.email })
          onToast({
            type: 'success',
            message: 'Registration complete',
            detail: response.message,
          })
          return
        }

        onAuthSuccess(response)
      })
      .catch((error) => {
        onToast({
          type: 'error',
          message: mode === 'register' ? 'Registration failed' : 'Sign in failed',
          detail: errorMessage(error),
        })
      })
      .finally(() => setBusy(false))
  }

  const submitSmsCode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!twoFactor) return

    const code = smsCode.trim()
    if (!/^\d{6}$/.test(code)) {
      onToast({
        type: 'error',
        message: 'Enter SMS code',
        detail: 'The code must be exactly 6 digits.',
      })
      return
    }

    setBusy(true)
    void verifySmsCode(twoFactor.challengeId, code, getTrustedDeviceId())
      .then(onAuthSuccess)
      .catch((error) => {
        onToast({
          type: 'error',
          message: 'Code verification failed',
          detail: errorMessage(error),
        })
      })
      .finally(() => setBusy(false))
  }

  const updateOtpCode = (nextCode: string, focusIndex?: number) => {
    const cleanCode = nextCode.replace(/\D/g, '').slice(0, 6)
    setSmsCode(cleanCode)

    if (focusIndex === undefined) return

    window.requestAnimationFrame(() => {
      otpInputRefs.current[Math.min(focusIndex, 5)]?.focus()
    })
  }

  const changeOtpDigit = (index: number, value: string) => {
    const pastedDigits = value.replace(/\D/g, '')
    if (pastedDigits.length > 1) {
      updateOtpCode(pastedDigits, pastedDigits.length >= 6 ? 5 : pastedDigits.length)
      return
    }

    const digits = smsCode.padEnd(6, ' ').split('')
    digits[index] = pastedDigits || ' '
    const nextCode = digits.join('').replace(/\s/g, '')
    updateOtpCode(nextCode, pastedDigits ? index + 1 : index)
  }

  const keyOtpDigit = (index: number, key: string) => {
    if (key !== 'Backspace') return
    if (smsCode[index]) return

    window.requestAnimationFrame(() => {
      otpInputRefs.current[Math.max(index - 1, 0)]?.focus()
    })
  }

  const pasteOtpCode = (value: string) => {
    updateOtpCode(value, 5)
  }

  if (twoFactor) {
    return (
      <section className="auth-page">
        <div className="auth-panel">
          <div className="brand-row">
            <div className="app-icon" aria-label="Alex app icon">
              <img src="/favicon.png" alt="" />
            </div>
            <div>
              <p className="eyebrow">Alex Appliance Repair</p>
              <h1>SMS code</h1>
            </div>
          </div>

          <p className="sms-code-copy">Enter the 6 digit code sent to {twoFactor.maskedPhone}</p>
          <form className="auth-form" onSubmit={submitSmsCode}>
            <div className="otp-field" aria-label="SMS code">
              {Array.from({ length: 6 }, (_, index) => (
                <input
                  aria-label={`Digit ${index + 1}`}
                  autoComplete={index === 0 ? 'one-time-code' : 'off'}
                  inputMode="numeric"
                  key={index}
                  maxLength={1}
                  ref={(element) => {
                    otpInputRefs.current[index] = element
                  }}
                  type="text"
                  value={smsCode[index] || ''}
                  onChange={(event) => changeOtpDigit(index, event.target.value)}
                  onKeyDown={(event) => keyOtpDigit(index, event.key)}
                  onPaste={(event) => {
                    event.preventDefault()
                    pasteOtpCode(event.clipboardData.getData('text'))
                  }}
                />
              ))}
            </div>

            <button className="primary-action wide" disabled={busy} type="submit">
              Open app
            </button>
          </form>

          <button className="back-button wide-auth-button" type="button" onClick={() => setTwoFactor(null)}>
            Back to login
          </button>
        </div>
      </section>
    )
  }

  if (ownerLoginVisible) {
    return (
      <section className="auth-page">
        <div className="auth-panel">
          <div className="brand-row">
            <div className="app-icon" aria-label="Alex app icon">
              <img src="/favicon.png" alt="" />
            </div>
            <div>
              <p className="eyebrow">Alex Appliance Repair</p>
              <h1>Owner sign in</h1>
            </div>
          </div>

          <form className="auth-form" onSubmit={submitOwnerLogin}>
            <label>
              Email
              <input
                autoComplete="email"
                type="email"
                value={form.email}
                onChange={(event) => setForm({ ...form, email: event.target.value })}
                required
              />
            </label>
            <label>
              Password
              <input
                autoComplete="current-password"
                minLength={8}
                type="password"
                value={form.password}
                onChange={(event) => setForm({ ...form, password: event.target.value })}
                required
              />
            </label>
            <button className="primary-action wide" disabled={busy} type="submit">
              Sign in
            </button>
          </form>

          <button
            className="back-button wide-auth-button"
            type="button"
            onClick={() => {
              setOwnerLoginVisible(false)
              setForm(emptyAuthForm)
            }}
          >
            Back
          </button>
        </div>
      </section>
    )
  }

  return (
    <section className="auth-page">
      <div className="auth-panel">
        <button
          aria-label="Alex Appliance Repair"
          className="brand-row auth-brand-button"
          tabIndex={-1}
          type="button"
          onContextMenu={(event) => event.preventDefault()}
          onClick={revealOwnerLogin}
          onPointerCancel={cancelOwnerLongPress}
          onPointerDown={startOwnerLongPress}
          onPointerLeave={cancelOwnerLongPress}
          onPointerUp={cancelOwnerLongPress}
        >
          <div className="app-icon" aria-label="Alex app icon">
            <img src="/favicon.png" alt="" />
          </div>
          <div>
            <p className="eyebrow">Alex Appliance Repair</p>
            <h1>Sign in</h1>
          </div>
        </button>

        <div className="auth-tabs" role="tablist" aria-label="Authentication mode">
          <button className={mode === 'login' ? 'active' : ''} type="button" onClick={() => setMode('login')}>
            Login
          </button>
          <button className={mode === 'register' ? 'active' : ''} type="button" onClick={() => setMode('register')}>
            Register
          </button>
        </div>

        <form className="auth-form" onSubmit={submitAuth}>
          {mode === 'register' ? (
            <label>
              Name
              <input
                autoComplete="name"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
              />
            </label>
          ) : null}

          {mode === 'register' && isNativeApp ? (
            <label>
              Phone number
              <input
                autoComplete="tel"
                inputMode="tel"
                pattern="^(?:\+1[\s.-]?)?(?:\([2-9]\d{2}\)|[2-9]\d{2})[\s.-]?[2-9]\d{2}[\s.-]?\d{4}$"
                placeholder="(317) 555-0123"
                title="Use a valid US phone number with 10 digits."
                type="tel"
                value={form.phone}
                onChange={(event) => setForm({ ...form, phone: event.target.value })}
                required
              />
            </label>
          ) : null}

          <label>
            Email
            <input
              autoComplete="email"
              type="email"
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
              required
            />
          </label>

          {!(isNativeApp && mode === 'login') ? (
            <label>
              Password
              <input
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                minLength={8}
                type="password"
                value={form.password}
                onChange={(event) => setForm({ ...form, password: event.target.value })}
                required
              />
            </label>
          ) : null}

          <button className="primary-action wide" disabled={busy} type="submit">
            {mode === 'register' ? 'Create account' : isNativeApp ? 'Send SMS code' : 'Sign in'}
          </button>
        </form>

        {isNativeApp ? (
          <p className="owner-google-note">Technicians sign in with the SMS code sent to their phone.</p>
        ) : (
          <>
            <div className="auth-divider">or</div>
            {googleClientId ? (
              <div className="google-auth-button" ref={googleButtonRef} />
            ) : (
              <button className="google-auth-fallback" disabled type="button">
                Google sign in needs client ID
              </button>
            )}
          </>
        )}
      </div>
    </section>
  )
}

function OwnerCabinet({
  auth,
  onToast,
}: {
  auth: AuthSession
  onToast: (toast: Omit<Toast, 'id'>) => void
}) {
  const [email, setEmail] = useState('')
  const [approvedUsers, setApprovedUsers] = useState<ApprovedUser[]>([])
  const [busy, setBusy] = useState(false)
  const isOwner = auth.user.role === 'owner'

  useEffect(() => {
    if (!isOwner) return

    let ignore = false

    async function loadApprovedUsers() {
      try {
        const rows = await fetchApprovedUsers(auth.token)
        if (!ignore) setApprovedUsers(rows)
      } catch (error) {
        if (!ignore) {
          onToast({
            type: 'error',
            message: 'Unable to load technicians',
            detail: errorMessage(error),
          })
        }
      }
    }

    void loadApprovedUsers()
    const refreshTimer = window.setInterval(() => {
      void loadApprovedUsers()
    }, 2000)

    return () => {
      ignore = true
      window.clearInterval(refreshTimer)
    }
  }, [auth.token, isOwner, onToast])

  const submitTechnician = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const nextEmail = email.trim()
    if (!nextEmail) return

    setBusy(true)
    void addApprovedUser(nextEmail, auth.token)
      .then((user) => {
        setApprovedUsers((current) => [user, ...current.filter((row) => row.email !== user.email)])
        setEmail('')
        onToast({
          type: 'success',
          message: 'Technician added',
          detail: user.email,
        })
      })
      .catch((error) => {
        onToast({
          type: 'error',
          message: 'Unable to add technician',
          detail: errorMessage(error),
        })
      })
      .finally(() => setBusy(false))
  }

  const approveTechnician = (technicianEmail: string) => {
    setBusy(true)
    void addApprovedUser(technicianEmail, auth.token)
      .then((user) => {
        setApprovedUsers((current) =>
          current.map((row) =>
            row.email === user.email
              ? { ...row, ...user, approved: true, role: user.role }
              : row,
          ),
        )
        onToast({
          type: 'success',
          message: 'Technician approved',
          detail: user.email,
        })
      })
      .catch((error) => {
        onToast({
          type: 'error',
          message: 'Unable to approve technician',
          detail: errorMessage(error),
        })
      })
      .finally(() => setBusy(false))
  }

  return (
    <section className="owner-page">
      <div className="owner-panel">
        <div className="panel-heading">
          <h3>{isOwner ? 'Owner account' : 'Technician account'}</h3>
          <span>{auth.user.role}</span>
        </div>

        <div className="account-card">
          <strong>{auth.user.name}</strong>
          <span>{auth.user.email}</span>
        </div>

        {isOwner ? (
          <>
            <form className="owner-form" onSubmit={submitTechnician}>
              <label>
                Technician email
                <input
                  autoComplete="email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              </label>
              <button className="primary-action" disabled={busy} type="submit">
                <UserPlus size={18} />
                Add technician
              </button>
            </form>

            <div className="owner-list">
              {approvedUsers.map((user) => {
                const pendingApproval = user.role === 'technician' && user.approved === false

                return (
                  <article className="owner-user-row" key={user.email}>
                    <div className="owner-user-meta">
                      <strong>{user.name || user.email}</strong>
                      <span>{user.name ? user.email : user.role}</span>
                      {user.phone ? <span>{user.phone}</span> : null}
                    </div>
                    <div className="owner-user-actions">
                      {pendingApproval ? <span className="pending-badge">pending approval</span> : null}
                      {user.role === 'technician' && user.now_online ? (
                        <span className="online-badge">now online</span>
                      ) : null}
                      {pendingApproval ? (
                        <button className="mini-action" disabled={busy} type="button" onClick={() => approveTechnician(user.email)}>
                          Approve
                        </button>
                      ) : null}
                    </div>
                  </article>
                )
              })}
            </div>
          </>
        ) : null}
      </div>
    </section>
  )
}

function JobDetails({
  activeJob,
  orderNumber,
  onBack,
  onOpenClient,
  onStatusChange,
  onTogglePaid,
  onCollectPayment,
  onEnableBluetooth,
  onFinanceItemsChange,
  onCreateInvoice,
  onSendInvoice,
  onEmailChange,
  onScheduleChange,
  onAddAttachments,
  technicians,
  canAssignTechnicians,
  onAssignTechnician,
  paymentBusy,
  isNativeApp,
}: {
  activeJob: Job
  orderNumber: string
  onBack: () => void
  onOpenClient: (id: string) => void
  onStatusChange: (id: string, status: JobStatus) => void
  onTogglePaid: (id: string) => void
  onCollectPayment: (id: string, amount: number) => void
  onEnableBluetooth: () => void
  onFinanceItemsChange: (id: string, financeItems: FinanceItem[]) => void
  onCreateInvoice: (id: string) => void
  onSendInvoice: (id: string) => void
  onEmailChange: (id: string, value: string) => void
  onScheduleChange: (id: string, date: string, window: string) => Promise<boolean>
  onAddAttachments: (id: string, files: File[]) => void
  technicians: ApprovedUser[]
  canAssignTechnicians: boolean
  onAssignTechnician: (id: string, technicianUserId: string) => void
  paymentBusy: boolean
  isNativeApp: boolean
}) {
  const [tab, setTab] = useState<'details' | 'finance' | 'timeline'>('details')
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false)
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false)
  const [invoicePreviewOpen, setInvoicePreviewOpen] = useState(false)
  const [attachmentPreview, setAttachmentPreview] = useState<ModelPhotoAttachment | null>(null)
  const [scheduleSaving, setScheduleSaving] = useState(false)
  const [paymentAmount, setPaymentAmount] = useState('')
  const [scheduleDate, setScheduleDate] = useState(activeJob.date)
  const [scheduleWindow, setScheduleWindow] = useState(activeJob.window)
  const attachmentInputRef = useRef<HTMLInputElement | null>(null)
  const financeItems = activeJob.financeItems.length ? activeJob.financeItems : defaultFinanceItems(activeJob.invoice)
  const total = jobTotal(activeJob)
  const paidTotal = jobPaymentsTotal(activeJob.payments)
  const balance = jobBalance(activeJob)
  const latestPayment = activeJob.payments.length ? activeJob.payments[activeJob.payments.length - 1] : null
  const attachments = normalizeModelPhotoAttachments(activeJob.modelPhotoAttachments || [])
  const mapPreviewUrl = `https://maps.google.com/maps?q=${encodeURIComponent(activeJob.address)}&output=embed`
  const assignedTechnicianName = activeJob.technicianName || activeJob.technicianEmail || 'Unassigned'
  const scheduleLine = formatJobScheduleLine(activeJob.date, activeJob.window)
  const scheduleDirty = scheduleDate !== activeJob.date || scheduleWindow !== activeJob.window

  useEffect(() => {
    if (activeJob.financeItems.length) return
    onFinanceItemsChange(activeJob.id, defaultFinanceItems(activeJob.invoice))
  }, [activeJob.financeItems.length, activeJob.id, activeJob.invoice, onFinanceItemsChange])

  useEffect(() => {
    setScheduleDate(activeJob.date)
    setScheduleWindow(activeJob.window)
  }, [activeJob.date, activeJob.window, activeJob.id])

  const openPaymentDialog = () => {
    setPaymentAmount(balance > 0 ? balance.toFixed(2) : '')
    setPaymentDialogOpen(true)
  }

  const submitPayment = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const amount = normalizeMoneyInput(paymentAmount)
    if (amount <= 0) return
    setPaymentDialogOpen(false)
    onCollectPayment(activeJob.id, amount)
  }

  const submitSchedule = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!scheduleDate || !scheduleWindow) return
    if (!scheduleDirty) {
      setScheduleDialogOpen(false)
      return
    }

    setScheduleSaving(true)
    const saved = await onScheduleChange(activeJob.id, scheduleDate, scheduleWindow)
    setScheduleSaving(false)
    if (saved) setScheduleDialogOpen(false)
  }

  const handleAttachmentFiles = (files: FileList | null) => {
    const nextFiles = Array.from(files || [])
    if (nextFiles.length) onAddAttachments(activeJob.id, nextFiles)
    if (attachmentInputRef.current) attachmentInputRef.current.value = ''
  }

  const updateItem = (itemId: string, patch: Partial<FinanceItem>) => {
    onFinanceItemsChange(
      activeJob.id,
      financeItems.map((item) => (item.id === itemId ? { ...item, ...patch } : item)),
    )
  }

  const addItem = () => {
    onFinanceItemsChange(activeJob.id, [
      ...financeItems,
      {
        id: createFinanceId('item'),
        label: '',
        amount: 0,
      },
    ])
  }

  const deleteItem = (itemId: string) => {
    onFinanceItemsChange(
      activeJob.id,
      financeItems.filter((item) => item.id !== itemId),
    )
  }

  return (
    <div className="details-panel details-page-panel workiz-job-detail">
      <header className="workiz-job-header">
        <button className="workiz-icon-button" type="button" onClick={onBack} aria-label="Back to jobs">
          <ChevronLeft size={30} />
        </button>
        <h3>Job #{orderNumber}</h3>
        <a className="workiz-icon-button" href={mapsDirectionsUrl(activeJob.address)} target="_blank" rel="noreferrer" aria-label="Navigate">
          <Send size={30} />
        </a>
      </header>

      <div className="job-tabs workiz-tabs" role="tablist" aria-label="Order sections">
        <button className={tab === 'details' ? 'active' : ''} type="button" onClick={() => setTab('details')}>
          Details
        </button>
        <button className={tab === 'finance' ? 'active' : ''} type="button" onClick={() => setTab('finance')}>
          Finance
        </button>
        <button className={tab === 'timeline' ? 'active' : ''} type="button" onClick={() => setTab('timeline')}>
          Timeline
        </button>
      </div>

      {tab === 'details' ? (
        <section className="workiz-details">
          <a className="workiz-map" href={mapsDirectionsUrl(activeJob.address)} target="_blank" rel="noreferrer" aria-label="Open navigation">
            <iframe title="Service location map" src={mapPreviewUrl} loading="lazy" />
          </a>

          <div className="workiz-quick-actions" aria-label="Job actions">
            <button type="button" onClick={() => onStatusChange(activeJob.id, 'in_progress')}>
              <span><PlayCircle size={26} /></span>
              Start
            </button>
            <a href={mapsDirectionsUrl(activeJob.address)} target="_blank" rel="noreferrer">
              <span><Truck size={26} /></span>
              ETA
            </a>
            <button type="button" onClick={openPaymentDialog} disabled={activeJob.paid || paymentBusy}>
              <span><CreditCard size={26} /></span>
              Pay
            </button>
            <button type="button">
              <span><ClipboardList size={26} /></span>
              Add note
            </button>
            <button type="button" onClick={() => attachmentInputRef.current?.click()}>
              <span><Paperclip size={26} /></span>
              Attach
            </button>
            <input
              ref={attachmentInputRef}
              accept="image/*"
              multiple
              type="file"
              className="visually-hidden-file"
              onChange={(event) => handleAttachmentFiles(event.currentTarget.files)}
            />
          </div>

          <section className="workiz-section">
            <h4>Job name</h4>
            <button className="workiz-field-row muted" type="button">
              <span>Add job name</span>
              <ChevronDown size={25} />
            </button>
          </section>

          <section className="workiz-section">
            <h4>Description</h4>
            <div className="workiz-description-box">
              <span>{activeJob.issue || 'No description added'}</span>
            </div>
          </section>

          <section className="workiz-section">
            <h4>Status</h4>
            <div className="workiz-select-row">
              <Wrench size={25} />
              <select value={activeJob.status} onChange={(event) => onStatusChange(activeJob.id, event.target.value as JobStatus)}>
                {(['new', 'scheduled', 'in_progress', 'complete', 'canceled'] as JobStatus[]).map((status) => (
                  <option key={status} value={status}>
                    {statusLabels[status]}
                  </option>
                ))}
              </select>
              <ChevronDown size={25} />
            </div>
          </section>

          <section className="workiz-section">
            <div className="workiz-section-title-row">
              <h4>Client</h4>
              <button type="button" onClick={() => onOpenClient(activeJob.id)}>View client details</button>
            </div>
            <button className="workiz-field-row" type="button">
              <UsersRound size={25} />
              <span>{activeJob.customer}</span>
              <ChevronRight size={25} />
            </button>
            <a className="workiz-field-row" href={mapsDirectionsUrl(activeJob.address)} target="_blank" rel="noreferrer">
              <MapPin size={25} />
              <span>{activeJob.address}</span>
              <ChevronDown size={25} />
            </a>
            <div className="workiz-field-row phone-row">
              <Phone size={25} />
              <a href={`tel:${activeJob.phone}`}>{activeJob.phone}</a>
              <span className="workiz-round-actions">
                <a href={`tel:${activeJob.phone}`} aria-label="Call customer"><Phone size={22} /></a>
                <a href={`sms:${activeJob.phone}`} aria-label="Message customer"><MessageSquare size={22} /></a>
              </span>
            </div>
            <label className="workiz-email-row">
              <Mail size={23} />
              <input
                autoComplete="email"
                placeholder="Customer email"
                type="email"
                value={activeJob.email}
                onChange={(event) => onEmailChange(activeJob.id, event.target.value)}
              />
            </label>
          </section>

          <section className="workiz-section">
            <h4>Schedule</h4>
            <button className="workiz-field-row" type="button" onClick={() => setScheduleDialogOpen(true)}>
              <CalendarDays size={25} />
              <span>{scheduleLine}</span>
              <ChevronDown size={25} />
            </button>
          </section>

          <section className="workiz-section">
            <h4>Details</h4>
            <button className="workiz-field-row" type="button">
              <Wrench size={25} />
              <span>{activeJob.appliance}</span>
              <ChevronRight size={25} />
            </button>
          </section>

          <section className="workiz-section">
            <h4>Job tags</h4>
            <button className="workiz-field-row" type="button">
              <Tag size={25} />
              <span className={`workiz-tag ${activeJob.status}`}>{statusLabels[activeJob.status]}</span>
              <ChevronRight size={25} />
            </button>
          </section>

          <section className="workiz-section">
            <h4>Team</h4>
            {canAssignTechnicians ? (
              <label className="workiz-select-row">
                <UsersRound size={25} />
                <select
                  value={activeJob.createdByUserId || ''}
                  onChange={(event) => onAssignTechnician(activeJob.id, event.target.value)}
                >
                  <option value="">Unassigned</option>
                  {technicians.map((technician) => (
                    <option key={technician.user_id || technician.email} value={technician.user_id || ''}>
                      {technician.name || technician.email}
                    </option>
                  ))}
                </select>
                <ChevronRight size={25} />
              </label>
            ) : (
              <div className="workiz-field-row">
                <UsersRound size={25} />
                <span>{assignedTechnicianName}</span>
                <ChevronRight size={25} />
              </div>
            )}
          </section>

          <section className="workiz-section">
            <h4>Attachments</h4>
            {attachments.length ? (
              <div className="workiz-attachment-list">
                {attachments.map((attachment, index) => (
                  <button
                    className="workiz-field-row"
                    key={`${attachment.filename}-${index}`}
                    type="button"
                    onClick={() => setAttachmentPreview(attachment)}
                  >
                    <Paperclip size={25} />
                    <span>
                      {attachment.filename}
                      <small>{formatFileSize(attachment.size)}</small>
                    </span>
                    <ChevronRight size={25} />
                  </button>
                ))}
              </div>
            ) : (
              <button className="workiz-field-row muted" type="button" onClick={() => attachmentInputRef.current?.click()}>
                <Paperclip size={25} />
                <span>No attachments added</span>
                <ChevronRight size={25} />
              </button>
            )}
          </section>
        </section>
      ) : null}

      {tab === 'finance' ? (
        <section className="finance-section">
          <div className="finance-client">
            <strong>{activeJob.customer}</strong>
            <span>{activeJob.phone}</span>
            <small>{activeJob.address}</small>
          </div>

          <div className="finance-summary">
            <div>
              <span>Total</span>
              <strong>{formatMoney(total)}</strong>
            </div>
            <div>
              <span>Balance</span>
              <strong>{formatMoney(balance)}</strong>
            </div>
          </div>

          <button className="primary-action wide" type="button" onClick={() => onCreateInvoice(activeJob.id)}>
            <ClipboardList size={18} />
            Create Invoice
          </button>
          <button className="back-button wide" type="button" onClick={() => setInvoicePreviewOpen(true)}>
            <ClipboardList size={18} />
            View invoice
          </button>

          <div className="finance-heading">
            <h4>Items</h4>
            <button className="mini-action" type="button" onClick={addItem}>
              <Plus size={16} />
              Add item
            </button>
          </div>

          <div className="items-list">
            {financeItems.length ? (
              financeItems.map((item) => (
                <div className="item-row" key={item.id}>
                  <input
                    aria-label="Item name"
                    value={item.label}
                    onChange={(event) => updateItem(item.id, { label: event.target.value })}
                    placeholder="Labor, parts..."
                  />
                  <input
                    aria-label="Item amount"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    type="number"
                    value={item.amount || ''}
                    onChange={(event) => updateItem(item.id, { amount: normalizeMoneyInput(event.target.value) })}
                    placeholder="0.00"
                  />
                  <button type="button" aria-label="Delete item" onClick={() => deleteItem(item.id)}>
                    <Trash2 size={16} />
                  </button>
                </div>
              ))
            ) : (
              <div className="empty-state compact">No items yet</div>
            )}
          </div>
        </section>
      ) : null}

      {tab === 'timeline' ? (
        <section className="finance-section">
          <div className="finance-summary">
            <div>
              <span>Total</span>
              <strong>{formatMoney(total)}</strong>
            </div>
            <div>
              <span>Paid</span>
              <strong>{formatMoney(paidTotal)}</strong>
            </div>
            <div>
              <span>Balance</span>
              <strong>{formatMoney(balance)}</strong>
            </div>
          </div>

          {activeJob.paid && latestPayment ? (
            <div className="payment-row paid-summary payment-status-card" role="status" aria-label="Paid order">
              <CreditCard size={18} />
              <span>
                Paid
                <small>{formatPaymentDate(latestPayment.createdAt)}</small>
              </span>
              <strong>{formatMoney(latestPayment.amount)}</strong>
            </div>
          ) : (
            <button className="primary-action wide" type="button" onClick={openPaymentDialog} disabled={paymentBusy}>
              <CreditCard size={18} />
              {paymentBusy ? 'Processing payment' : 'Add payment'}
            </button>
          )}

          <div className="payments-list">
            {activeJob.payments.length ? (
              activeJob.payments.map((payment) => (
                <article className="payment-entry" key={payment.id}>
                  <div>
                    <strong>{formatMoney(payment.amount)}</strong>
                    <span>{payment.method || 'Payment'}</span>
                  </div>
                  <small>{formatPaymentDate(payment.createdAt)}</small>
                </article>
              ))
            ) : (
              <div className="empty-state compact">No payments yet</div>
            )}
          </div>

          {activeJob.paid ? (
            <>
              <button className="back-button wide" type="button" onClick={() => setInvoicePreviewOpen(true)}>
                <ClipboardList size={18} />
                View invoice
              </button>
              <button className="primary-action wide" type="button" onClick={() => onSendInvoice(activeJob.id)}>
                <ClipboardList size={18} />
                Send invoice
              </button>
              <button className="back-button wide" type="button" onClick={() => onTogglePaid(activeJob.id)}>
                Mark unpaid
              </button>
            </>
          ) : null}
        </section>
      ) : null}

      {invoicePreviewOpen ? (
        <InvoicePreview job={activeJob} orderNumber={orderNumber} onClose={() => setInvoicePreviewOpen(false)} />
      ) : null}

      {attachmentPreview ? (
        <AttachmentPreview attachment={attachmentPreview} onClose={() => setAttachmentPreview(null)} />
      ) : null}

      {scheduleDialogOpen ? (
        <div className="modal-backdrop" role="presentation">
          <form className="payment-modal schedule-modal" onSubmit={submitSchedule}>
            <div className="panel-heading">
              <h3>Edit schedule</h3>
              <span>{activeJob.customer}</span>
            </div>
            <label>
              Date
              <input
                autoFocus
                type="date"
                value={scheduleDate}
                onChange={(event) => setScheduleDate(event.target.value)}
                required
                disabled={scheduleSaving}
              />
            </label>
            <label>
              Time
              <select value={scheduleWindow} onChange={(event) => setScheduleWindow(event.target.value)} disabled={scheduleSaving}>
                {bookingWindows.map((window) => (
                  <option key={window}>{window}</option>
                ))}
              </select>
            </label>
            <div className="modal-actions">
              <button className="back-button" type="button" onClick={() => setScheduleDialogOpen(false)} disabled={scheduleSaving}>
                Cancel
              </button>
              <button className="primary-action" type="submit" disabled={!scheduleDirty || scheduleSaving}>
                {scheduleSaving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {paymentDialogOpen ? (
        <div className="modal-backdrop" role="presentation">
          <form className="payment-modal" onSubmit={submitPayment}>
            <div className="panel-heading">
              <h3>Add payment</h3>
              <span>{formatMoney(balance)} balance</span>
            </div>
            <label>
              Amount
              <input
                autoFocus
                inputMode="decimal"
                min="0.5"
                step="0.01"
                type="number"
                value={paymentAmount}
                onChange={(event) => setPaymentAmount(event.target.value)}
                placeholder="0.00"
              />
            </label>
            {isNativeApp ? (
              <button className="back-button wide" type="button" onClick={onEnableBluetooth}>
                <Smartphone size={18} />
                Enable Bluetooth
              </button>
            ) : null}
            <div className="modal-actions">
              <button className="back-button" type="button" onClick={() => setPaymentDialogOpen(false)}>
                Cancel
              </button>
              <button className="primary-action" disabled={paymentBusy} type="submit">
                {isNativeApp ? 'Tap to Pay' : 'Done'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  )
}

function AttachmentPreview({
  attachment,
  onClose,
}: {
  attachment: ModelPhotoAttachment
  onClose: () => void
}) {
  return (
    <div className="attachment-preview-backdrop">
      <section className="attachment-preview" aria-label="Attachment preview">
        <header>
          <button className="workiz-icon-button" type="button" onClick={onClose} aria-label="Close attachment">
            <ChevronLeft size={28} />
          </button>
          <strong>{attachment.filename}</strong>
        </header>
        <img src={attachmentDataUrl(attachment)} alt={attachment.filename} />
      </section>
    </div>
  )
}

function TimeOffDialog({
  blocks,
  onClose,
  onDelete,
  onSave,
}: {
  blocks: AvailabilityBlock[]
  onClose: () => void
  onDelete: (id: string) => void
  onSave: (date: string, allDay: boolean, windows: string[], reason: string) => void
}) {
  const [date, setDate] = useState(formatLocalDate())
  const [allDay, setAllDay] = useState(true)
  const [windows, setWindows] = useState<string[]>([])
  const [reason, setReason] = useState('Time off')

  const toggleWindow = (window: string) => {
    setWindows((current) => (current.includes(window) ? current.filter((item) => item !== window) : [...current, window]))
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    onSave(date, allDay, windows, reason)
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="payment-modal time-off-modal" onSubmit={submit}>
        <div className="panel-heading">
          <h3>Time off</h3>
          <span>Block booking slots</span>
        </div>
        <label>
          Date
          <input autoFocus type="date" value={date} onChange={(event) => setDate(event.target.value)} required />
        </label>
        <label className="check-row">
          <input type="checkbox" checked={allDay} onChange={(event) => setAllDay(event.target.checked)} />
          <span>All day</span>
        </label>
        {!allDay ? (
          <div className="time-off-slots" aria-label="Time off slots">
            {bookingWindows.map((window) => (
              <label key={window}>
                <input type="checkbox" checked={windows.includes(window)} onChange={() => toggleWindow(window)} />
                <span>{formatBookingWindow(window)}</span>
              </label>
            ))}
          </div>
        ) : null}
        <label>
          Reason
          <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Day off, personal, unavailable..." />
        </label>
        {blocks.length ? (
          <div className="time-off-list">
            {blocks.slice(0, 12).map((block) => (
              <article key={block.id}>
                <span>
                  <strong>{formatDisplayDate(block.blocked_date)}</strong>
                  <small>{block.all_day ? 'All day' : formatBookingWindow(block.service_window || '')}</small>
                </span>
                <button type="button" aria-label="Delete time off" onClick={() => onDelete(block.id)}>
                  <Trash2 size={16} />
                </button>
              </article>
            ))}
          </div>
        ) : null}
        <div className="modal-actions">
          <button className="back-button" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-action" type="submit" disabled={!allDay && !windows.length}>
            Save
          </button>
        </div>
      </form>
    </div>
  )
}

type ScheduleGroup = {
  date: string
  jobs: Job[]
}

function ScheduleTimeline({
  groups,
  orderNumbers,
  todayDate,
  onOpenJob,
  onDoneJob,
  onCancelJob,
  onDeleteJob,
}: {
  groups: ScheduleGroup[]
  orderNumbers: Map<string, string>
  todayDate: string
  onOpenJob: (id: string) => void
  onDoneJob: (id: string) => void
  onCancelJob: (id: string) => void
  onDeleteJob: (id: string) => void
}) {
  const [openMenuJobId, setOpenMenuJobId] = useState<string | null>(null)

  if (!groups.length) {
    return (
      <section className="schedule-timeline empty-schedule">
        <div className="empty-state">No jobs scheduled</div>
      </section>
    )
  }

  let currentMonth = ''

  return (
    <section className="schedule-timeline" aria-label="Scheduled jobs">
      {groups.map((group) => {
        const month = formatScheduleMonth(group.date)
        const showMonth = month !== currentMonth
        currentMonth = month

        return (
          <div className="schedule-day-group" key={group.date}>
            {showMonth ? <div className="schedule-month-divider">{month}</div> : null}
            <div className="schedule-day-row">
              <div className={`schedule-date-rail ${group.date === todayDate ? 'today' : ''}`}>
                <span>{formatScheduleWeekday(group.date)}</span>
                <strong>{formatScheduleDay(group.date)}</strong>
              </div>
              <div className="schedule-job-stack">
                {group.jobs.map((job) => (
                  <article className="schedule-card" key={job.id}>
                    <span className={`schedule-card-bar ${job.status}`} />
                    <button
                      className="schedule-card-menu"
                      type="button"
                      aria-label={`Open ORDER# ${orderNumbers.get(job.id) || formatOrderNumber(1)} menu`}
                      onClick={(event) => {
                        event.stopPropagation()
                        setOpenMenuJobId((current) => (current === job.id ? null : job.id))
                      }}
                    >
                      ...
                    </button>
                    {openMenuJobId === job.id ? (
                      <div className="schedule-card-popover">
                        <button
                          type="button"
                          onClick={() => {
                            setOpenMenuJobId(null)
                            onDoneJob(job.id)
                          }}
                        >
                          Done
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setOpenMenuJobId(null)
                            onCancelJob(job.id)
                          }}
                        >
                          Canceled
                        </button>
                        <button
                          className="danger"
                          type="button"
                          onClick={() => {
                            setOpenMenuJobId(null)
                            onDeleteJob(job.id)
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    ) : null}
                    <button className="schedule-card-open" type="button" onClick={() => onOpenJob(job.id)}>
                      <span className="schedule-card-body">
                      <span className="schedule-card-meta">
                        <span className="order-label">ORDER# {orderNumbers.get(job.id) || formatOrderNumber(1)}</span>
                        <span className="schedule-card-separator" />
                        <span>{statusLabels[job.status]}</span>
                      </span>
                      <strong>
                        {formatBookingWindow(job.window)}
                        <span> ({job.appliance})</span>
                      </strong>
                      <span className="schedule-card-customer">{job.customer}</span>
                      <span className="schedule-card-address">
                        <MapPin size={18} />
                        {job.address}
                      </span>
                      <span className="schedule-card-footer">
                        <span className={`schedule-status-badge ${job.status}`}>{statusLabels[job.status]}</span>
                        <span className="schedule-technician">{scheduleTechnicianLabel(job)}</span>
                      </span>
                      </span>
                      <span className="schedule-avatar">{technicianInitials(job)}</span>
                    </button>
                  </article>
                ))}
              </div>
            </div>
          </div>
        )
      })}
    </section>
  )
}

function InvoicePreview({ job, orderNumber, onClose }: { job: Job; orderNumber: string; onClose: () => void }) {
  const items = job.financeItems.length ? job.financeItems : defaultFinanceItems(job.invoice)
  const total = jobTotal(job)
  const paid = jobPaymentsTotal(job.payments)
  const balance = jobBalance(job)

  return (
    <div className="invoice-preview-backdrop">
      <section className="invoice-preview" aria-label="Invoice preview">
        <div className="invoice-preview-top">
          <button className="back-button" type="button" onClick={onClose}>
            <ArrowLeft size={18} />
            Close
          </button>
          <strong>INVOICE</strong>
        </div>

        <div className="invoice-sheet">
          <header className="invoice-title-row">
            <img src="/favicon.png" alt="Alex Appliance Repair" />
            <h2>INVOICE</h2>
          </header>

          <div className="invoice-meta-grid">
            <div>
              <strong>Aksenov LLC</strong>
              <span>6463 Bayside S Dr Indianapolis IN 46250</span>
              <span>(463) 248-8429</span>
              <span>alexeasyrepair@gmail.com</span>
            </div>
            <dl>
              <div>
                <dt>Invoice #</dt>
                <dd>{orderNumber}</dd>
              </div>
              <div>
                <dt>Date</dt>
                <dd>{formatInvoiceDate(new Date().toISOString())}</dd>
              </div>
              <div>
                <dt>Balance</dt>
                <dd>{formatMoney(balance)}</dd>
              </div>
              <div>
                <dt>Due On</dt>
                <dd>{formatInvoiceDate(job.date)}</dd>
              </div>
            </dl>
          </div>

          <div className="invoice-address-grid">
            <div>
              <strong>Bill To:</strong>
              <span>{job.customer}</span>
              <span>{job.address}</span>
              <span>{job.phone}</span>
              {job.email ? <span>{job.email}</span> : null}
            </div>
            <div>
              <strong>Service Location:</strong>
              <span>{job.customer}</span>
              <span>{job.address}</span>
              <span>{job.phone}</span>
            </div>
          </div>

          <table className="invoice-table">
            <thead>
              <tr>
                <th>Description</th>
                <th>QTY</th>
                <th>Price</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{item.label || 'Service'}</td>
                  <td>1.00</td>
                  <td>{formatMoney(item.amount)}</td>
                  <td>{formatMoney(item.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="invoice-totals">
            <div>
              <span>Sub total</span>
              <strong>{formatMoney(total)}</strong>
            </div>
            <div>
              <span>Total</span>
              <strong>{formatMoney(total)}</strong>
            </div>
            <div>
              <span>Paid</span>
              <strong>{formatMoney(paid)}</strong>
            </div>
            <div>
              <span>Balance Due</span>
              <strong>{formatMoney(balance)}</strong>
            </div>
          </div>

          <section className="invoice-history">
            <h3>Payment history</h3>
            {job.payments.length ? (
              job.payments.map((payment) => (
                <div key={payment.id}>
                  <span>{formatPaymentDate(payment.createdAt)}</span>
                  <span>{payment.method || 'Payment'}</span>
                  <strong>{formatMoney(payment.amount)}</strong>
                </div>
              ))
            ) : (
              <p>No payments yet</p>
            )}
          </section>

          <p className="invoice-terms">
            <strong>Terms:</strong>
            By paying the due balance on invoices provided, the Client hereby acknowledges that all requested service
            items for this date and/or any other dates listed above in the description section of the table, have been
            performed and have been tested showing successful satisfactory install/repair, unless otherwise stated on
            the invoice, in which labor service charges still apply if any repairs have been made. By accepting this
            invoice, the Client agrees to pay in full the amount listed in the Total section of the invoice.
          </p>

          <p className="invoice-notes">
            <strong>Notes:</strong>
          </p>

          <p className="invoice-thanks">Thank you for your business!</p>
        </div>
      </section>
    </div>
  )
}

function useStoredJobs(authToken?: string): [Job[], Dispatch<SetStateAction<Job[]>>] {
  const [jobs, setJobs] = useState<Job[]>(() => {
    if (isApiConfigured) return []

    const saved = localStorage.getItem('alex-appliance-jobs')
    return saved ? (JSON.parse(saved) as Job[]).map(normalizeStoredJob) : starterJobs
  })

  useEffect(() => {
    let ignore = false

    async function loadJobs() {
      if (isApiConfigured) {
        if (!authToken) {
          if (!ignore) setJobs([])
          return
        }

        const data = await fetchJobsFromApi(authToken)
        if (!ignore && data) setJobs(data.map(rowToJob))
        return
      }

      if (!isSupabaseConfigured || !supabase) return

      const { data, error } = await supabase.from('jobs').select('*').order('created_at', { ascending: false })
      if (!ignore && !error && data?.length) setJobs(data.map(rowToJob))
    }

    void loadJobs().catch(() => undefined)

    return () => {
      ignore = true
    }
  }, [authToken])

  useEffect(() => {
    localStorage.setItem('alex-appliance-jobs', JSON.stringify(jobs))
  }, [jobs])

  return [jobs, setJobs]
}

function useStoredAuth(): [AuthSession | null, Dispatch<SetStateAction<AuthSession | null>>] {
  const [auth, setAuth] = useState<AuthSession | null>(() => {
    const saved = localStorage.getItem('alex-crm-auth')
    if (!saved) return null

    try {
      return JSON.parse(saved) as AuthSession
    } catch {
      return null
    }
  })

  useEffect(() => {
    if (auth) {
      localStorage.setItem('alex-crm-auth', JSON.stringify(auth))
      return
    }

    localStorage.removeItem('alex-crm-auth')
  }, [auth])

  return [auth, setAuth]
}

function mapsDirectionsUrl(address: string) {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}&travelmode=driving`
}

function isTextEditingSwipeTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
}

function createJobId() {
  return `J-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
}

const businessTimeZone = 'America/Indianapolis'
const publicBookingLeadTimeMinutes = 120

function formatLocalDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone: businessTimeZone,
    year: 'numeric',
  }).formatToParts(date)
  const getPart = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || ''
  return `${getPart('year')}-${getPart('month')}-${getPart('day')}`
}

function formatDisplayDate(value: string) {
  return formatBookingLongDate(value)
}

function matchesJobSearch(job: Job, search: string) {
  return [job.customer, job.address, job.appliance, job.issue, job.phone].join(' ').toLowerCase().includes(search)
}

function isActiveScheduleJob(job: Job) {
  return job.status !== 'complete' && job.status !== 'canceled'
}

function groupJobsByScheduleDate(jobs: Job[]): ScheduleGroup[] {
  const byDate = new Map<string, Job[]>()

  for (const job of jobs) {
    const date = normalizeBookingDateValue(job.date) || formatLocalDate()
    byDate.set(date, [...(byDate.get(date) || []), job])
  }

  return [...byDate.entries()]
    .sort(([firstDate], [secondDate]) => firstDate.localeCompare(secondDate))
    .map(([date, dateJobs]) => ({
      date,
      jobs: [...dateJobs].sort((first, second) => {
        const byWindow = scheduleWindowSortValue(first.window) - scheduleWindowSortValue(second.window)
        if (byWindow) return byWindow
        return orderSortValue(first).localeCompare(orderSortValue(second))
      }),
    }))
}

function scheduleWindowSortValue(value: string) {
  const match = value.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i)
  if (!match) return Number.MAX_SAFE_INTEGER
  return toTwentyFourHour(Number(match[1]), match[3]) * 60 + Number(match[2])
}

function scheduleDate(value: string) {
  const normalizedDate = normalizeBookingDateValue(value)
  return bookingDateToBusinessDate(normalizedDate)
}

function bookingDateToBusinessDate(value: string) {
  const normalizedDate = normalizeBookingDateValue(value)
  const match = normalizedDate.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0))
  return Number.isNaN(date.getTime()) ? null : date
}

function formatScheduleMonth(value: string) {
  const date = scheduleDate(value)
  if (!date) return 'SCHEDULED'
  return new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(date).toUpperCase()
}

function formatScheduleWeekday(value: string) {
  const date = scheduleDate(value)
  if (!date) return 'Date'
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(date)
}

function formatScheduleDay(value: string) {
  const date = scheduleDate(value)
  if (!date) return '--'
  return new Intl.DateTimeFormat('en-US', { day: 'numeric', timeZone: 'UTC' }).format(date)
}

function scheduleTechnicianLabel(job: Job) {
  if (job.technicianName) return `Technician: ${job.technicianName}`
  if (job.technicianEmail) return `Technician: ${job.technicianEmail}`
  return 'Technician: unassigned'
}

function technicianInitials(job: Job) {
  const source = job.technicianName || job.technicianEmail || 'Alex Appliance'
  const nameParts = source
    .replace(/@.*/, '')
    .split(/[\s._-]+/)
    .map((part) => part.trim())
    .filter(Boolean)

  if (nameParts.length >= 2) {
    return `${nameParts[0][0]}${nameParts[1][0]}`.toUpperCase()
  }

  return (nameParts[0] || 'AA').slice(0, 2).toUpperCase().padEnd(2, 'A')
}

function createOrderNumbers(jobs: Job[]) {
  return new Map(
    [...jobs]
      .sort((first, second) => orderSortValue(first).localeCompare(orderSortValue(second)))
      .map((job, index) => [job.id, formatOrderNumber(index + 1)]),
  )
}

function orderSortValue(job: Job) {
  return job.createdAt || job.id
}

function formatOrderNumber(value: number) {
  return value.toString().padStart(2, '0')
}

function createFinanceId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizeMoneyInput(value: string | number) {
  const amount = Math.max(0, Math.round(Number(value || 0) * 100) / 100)
  return Number.isFinite(amount) ? amount : 0
}

function defaultFinanceItems(invoice = 0): FinanceItem[] {
  return [
    { id: createFinanceId('item'), label: 'Labor', amount: normalizeMoneyInput(invoice) },
    { id: createFinanceId('item'), label: 'Parts', amount: 0 },
  ]
}

function normalizeFinanceItems(items: unknown, invoice = 0): FinanceItem[] {
  if (Array.isArray(items)) {
    const normalized = items
      .map((item) => {
        const value = item as Partial<FinanceItem>
        return {
          id: String(value.id || createFinanceId('item')),
          label: String(value.label || ''),
          amount: normalizeMoneyInput(value.amount || 0),
        }
      })
      .filter((item) => item.label || item.amount > 0)

    if (normalized.length) return normalized
  }

  return defaultFinanceItems(invoice)
}

function normalizePayments(payments: unknown): PaymentEntry[] {
  if (!Array.isArray(payments)) return []

  return payments
    .map((payment) => {
      const value = payment as Partial<PaymentEntry>
      return {
        id: String(value.id || createFinanceId('payment')),
        amount: normalizeMoneyInput(value.amount || 0),
        createdAt: String(value.createdAt || new Date().toISOString()),
        method: value.method ? String(value.method) : undefined,
        paymentIntentId: value.paymentIntentId ? String(value.paymentIntentId) : undefined,
        status: value.status ? String(value.status) : undefined,
      }
    })
    .filter((payment) => payment.amount > 0)
}

function normalizeModelPhotoAttachments(attachments: unknown): ModelPhotoAttachment[] {
  if (!Array.isArray(attachments)) return []

  return attachments
    .map((attachment) => {
      const value = attachment as Partial<ModelPhotoAttachment>
      return {
        filename: String(value.filename || 'model-sticker.jpg'),
        contentType: String(value.contentType || 'image/jpeg'),
        content: String(value.content || ''),
        size: Number(value.size || 0),
      }
    })
    .filter((attachment) => attachment.content && attachment.contentType.startsWith('image/'))
}

function attachmentDataUrl(attachment: ModelPhotoAttachment) {
  return `data:${attachment.contentType || 'image/jpeg'};base64,${attachment.content}`
}

async function filesToModelPhotoAttachments(files: File[]) {
  if (files.length > 5) throw new Error('Upload no more than 5 photos at once')

  let totalSize = 0
  const attachments: ModelPhotoAttachment[] = []
  for (const file of files) {
    totalSize += file.size
    if (!file.type.startsWith('image/')) throw new Error('Attachment must be an image file')
    if (file.size > 8 * 1024 * 1024) throw new Error('Each photo must be under 8 MB')
    if (totalSize > 16 * 1024 * 1024) throw new Error('Photos must be under 16 MB total')
    attachments.push({
      filename: file.name || 'attachment.jpg',
      contentType: file.type || 'image/jpeg',
      content: await fileToBase64Content(file),
      size: file.size,
    })
  }

  return attachments
}

function fileToBase64Content(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      resolve(result.includes(',') ? result.split(',').pop() || '' : result)
    }
    reader.onerror = () => reject(reader.error || new Error('Unable to read file'))
    reader.readAsDataURL(file)
  })
}

function formatFileSize(size: number) {
  if (!Number.isFinite(size) || size <= 0) return 'Image'
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function stringArraysEqual(first: string[], second: string[]) {
  if (first.length !== second.length) return false
  return first.every((value, index) => value === second[index])
}

function getCurrentAppBuildAsset() {
  return [...document.scripts]
    .map((script) => script.getAttribute('src') || '')
    .map((src) => getBuildAssetFromHtml(src))
    .find(Boolean) || ''
}

function getBuildAssetFromHtml(value: string) {
  return value.match(/assets\/index-[^"']+\.js/)?.[0] || ''
}

function financeTotal(items: FinanceItem[]) {
  return normalizeMoneyInput((items || []).reduce((sum, item) => sum + normalizeMoneyInput(item.amount), 0))
}

function jobTotal(job: Job) {
  const itemTotal = financeTotal(job.financeItems || [])
  return itemTotal > 0 ? itemTotal : normalizeMoneyInput(job.invoice)
}

function jobPaymentsTotal(payments: PaymentEntry[]) {
  return normalizeMoneyInput((payments || []).reduce((sum, payment) => sum + normalizeMoneyInput(payment.amount), 0))
}

function jobBalance(job: Job) {
  return normalizeMoneyInput(Math.max(0, jobTotal(job) - jobPaymentsTotal(job.payments)))
}

function appendPayment(job: Job, amount: number, details: Partial<PaymentEntry>) {
  const paymentAmount = normalizeMoneyInput(amount)
  const payment: PaymentEntry = {
    id: createFinanceId('payment'),
    amount: paymentAmount,
    createdAt: new Date().toISOString(),
    method: details.method,
    paymentIntentId: details.paymentIntentId,
    status: details.status,
  }
  const payments = [...job.payments, payment]
  const currentTotal = jobTotal(job)
  const invoice = Math.max(currentTotal, jobPaymentsTotal(payments))
  const financeItems = currentTotal > 0 ? job.financeItems : defaultFinanceItems(invoice)
  return {
    ...job,
    financeItems,
    invoice,
    payments,
    paid: invoice > 0 && jobPaymentsTotal(payments) >= invoice,
  }
}

function formatMoney(value: number) {
  return `$${normalizeMoneyInput(value).toFixed(2)}`
}

function formatPaymentDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

function formatInvoiceDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date)
}

function createBookingWeek(weekOffset: number) {
  const currentValue = formatLocalDate()
  const current = bookingDateToBusinessDate(currentValue) || new Date()
  const day = current.getUTCDay()
  const mondayOffset = day === 0 ? -6 : 1 - day
  const weekStartValue = addDaysToBookingDate(currentValue, mondayOffset + weekOffset * 7)

  return Array.from({ length: 7 }, (_, index) => {
    const value = addDaysToBookingDate(weekStartValue, index)
    const date = bookingDateToBusinessDate(value) || current
    const disabled = value < currentValue || date.getUTCDay() === 0
    return {
      value,
      weekday: new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(date),
      day: new Intl.DateTimeFormat('en-US', { day: 'numeric', timeZone: 'UTC' }).format(date),
      disabled,
    }
  })
}

function addDaysToBookingDate(value: string, days: number) {
  const date = bookingDateToBusinessDate(value)
  if (!date) return formatLocalDate()
  date.setUTCDate(date.getUTCDate() + days)
  return [
    String(date.getUTCFullYear()),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-')
}

function formatBookingLongDate(value: string) {
  const bookingDate = normalizeBookingDateValue(value)
  const date = bookingDateToBusinessDate(bookingDate)
  if (!date) return bookingDate || value
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}

function formatJobScheduleLine(dateValue: string, window: string) {
  const bookingDate = normalizeBookingDateValue(dateValue)
  const date = bookingDateToBusinessDate(bookingDate)
  if (!date) return formatBookingWindow(window)

  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(date)
  const month = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(date)
  return `${weekday}, ${month} ${formatOrdinalDay(date.getUTCDate())} ${formatBookingWindow(window)}`
}

function formatOrdinalDay(day: number) {
  const suffix = day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th'
  return `${day}${suffix}`
}

function normalizeBookingDateValue(value: string) {
  const text = String(value || '').trim()
  if (!text) return ''

  const isoDate = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)
  if (isoDate) return `${isoDate[1]}-${isoDate[2]}-${isoDate[3]}`

  const usDate = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (usDate) {
    return `${usDate[3]}-${usDate[1].padStart(2, '0')}-${usDate[2].padStart(2, '0')}`
  }

  const monthDate = text
    .replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, '$1')
    .match(/^(?:[a-z]{3,9},?\s+)?([a-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/i)
  if (monthDate) {
    const month = monthNameToNumber(monthDate[1])
    if (month) return `${monthDate[3]}-${month}-${monthDate[2].padStart(2, '0')}`
  }

  return ''
}

function monthNameToNumber(value: string) {
  const month = value.toLowerCase().slice(0, 3)
  const index = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(month)
  return index === -1 ? '' : String(index + 1).padStart(2, '0')
}

function normalizeServiceWindowValue(value: string) {
  const text = String(value || '').trim()
  if (!text) return ''

  const compact = text.replace(/\s+/g, '').replace(/[–—]/g, '-').toLowerCase()
  return bookingWindows.find((window) => window.replace(/\s+/g, '').toLowerCase() === compact) || text
}

function isPublicBookingWindowInLeadTime(date: string, window: string) {
  const normalizedDate = normalizeBookingDateValue(date)
  const now = businessNow()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) return false
  if (normalizedDate < now.date) return false
  if (normalizedDate > now.date) return true

  const startMinutes = bookingWindowStartMinutes(window)
  if (startMinutes === null) return false
  return startMinutes - now.minutes >= publicBookingLeadTimeMinutes
}

function bookingWindowStartMinutes(window: string) {
  const normalizedWindow = normalizeServiceWindowValue(window)
  const match = normalizedWindow.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)/i)
  if (!match) return null

  return toTwentyFourHour(Number(match[1]), match[3]) * 60 + Number(match[2])
}

function businessNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    timeZone: businessTimeZone,
    year: 'numeric',
  }).formatToParts(new Date())
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || ''
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    minutes: Number(part('hour')) * 60 + Number(part('minute')),
  }
}

function formatBookingWindow(value: string) {
  return normalizeServiceWindowValue(value).replace(/\s+/g, '').replace(/AM/g, 'am').replace(/PM/g, 'pm')
}

function formatBookingAddress(details: {
  address: string
  city: string
  state: string
  zip: string
}) {
  return [
    details.address.trim(),
    details.city.trim(),
    [details.state.trim(), details.zip.trim()].filter(Boolean).join(' '),
  ]
    .filter(Boolean)
    .join(', ')
}

function parseGoogleAddress(place: google.maps.places.PlaceResult) {
  const result = { address: '', city: '', state: '', zip: '' }
  const components = place.address_components || []
  const streetNumber = components.find((component) => component.types.includes('street_number'))?.long_name || ''
  const route = components.find((component) => component.types.includes('route'))?.long_name || ''
  result.address = [streetNumber, route].filter(Boolean).join(' ')
  result.city =
    components.find((component) => component.types.includes('locality'))?.long_name ||
    components.find((component) => component.types.includes('sublocality'))?.long_name ||
    ''
  result.state = components.find((component) => component.types.includes('administrative_area_level_1'))?.long_name || ''
  result.zip = components.find((component) => component.types.includes('postal_code'))?.long_name || ''
  return result
}

function downloadBookingCalendar(job: JobRow) {
  const normalizedServiceDate = normalizeBookingDateValue(job.service_date)
  const date = normalizedServiceDate.replace(/-/g, '')
  const windowMatch = job.service_window.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i)
  const hour = windowMatch ? toTwentyFourHour(Number(windowMatch[1]), windowMatch[3]) : 9
  const minute = windowMatch ? windowMatch[2] : '00'
  const start = `${date}T${String(hour).padStart(2, '0')}${minute}00`
  const end = `${date}T${String(hour + 2).padStart(2, '0')}${minute}00`
  const body = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Alex Appliance Repair//Booking//EN',
    'BEGIN:VEVENT',
    `UID:${job.id}@aleksappliancerepair.com`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:Alex Appliance Repair - ${job.appliance}`,
    `LOCATION:${job.address}`,
    `DESCRIPTION:${job.issue || job.appliance}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n')
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([body], { type: 'text/calendar' }))
  link.download = `alex-appointment-${normalizedServiceDate || job.service_date}.ics`
  link.click()
  URL.revokeObjectURL(link.href)
}

function toTwentyFourHour(hour: number, period: string) {
  const normalizedHour = hour === 12 ? 0 : hour
  return period.toUpperCase() === 'PM' ? normalizedHour + 12 : normalizedHour
}

function validateBookingDetails(details: {
  firstName: string
  lastName: string
  phone: string
  email: string
  address: string
  city: string
  state: string
  zip: string
  issue?: string
}, modelPhotoNames: string[] = []) {
  if (!details.firstName.trim() || !details.lastName.trim()) return 'First and last name are required.'
  if (!isValidUsPhoneNumber(details.phone)) return 'Enter a valid US phone number.'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.email.trim())) return 'Enter a valid email address.'
  if (details.address.trim().length < 6) return 'Service address is required.'
  if (!details.city.trim()) return 'City is required.'
  if (!details.state.trim()) return 'State is required.'
  if (!/^\d{5}(-\d{4})?$/.test(details.zip.trim())) return 'Enter a valid ZIP code.'
  if (!details.issue?.trim()) return 'Describe the appliance problem.'
  if (!modelPhotoNames.some((fileName) => fileName.trim())) return 'Upload a photo of the model number sticker.'
  return ''
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string') return error
  return 'Please check the connection and try again.'
}

function isValidUsPhoneNumber(phone: string) {
  const digits = phone.replace(/\D/g, '')
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(national)
}

function isTwoFactorChallenge(response: AuthLoginResponse): response is TwoFactorChallenge {
  return 'requiresTwoFactor' in response && response.requiresTwoFactor
}

function isPendingApproval(response: AuthLoginResponse): response is PendingApprovalResponse {
  return 'pendingApproval' in response && response.pendingApproval
}

function getTrustedDeviceId() {
  const key = 'alex-crm-trusted-device'
  const existing = localStorage.getItem(key)
  if (existing) return existing

  const id =
    window.crypto?.randomUUID?.() ||
    `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
  localStorage.setItem(key, id)
  return id
}

function getBookingDeviceId() {
  const key = 'alex-booking-device'
  const existing = localStorage.getItem(key)
  if (existing) return existing

  const id =
    window.crypto?.randomUUID?.() ||
    `booking-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  localStorage.setItem(key, id)
  return id
}

function loadTurnstileScript() {
  return new Promise<void>((resolve, reject) => {
    if (window.document.querySelector('script[src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"]')) {
      resolve()
      return
    }

    const script = window.document.createElement('script')
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Unable to load security check'))
    window.document.head.appendChild(script)
  })
}

function getTurnstile() {
  const turnstile = (
    window as Window &
      typeof globalThis & {
        turnstile?: {
          render: (
            element: HTMLElement,
            options: {
              sitekey: string
              callback: (token: string) => void
              'expired-callback': () => void
              'error-callback': () => void
            },
          ) => string
        }
      }
  ).turnstile

  if (!turnstile) throw new Error('Security check did not load')
  return turnstile
}

function loadGoogleIdentityScript() {
  return new Promise<void>((resolve, reject) => {
    if (window.document.querySelector('script[src="https://accounts.google.com/gsi/client"]')) {
      resolve()
      return
    }

    const script = window.document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Unable to load Google sign in'))
    window.document.head.appendChild(script)
  })
}

function getGoogleIdentity() {
  const google = (
    window as Window &
      typeof globalThis & {
        google?: {
          accounts: {
            id: {
              initialize: (config: {
                client_id: string
                callback: (response: { credential?: string }) => void
              }) => void
              renderButton: (
                element: HTMLElement,
                options: {
                  shape: string
                  size: string
                  text: string
                  theme: string
                  width: number
                },
              ) => void
            }
          }
        }
      }
  ).google

  if (!google) throw new Error('Google sign in did not load')
  return google
}

function jobToRow(job: Job): JobRow {
  return {
    id: job.id,
    customer: job.customer,
    phone: job.phone,
    email: job.email || null,
    address: job.address,
    appliance: job.appliance,
    issue: job.issue,
    service_date: normalizeBookingDateValue(job.date) || job.date,
    service_window: normalizeServiceWindowValue(job.window),
    status: job.status,
    invoice: job.invoice,
    paid: job.paid,
    finance_items: job.financeItems || [],
    payments: job.payments || [],
    model_photo_attachments: normalizeModelPhotoAttachments(job.modelPhotoAttachments || []),
    lat: job.lat,
    lng: job.lng,
    created_by_user_id: job.createdByUserId || null,
  }
}

function normalizeStoredJob(job: Job): Job {
  const invoice = normalizeMoneyInput(job.invoice)
  const financeItems = normalizeFinanceItems(job.financeItems, invoice)
  const payments = normalizePayments(job.payments)
  const modelPhotoAttachments = normalizeModelPhotoAttachments(job.modelPhotoAttachments || [])

  return {
    ...job,
    email: job.email || '',
    invoice,
    paid: job.paid || (invoice > 0 && jobPaymentsTotal(payments) >= (financeTotal(financeItems) || invoice)),
    financeItems,
    payments,
    modelPhotoAttachments,
  }
}

function rowToJob(row: JobRow): Job {
  const invoice = Number(row.invoice)
  const financeItems = normalizeFinanceItems(row.finance_items, invoice)
  const payments = normalizePayments(row.payments)
  const modelPhotoAttachments = normalizeModelPhotoAttachments(row.model_photo_attachments || [])

  return {
    id: row.id,
    createdAt: row.created_at,
    customer: row.customer,
    phone: row.phone,
    email: row.email || '',
    address: row.address,
    appliance: row.appliance,
    issue: row.issue,
    date: normalizeBookingDateValue(row.service_date) || formatLocalDate(),
    window: normalizeServiceWindowValue(row.service_window),
    status: row.status,
    invoice,
    paid: row.paid || (invoice > 0 && jobPaymentsTotal(payments) >= (financeTotal(financeItems) || invoice)),
    financeItems,
    payments,
    modelPhotoAttachments,
    lat: row.lat,
    lng: row.lng,
    createdByUserId: row.created_by_user_id || null,
    technicianName: row.technician_name || null,
    technicianEmail: row.technician_email || null,
  }
}

async function saveJob(job: Job, authToken?: string) {
  if (isApiConfigured) {
    return saveJobToApi(jobToRow(job), authToken)
  }

  if (!supabase) return
  await supabase.from('jobs').upsert(jobToRow(job))
  return jobToRow(job)
}

async function deleteJob(id: string, authToken?: string, orderNumber?: string) {
  if (isApiConfigured) {
    await deleteJobFromApi(id, authToken, orderNumber)
    return
  }

  if (!supabase) return
  await supabase.from('jobs').delete().eq('id', id)
}

function ClientsPage({
  jobs,
  onAddClient,
  onOpenClient,
}: {
  jobs: Job[]
  onAddClient: () => void
  onOpenClient: (id: string) => void
}) {
  return (
    <section className="clients-page">
      <div className="panel-heading">
        <div>
          <h3>Clients</h3>
          <span>{jobs.length} records</span>
        </div>
        <button className="primary-action" type="button" onClick={onAddClient}>
          <UserPlus size={18} />
          New client
        </button>
      </div>

      <div className="client-list">
        {jobs.map((job) => (
          <button className="client-card" key={job.id} type="button" onClick={() => onOpenClient(job.id)}>
            <strong>{job.customer}</strong>
            <span>{job.phone}</span>
            {job.email ? <span>{job.email}</span> : null}
            <small>{job.address}</small>
          </button>
        ))}
      </div>
    </section>
  )
}

function ClientEditPage({
  client,
  onFieldChange,
  onOpenJob,
  onSave,
}: {
  client?: Job
  onFieldChange: (id: string, field: 'customer' | 'phone' | 'email' | 'address', value: string) => void
  onOpenJob: (id: string) => void
  onSave: (id: string) => void
}) {
  if (!client) return <div className="empty-state">No matching client</div>

  return (
    <section className="client-edit-page">
      <div className="client-edit-panel">
        <div className="panel-heading">
          <h3>Edit client</h3>
          <span>{client.id}</span>
        </div>

        <label>
          Name
          <input
            value={client.customer}
            onChange={(event) => onFieldChange(client.id, 'customer', event.target.value)}
          />
        </label>
        <label>
          Phone
          <input
            value={client.phone}
            onChange={(event) => onFieldChange(client.id, 'phone', event.target.value)}
          />
        </label>
        <label>
          Email
          <input
            autoComplete="email"
            type="email"
            value={client.email}
            onChange={(event) => onFieldChange(client.id, 'email', event.target.value)}
          />
        </label>
        <label>
          Address
          <input
            value={client.address}
            onChange={(event) => onFieldChange(client.id, 'address', event.target.value)}
          />
        </label>

        <div className="client-actions">
          <button className="back-button" type="button" onClick={() => onOpenJob(client.id)}>
            Open job
          </button>
          <button className="primary-action" type="button" onClick={() => onSave(client.id)}>
            Save
          </button>
        </div>
      </div>
    </section>
  )
}

async function syncJobPatch(
  id: string,
  patch: Partial<Pick<JobRow, 'customer' | 'phone' | 'email' | 'address' | 'paid' | 'status' | 'invoice' | 'finance_items' | 'payments' | 'model_photo_attachments' | 'service_date' | 'service_window' | 'created_by_user_id'>>,
  authToken?: string,
) {
  if (isApiConfigured) {
    return updateJobInApi(id, patch, authToken)
  }

  if (!supabase) return null
  await supabase.from('jobs').update(patch).eq('id', id)
  return null
}

export default App
