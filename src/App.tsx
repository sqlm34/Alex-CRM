import { Autocomplete, useJsApiLoader } from '@react-google-maps/api'
import { App as CapacitorApp } from '@capacitor/app'
import { Capacitor, registerPlugin } from '@capacitor/core'
import {
  ArrowLeft,
  CalendarDays,
  CalendarPlus,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  CreditCard,
  LogOut,
  Mail,
  MapPin,
  Navigation,
  Phone,
  Plus,
  Power,
  Search,
  Settings,
  Smartphone,
  Trash2,
  Upload,
  UserPlus,
  UserRound,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, FormEvent, SetStateAction } from 'react'
import './App.css'
import {
  addApprovedUser,
  configuredApiUrl,
  createPublicBooking,
  fetchCurrentUser,
  fetchApprovedUsers,
  fetchStripeTerminalConfig,
  fetchJobsFromApi,
  isApiConfigured,
  loginWithGoogle,
  loginWithPassword,
  requestSmsLogin,
  registerWithPassword,
  deleteJobFromApi,
  saveJobToApi,
  sendInvoiceEmail,
  sendHeartbeat,
  sendOffline,
  updateJobInApi,
  verifySmsCode,
} from './api'
import type { ApprovedUser, AuthLoginResponse, AuthSession, PendingApprovalResponse, TwoFactorChallenge } from './api'
import { notifyNewOrder, onPushSync, prepareOrderNotifications, unlockWebChime } from './notifications'
import { isSupabaseConfigured, supabase } from './supabase'
import type { JobRow } from './supabase'

type JobStatus = 'new' | 'scheduled' | 'in_progress' | 'complete'
type Page = 'dashboard' | 'clients' | 'clientEdit' | 'job' | 'new' | 'owner'
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
  lat: number
  lng: number
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
  complete: 'Complete',
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
    window: '10:00 AM - 12:00 PM',
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
  const autocompleteRef = useRef<google.maps.places.Autocomplete | null>(null)
  const knownJobIdsRef = useRef(new Set(jobs.map((job) => job.id)))
  const dirtyJobIdsRef = useRef(new Set<string>())
  const emailSaveTimersRef = useRef(new Map<string, number>())
  const toastTimerRef = useRef<number | null>(null)

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
  const todayJobList = useMemo(() => jobs.filter((job) => job.date === todayDate), [jobs, todayDate])
  const filteredJobs = useMemo(() => {
    const search = query.trim().toLowerCase()
    if (!search) return jobs

    return jobs.filter((job) => matchesJobSearch(job, search))
  }, [jobs, query])
  const filteredTodayJobs = useMemo(() => {
    const search = query.trim().toLowerCase()
    if (!search) return todayJobList

    return todayJobList.filter((job) => matchesJobSearch(job, search))
  }, [query, todayJobList])

  const activeJob = jobs.find((job) => job.id === activeId) ?? jobs[0]
  const orderNumbers = useMemo(() => createOrderNumbers(jobs), [jobs])
  const activeOrderNumber = activeJob ? orderNumbers.get(activeJob.id) || formatOrderNumber(1) : ''
  const todayJobs = todayJobList.length
  const unpaidTotal = jobs.reduce((sum, job) => sum + jobBalance(job), 0)
  const completedCount = jobs.filter((job) => job.status === 'complete').length
  const isBookingPage = window.location.pathname.replace(/\/+$/, '') === '/booking'

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

  const openClient = (id: string) => {
    setActiveId(id)
    setPage('clientEdit')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const deleteOrder = (id: string) => {
    const job = jobs.find((currentJob) => currentJob.id === id)
    if (!job) return

    const shouldDelete = window.confirm(`Delete ORDER# ${activeOrderNumber} for ${job.customer}?`)
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
          <button type="button">
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
        <header className="topbar">
          {page !== 'dashboard' ? (
            <button className="back-button" type="button" onClick={() => setPage('dashboard')}>
              <ArrowLeft size={18} />
              Back to jobs
            </button>
          ) : (
            <div>
              <p className="eyebrow">Today, {todayLabel}</p>
              <h2>Client work center</h2>
            </div>
          )}
          {showNewJobButton ? (
            <button className="primary-action" type="button" onClick={openNewJob}>
              <Plus size={18} />
              New job
            </button>
          ) : null}
        </header>

        {page === 'dashboard' ? (
          <>
            <section className="metrics" aria-label="Business snapshot">
              <Metric title="Jobs today" value={todayJobs.toString()} detail="Scheduled or new" />
              <Metric title="Open invoices" value={`$${unpaidTotal}`} detail="Ready to collect" />
              <Metric title="Completed" value={completedCount.toString()} detail="All-time local data" />
            </section>

            <section className="main-grid">
              <div className="jobs-panel">
                <div className="panel-heading">
                  <h3>Jobs</h3>
                  <span>{filteredTodayJobs.length} records</span>
                </div>
                <div className="job-list">
                  {filteredTodayJobs.map((job) => (
                    <button className="job-item" key={job.id} type="button" onClick={() => openJob(job.id)}>
                      <span className={`status-dot ${job.status}`} />
                      <span>
                        <span className="order-label">ORDER# {orderNumbers.get(job.id) || formatOrderNumber(1)}</span>
                        <strong>{job.customer}</strong>
                        <small>{job.appliance}</small>
                      </span>
                      <em>{statusLabels[job.status]}</em>
                    </button>
                  ))}
                </div>
              </div>

            </section>
          </>
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
                  <option>9:00 AM - 11:00 AM</option>
                  <option>10:00 AM - 12:00 PM</option>
                  <option>1:00 PM - 3:00 PM</option>
                  <option>3:00 PM - 5:00 PM</option>
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
                onStatusChange={updateStatus}
                onTogglePaid={togglePaid}
                onCollectPayment={collectPayment}
                onEnableBluetooth={enableTapToPayBluetooth}
                onFinanceItemsChange={updateFinanceItems}
                onCreateInvoice={createInvoice}
                onSendInvoice={sendInvoice}
                onEmailChange={(id, value) => updateClientField(id, 'email', value)}
                onDelete={deleteOrder}
                paymentBusy={paymentBusyId === activeJob.id}
                isNativeApp={isNativeApp}
              />
            ) : (
              <div className="empty-state">No matching jobs</div>
            )}
          </section>
        )}
      </section>
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
  const [fileNames, setFileNames] = useState<string[]>([])
  const [weekOffset, setWeekOffset] = useState(0)
  const [toast, setToast] = useState<Toast | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmedJob, setConfirmedJob] = useState<JobRow | null>(null)
  const bookingAutocompleteRef = useRef<google.maps.places.Autocomplete | null>(null)
  const toastTimerRef = useRef<number | null>(null)
  const startedAtRef = useRef(Date.now())
  const availableDates = useMemo(() => createBookingWeek(weekOffset), [weekOffset])
  const selectedDate = availableDates.find((option) => option.value === date)
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

    if (step === 2) {
      const validationError = validateBookingDetails(details)
      if (validationError) {
        showBookingToast({ type: 'error', message: 'Check your details', detail: validationError })
        return
      }
    }

    setStep((current) => Math.min(current + 1, bookingSteps.length - 1))
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const submitBooking = (event: FormEvent) => {
    event.preventDefault()

    const validationError = validateBookingDetails(details)
    if (!service || !date || !windowValue || validationError) {
      showBookingToast({
        type: 'error',
        message: 'Appointment is incomplete',
        detail: validationError || 'Please choose service, date, and time.',
      })
      return
    }

    setBusy(true)
    void createPublicBooking({
      customer: fullName,
      phone: details.phone.trim(),
      email: details.email.trim(),
      address: fullAddress,
      appliance: service,
      issue: details.issue.trim() || service,
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
                          if (!windowValue) setWindowValue(bookingWindows[0])
                        }}
                      >
                        <span>{option.weekday}</span>
                        <strong>{option.day}</strong>
                      </button>
                    ))}
                  </div>
                  <p className="booking-local-time">Times are shown in the business's local time.</p>
                  <h2>Select a visit time</h2>
                  <div className="booking-time-grid">
                    {bookingWindows.map((option) => (
                      <button
                        className={`booking-time ${windowValue === option ? 'selected' : ''}`}
                        key={option}
                        type="button"
                        onClick={() => setWindowValue(option)}
                      >
                        <span>{formatBookingWindow(option)}</span>
                      </button>
                    ))}
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
                      <span>{fileNames.length ? fileNames.join(', ') : 'Upload files here'}</span>
                      <input
                        multiple
                        type="file"
                        onChange={(event) => setFileNames(Array.from(event.currentTarget.files || []).map((file) => file.name))}
                      />
                    </label>
                    <textarea
                      rows={5}
                      value={details.issue}
                      onChange={(event) => setDetails({ ...details, issue: event.target.value })}
                      placeholder="Add your description here..."
                    />
                  </div>
                </div>
                <BookingActions onBack={() => setStep(1)} onNext={goToNextStep} />
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

function BookingActions({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  return (
    <div className="booking-actions">
      <button className="booking-secondary" type="button" onClick={onBack}>
        Back
      </button>
      <button className="booking-primary" type="button" onClick={onNext}>
        Continue
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
  onStatusChange,
  onTogglePaid,
  onCollectPayment,
  onEnableBluetooth,
  onFinanceItemsChange,
  onCreateInvoice,
  onSendInvoice,
  onEmailChange,
  onDelete,
  paymentBusy,
  isNativeApp,
}: {
  activeJob: Job
  orderNumber: string
  onStatusChange: (id: string, status: JobStatus) => void
  onTogglePaid: (id: string) => void
  onCollectPayment: (id: string, amount: number) => void
  onEnableBluetooth: () => void
  onFinanceItemsChange: (id: string, financeItems: FinanceItem[]) => void
  onCreateInvoice: (id: string) => void
  onSendInvoice: (id: string) => void
  onEmailChange: (id: string, value: string) => void
  onDelete: (id: string) => void
  paymentBusy: boolean
  isNativeApp: boolean
}) {
  const [tab, setTab] = useState<'details' | 'finance' | 'payments'>('details')
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false)
  const [invoicePreviewOpen, setInvoicePreviewOpen] = useState(false)
  const [paymentAmount, setPaymentAmount] = useState('')
  const financeItems = activeJob.financeItems.length ? activeJob.financeItems : defaultFinanceItems(activeJob.invoice)
  const total = jobTotal(activeJob)
  const paidTotal = jobPaymentsTotal(activeJob.payments)
  const balance = jobBalance(activeJob)
  const latestPayment = activeJob.payments.length ? activeJob.payments[activeJob.payments.length - 1] : null

  useEffect(() => {
    if (activeJob.financeItems.length) return
    onFinanceItemsChange(activeJob.id, defaultFinanceItems(activeJob.invoice))
  }, [activeJob.financeItems.length, activeJob.id, activeJob.invoice, onFinanceItemsChange])

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
    <div className="details-panel details-page-panel">
      <div className="details-header">
        <div>
          <p className="eyebrow order-label">ORDER# {orderNumber}</p>
          <h3>{activeJob.customer}</h3>
          <span>{activeJob.appliance}</span>
        </div>
        <span className={`status-pill ${activeJob.status}`}>{statusLabels[activeJob.status]}</span>
      </div>

      <div className="job-tabs" role="tablist" aria-label="Order sections">
        <button className={tab === 'details' ? 'active' : ''} type="button" onClick={() => setTab('details')}>
          Details
        </button>
        <button className={tab === 'finance' ? 'active' : ''} type="button" onClick={() => setTab('finance')}>
          Finance
        </button>
        <button className={tab === 'payments' ? 'active' : ''} type="button" onClick={() => setTab('payments')}>
          Payments
        </button>
      </div>

      {tab === 'details' ? (
        <>
          <div className="contact-row">
            <a href={`tel:${activeJob.phone}`}>
              <Phone size={17} />
              {activeJob.phone}
            </a>
            <a href={mapsDirectionsUrl(activeJob.address)} target="_blank" rel="noreferrer">
              <Navigation size={17} />
              Navigate
            </a>
          </div>

          <label className="order-email-field">
            Email
            <input
              autoComplete="email"
              placeholder="customer@email.com"
              type="email"
              value={activeJob.email}
              onChange={(event) => onEmailChange(activeJob.id, event.target.value)}
            />
          </label>

          <a className="address-block" href={mapsDirectionsUrl(activeJob.address)} target="_blank" rel="noreferrer">
            <MapPin size={18} />
            <span>{activeJob.address}</span>
          </a>

          <p className="issue-text">{activeJob.issue}</p>

          <div className="status-actions">
            {(['new', 'scheduled', 'in_progress', 'complete'] as JobStatus[]).map((status) => (
              <button
                className={activeJob.status === status ? 'selected' : ''}
                key={status}
                type="button"
                onClick={() => onStatusChange(activeJob.id, status)}
              >
                {statusLabels[status]}
              </button>
            ))}
          </div>

          {activeJob.paid && latestPayment ? (
            <div className="payment-row paid-summary" role="status" aria-label="Paid order">
              <CreditCard size={18} />
              <span>
                Paid
                <small>{formatPaymentDate(latestPayment.createdAt)}</small>
              </span>
              <strong>{formatMoney(latestPayment.amount)}</strong>
            </div>
          ) : (
            <button className="payment-row" type="button" onClick={openPaymentDialog} disabled={paymentBusy}>
              <CreditCard size={18} />
              <span>{paymentBusy ? 'Processing payment' : 'Collect payment'}</span>
              <strong>{formatMoney(balance)}</strong>
            </button>
          )}

          <button className="back-button wide" type="button" onClick={() => setInvoicePreviewOpen(true)}>
            <ClipboardList size={18} />
            View invoice
          </button>
        </>
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

      {tab === 'payments' ? (
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

      {!activeJob.paid ? (
        <button className="danger-action" type="button" onClick={() => onDelete(activeJob.id)}>
          <Trash2 size={18} />
          Delete order
        </button>
      ) : null}

      {invoicePreviewOpen ? (
        <InvoicePreview job={activeJob} orderNumber={orderNumber} onClose={() => setInvoicePreviewOpen(false)} />
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

function Metric({ title, value, detail }: { title: string; value: string; detail: string }) {
  return (
    <article className="metric">
      <span>{title}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
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

function createJobId() {
  return `J-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
}

function formatLocalDate(date = new Date()) {
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')

  return `${date.getFullYear()}-${month}-${day}`
}

function matchesJobSearch(job: Job, search: string) {
  return [job.customer, job.address, job.appliance, job.issue, job.phone].join(' ').toLowerCase().includes(search)
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
  const current = new Date()
  current.setHours(12, 0, 0, 0)
  const weekStart = new Date(current)
  const day = weekStart.getDay()
  const mondayOffset = day === 0 ? -6 : 1 - day
  weekStart.setDate(current.getDate() + mondayOffset + weekOffset * 7)

  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(weekStart)
    date.setDate(weekStart.getDate() + index)
    const disabled = date < current || date.getDay() === 0
    return {
      value: formatLocalDate(date),
      weekday: new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(date),
      day: new Intl.DateTimeFormat('en-US', { day: 'numeric' }).format(date),
      disabled,
    }
  })
}

function formatBookingLongDate(value: string) {
  const date = new Date(`${value}T12:00:00`)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(date)
}

function formatBookingWindow(value: string) {
  return value.replace(/\s+/g, '').replace(/AM/g, 'am').replace(/PM/g, 'pm')
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
  const date = job.service_date.replace(/-/g, '')
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
  link.download = `alex-appointment-${job.service_date}.ics`
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
}) {
  if (!details.firstName.trim() || !details.lastName.trim()) return 'First and last name are required.'
  if (!isValidUsPhoneNumber(details.phone)) return 'Enter a valid US phone number.'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.email.trim())) return 'Enter a valid email address.'
  if (details.address.trim().length < 6) return 'Service address is required.'
  if (!details.city.trim()) return 'City is required.'
  if (!details.state.trim()) return 'State is required.'
  if (!/^\d{5}(-\d{4})?$/.test(details.zip.trim())) return 'Enter a valid ZIP code.'
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
    service_date: job.date,
    service_window: job.window,
    status: job.status,
    invoice: job.invoice,
    paid: job.paid,
    finance_items: job.financeItems || [],
    payments: job.payments || [],
    lat: job.lat,
    lng: job.lng,
  }
}

function normalizeStoredJob(job: Job): Job {
  const invoice = normalizeMoneyInput(job.invoice)
  const financeItems = normalizeFinanceItems(job.financeItems, invoice)
  const payments = normalizePayments(job.payments)

  return {
    ...job,
    email: job.email || '',
    invoice,
    paid: job.paid || (invoice > 0 && jobPaymentsTotal(payments) >= (financeTotal(financeItems) || invoice)),
    financeItems,
    payments,
  }
}

function rowToJob(row: JobRow): Job {
  const invoice = Number(row.invoice)
  const financeItems = normalizeFinanceItems(row.finance_items, invoice)
  const payments = normalizePayments(row.payments)

  return {
    id: row.id,
    createdAt: row.created_at,
    customer: row.customer,
    phone: row.phone,
    email: row.email || '',
    address: row.address,
    appliance: row.appliance,
    issue: row.issue,
    date: row.service_date.slice(0, 10),
    window: row.service_window,
    status: row.status,
    invoice,
    paid: row.paid || (invoice > 0 && jobPaymentsTotal(payments) >= (financeTotal(financeItems) || invoice)),
    financeItems,
    payments,
    lat: row.lat,
    lng: row.lng,
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
  patch: Partial<Pick<JobRow, 'customer' | 'phone' | 'email' | 'address' | 'paid' | 'status' | 'invoice' | 'finance_items' | 'payments'>>,
  authToken?: string,
) {
  if (isApiConfigured) {
    await updateJobInApi(id, patch, authToken)
    return
  }

  if (!supabase) return
  await supabase.from('jobs').update(patch).eq('id', id)
}

export default App
