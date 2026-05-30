import { Autocomplete, useJsApiLoader } from '@react-google-maps/api'
import { Capacitor } from '@capacitor/core'
import {
  ArrowLeft,
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  CreditCard,
  MapPin,
  Navigation,
  Phone,
  Plus,
  Search,
  Settings,
  Smartphone,
  Trash2,
  UserPlus,
  UserRound,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, FormEvent, SetStateAction } from 'react'
import './App.css'
import {
  addApprovedUser,
  fetchCurrentUser,
  fetchApprovedUsers,
  fetchJobsFromApi,
  isApiConfigured,
  loginWithGoogle,
  loginWithPassword,
  registerWithPassword,
  deleteJobFromApi,
  saveJobToApi,
  updateJobInApi,
  verifySmsCode,
} from './api'
import type { ApprovedUser, AuthLoginResponse, AuthSession, TwoFactorChallenge } from './api'
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
  address: string
  appliance: string
  issue: string
  date: string
  window: string
  status: JobStatus
  invoice: number
  paid: boolean
  lat: number
  lng: number
}

type FormState = Omit<Job, 'id' | 'status' | 'invoice' | 'paid' | 'lat' | 'lng'>

const googleLibraries: 'places'[] = ['places']
const googleMapsKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined
const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined

const statusLabels: Record<JobStatus, string> = {
  new: 'New lead',
  scheduled: 'Scheduled',
  in_progress: 'On site',
  complete: 'Complete',
}

const starterJobs: Job[] = [
  {
    id: 'J-1042',
    customer: 'Maria Johnson',
    phone: '317-555-0148',
    address: '350 Massachusetts Ave, Indianapolis, IN',
    appliance: 'Samsung refrigerator',
    issue: 'Not cooling, freezer works sometimes',
    date: '2026-05-23',
    window: '10:00 AM - 12:00 PM',
    status: 'scheduled',
    invoice: 189,
    paid: false,
    lat: 39.7716,
    lng: -86.1539,
  },
  {
    id: 'J-1043',
    customer: 'David Smith',
    phone: '317-555-0199',
    address: '110 W Washington St, Indianapolis, IN',
    appliance: 'LG washer',
    issue: 'Drain pump noise and leak',
    date: '2026-05-23',
    window: '1:00 PM - 3:00 PM',
    status: 'in_progress',
    invoice: 245,
    paid: false,
    lat: 39.7672,
    lng: -86.1606,
  },
  {
    id: 'J-1044',
    customer: 'Angela Brown',
    phone: '317-555-0120',
    address: '401 E Michigan St, Indianapolis, IN',
    appliance: 'Whirlpool dryer',
    issue: 'No heat, drum turns',
    date: '2026-05-24',
    window: '9:00 AM - 11:00 AM',
    status: 'new',
    invoice: 0,
    paid: false,
    lat: 39.7739,
    lng: -86.1499,
  },
]

const emptyForm: FormState = {
  customer: '',
  phone: '',
  address: '',
  appliance: '',
  issue: '',
  date: new Date().toISOString().slice(0, 10),
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
  const [jobs, setJobs] = useStoredJobs(authToken)
  const [activeId, setActiveId] = useState(jobs[0]?.id ?? '')
  const [page, setPage] = useState<Page>('dashboard')
  const [query, setQuery] = useState('')
  const [form, setForm] = useState<FormState>(emptyForm)
  const [toast, setToast] = useState<Toast | null>(null)
  const [selectedCoords, setSelectedCoords] = useState({ lat: 39.7684, lng: -86.1581 })
  const autocompleteRef = useRef<google.maps.places.Autocomplete | null>(null)
  const knownJobIdsRef = useRef(new Set(jobs.map((job) => job.id)))
  const toastTimerRef = useRef<number | null>(null)

  const { isLoaded } = useJsApiLoader({
    googleMapsApiKey: googleMapsKey || 'missing-key',
    libraries: googleLibraries,
    preventGoogleFontsLoading: true,
  })

  const filteredJobs = useMemo(() => {
    const search = query.trim().toLowerCase()
    if (!search) return jobs

    return jobs.filter((job) =>
      [job.customer, job.address, job.appliance, job.issue, job.phone]
        .join(' ')
        .toLowerCase()
        .includes(search),
    )
  }, [jobs, query])

  const activeJob = jobs.find((job) => job.id === activeId) ?? jobs[0]
  const orderNumbers = useMemo(() => createOrderNumbers(jobs), [jobs])
  const activeOrderNumber = activeJob ? orderNumbers.get(activeJob.id) || formatOrderNumber(1) : ''
  const todayJobs = jobs.filter((job) => job.date === emptyForm.date).length
  const unpaidTotal = jobs.reduce((sum, job) => sum + (!job.paid ? job.invoice : 0), 0)
  const completedCount = jobs.filter((job) => job.status === 'complete').length

  const signOut = useCallback(() => {
    setAuth(null)
    setJobs([])
    setActiveId('')
    setPage('dashboard')
  }, [setAuth, setJobs])

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

      setJobs(data.map(rowToJob))
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
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current)
      }
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

    const syncFromPush = () => {
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
  }, [authToken, syncJobs])

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

  const togglePaid = (id: string) => {
    const job = jobs.find((currentJob) => currentJob.id === id)
    const paid = !job?.paid
    setJobs((current) => current.map((currentJob) => (currentJob.id === id ? { ...currentJob, paid } : currentJob)))
    void syncJobPatch(id, { paid }, authToken).catch((error) => {
      showToast({
        type: 'error',
        message: 'Unable to update payment',
        detail: errorMessage(error),
      })
    })
  }

  const updateClientField = (id: string, field: 'customer' | 'phone' | 'address', value: string) => {
    setJobs((current) => current.map((job) => (job.id === id ? { ...job, [field]: value } : job)))
  }

  const saveClient = (id: string) => {
    const job = jobs.find((currentJob) => currentJob.id === id)
    if (!job) return

    void syncJobPatch(id, {
      customer: job.customer,
      phone: job.phone,
      address: job.address,
    }, authToken)
      .then(() => {
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

    void deleteJob(id, authToken)
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
      lat: selectedCoords.lat,
      lng: selectedCoords.lng,
    }

    const orderNumber = formatOrderNumber(jobs.length + 1)
    setJobs((current) => [nextJob, ...current])
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

        <div className="mobile-ready">
          <Smartphone size={20} />
          <div>
            <strong>Alex Field</strong>
            <span>Online crew workspace</span>
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
              <p className="eyebrow">Today, May 23</p>
              <h2>Client work center</h2>
            </div>
          )}
          {showNewJobButton ? (
            <button className="primary-action" type="button" onClick={openNewJob}>
              <Plus size={18} />
              New job
            </button>
          ) : null}
          {auth ? (
            <button className="back-button" type="button" onClick={signOut}>
              Log out
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
                  <span>{filteredJobs.length} records</span>
                </div>
                <div className="job-list">
                  {filteredJobs.map((job) => (
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
                onDelete={deleteOrder}
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

  const submitAuth = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form.email || !form.password || (mode === 'register' && (!form.name || (isNativeApp && !form.phone)))) return

    setBusy(true)
    const request =
      mode === 'register'
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

  return (
    <section className="auth-page">
      <div className="auth-panel">
        <div className="brand-row">
          <div className="app-icon" aria-label="Alex app icon">
            <img src="/favicon.png" alt="" />
          </div>
          <div>
            <p className="eyebrow">Alex Appliance Repair</p>
            <h1>Sign in</h1>
          </div>
        </div>

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
              Phone for SMS
              <input
                autoComplete="tel"
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

          <button className="primary-action wide" disabled={busy} type="submit">
            {mode === 'register' ? 'Create account' : 'Sign in'}
          </button>
        </form>

        {isNativeApp ? (
          <p className="owner-google-note">SMS code is requested after password when the device is not trusted.</p>
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

    return () => {
      ignore = true
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
              {approvedUsers.map((user) => (
                <article className="owner-user-row" key={user.email}>
                  <div>
                    <strong>{user.email}</strong>
                    <span>{user.role}</span>
                  </div>
                </article>
              ))}
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
  onDelete,
}: {
  activeJob: Job
  orderNumber: string
  onStatusChange: (id: string, status: JobStatus) => void
  onTogglePaid: (id: string) => void
  onDelete: (id: string) => void
}) {
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

      <button className="payment-row" type="button" onClick={() => onTogglePaid(activeJob.id)}>
        <CreditCard size={18} />
        <span>{activeJob.paid ? 'Paid' : 'Collect payment'}</span>
        <strong>${activeJob.invoice || 0}</strong>
      </button>

      <button className="danger-action" type="button" onClick={() => onDelete(activeJob.id)}>
        <Trash2 size={18} />
        Delete order
      </button>
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

function useStoredJobs(authToken?: string): [Job[], Dispatch<SetStateAction<Job[]>>] {
  const [jobs, setJobs] = useState<Job[]>(() => {
    const saved = localStorage.getItem('alex-appliance-jobs')
    return saved ? (JSON.parse(saved) as Job[]) : starterJobs
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

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string') return error
  return 'Please check the connection and try again.'
}

function isTwoFactorChallenge(response: AuthLoginResponse): response is TwoFactorChallenge {
  return 'requiresTwoFactor' in response && response.requiresTwoFactor
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
    address: job.address,
    appliance: job.appliance,
    issue: job.issue,
    service_date: job.date,
    service_window: job.window,
    status: job.status,
    invoice: job.invoice,
    paid: job.paid,
    lat: job.lat,
    lng: job.lng,
  }
}

function rowToJob(row: JobRow): Job {
  return {
    id: row.id,
    createdAt: row.created_at,
    customer: row.customer,
    phone: row.phone,
    address: row.address,
    appliance: row.appliance,
    issue: row.issue,
    date: row.service_date.slice(0, 10),
    window: row.service_window,
    status: row.status,
    invoice: Number(row.invoice),
    paid: row.paid,
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

async function deleteJob(id: string, authToken?: string) {
  if (isApiConfigured) {
    await deleteJobFromApi(id, authToken)
    return
  }

  if (!supabase) return
  await supabase.from('jobs').delete().eq('id', id)
}

function ClientsPage({
  jobs,
  onOpenClient,
}: {
  jobs: Job[]
  onOpenClient: (id: string) => void
}) {
  return (
    <section className="clients-page">
      <div className="panel-heading">
        <h3>Clients</h3>
        <span>{jobs.length} records</span>
      </div>

      <div className="client-list">
        {jobs.map((job) => (
          <button className="client-card" key={job.id} type="button" onClick={() => onOpenClient(job.id)}>
            <strong>{job.customer}</strong>
            <span>{job.phone}</span>
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
  onFieldChange: (id: string, field: 'customer' | 'phone' | 'address', value: string) => void
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
  patch: Partial<Pick<JobRow, 'customer' | 'phone' | 'address' | 'paid' | 'status'>>,
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
