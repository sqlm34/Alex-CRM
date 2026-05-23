import { Autocomplete, useJsApiLoader } from '@react-google-maps/api'
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
  UserPlus,
  UserRound,
  Wrench,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, FormEvent, SetStateAction } from 'react'
import './App.css'
import { fetchJobsFromApi, isApiConfigured, saveJobToApi, updateJobInApi } from './api'
import { notifyNewOrder, prepareOrderNotifications, unlockWebChime } from './notifications'
import { isSupabaseConfigured, supabase } from './supabase'
import type { JobRow } from './supabase'

type JobStatus = 'new' | 'scheduled' | 'in_progress' | 'complete'

type Job = {
  id: string
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

function App() {
  const [jobs, setJobs] = useStoredJobs()
  const [activeId, setActiveId] = useState(jobs[0]?.id ?? '')
  const [page, setPage] = useState<'dashboard' | 'job' | 'new'>('dashboard')
  const [query, setQuery] = useState('')
  const [form, setForm] = useState<FormState>(emptyForm)
  const [selectedCoords, setSelectedCoords] = useState({ lat: 39.7684, lng: -86.1581 })
  const autocompleteRef = useRef<google.maps.places.Autocomplete | null>(null)
  const knownJobIdsRef = useRef(new Set(jobs.map((job) => job.id)))

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
  const todayJobs = jobs.filter((job) => job.date === emptyForm.date).length
  const unpaidTotal = jobs.reduce((sum, job) => sum + (!job.paid ? job.invoice : 0), 0)
  const completedCount = jobs.filter((job) => job.status === 'complete').length

  useEffect(() => {
    if (!jobs.some((job) => job.id === activeId)) {
      setActiveId(jobs[0]?.id ?? '')
    }
  }, [activeId, jobs])

  useEffect(() => {
    knownJobIdsRef.current = new Set(jobs.map((job) => job.id))
  }, [jobs])

  useEffect(() => {
    void prepareOrderNotifications().catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!isApiConfigured) return

    let stopped = false

    async function checkForNewJobs() {
      const data = await fetchJobsFromApi()
      if (stopped || !data?.length) return

      const knownIds = knownJobIdsRef.current
      const newRows = data.filter((row) => !knownIds.has(row.id))

      setJobs(data.map(rowToJob))
      knownJobIdsRef.current = new Set(data.map((row) => row.id))

      for (const row of newRows.reverse()) {
        await notifyNewOrder(row).catch(() => undefined)
      }
    }

    const timer = window.setInterval(() => {
      void checkForNewJobs().catch(() => undefined)
    }, 20000)

    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [setJobs])

  const updateStatus = (id: string, status: JobStatus) => {
    setJobs((current) => current.map((job) => (job.id === id ? { ...job, status } : job)))
    void syncJobPatch(id, { status })
  }

  const togglePaid = (id: string) => {
    const job = jobs.find((currentJob) => currentJob.id === id)
    const paid = !job?.paid
    setJobs((current) => current.map((currentJob) => (currentJob.id === id ? { ...currentJob, paid } : currentJob)))
    void syncJobPatch(id, { paid })
  }

  const addJob = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!form.customer || !form.phone || !form.address || !form.appliance) return

    const nextJob: Job = {
      ...form,
      id: `J-${1042 + jobs.length + 1}`,
      status: 'new',
      invoice: 0,
      paid: false,
      lat: selectedCoords.lat,
      lng: selectedCoords.lng,
    }

    setJobs((current) => [nextJob, ...current])
    void saveJobToSupabase(nextJob)
    void notifyNewOrder(jobToRow(nextJob)).catch(() => undefined)
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

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <div className="app-icon" aria-label="Alex app icon">
            <Wrench size={24} />
          </div>
          <div>
            <p className="eyebrow">Appliance repair CRM</p>
            <h1>Alex</h1>
          </div>
        </div>

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
          <button type="button">
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
          <button className="primary-action" type="button" onClick={openNewJob}>
            <Plus size={18} />
            New job
          </button>
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
                        <strong>{job.customer}</strong>
                        <small>{job.appliance}</small>
                      </span>
                      <em>{statusLabels[job.status]}</em>
                    </button>
                  ))}
                </div>
              </div>

              <button className="client-launch" type="button" onClick={openNewJob}>
                <span className="client-launch-icon">
                  <UserPlus size={34} />
                </span>
                <strong>New customer</strong>
                <small>Add client, address, appliance, and first job</small>
              </button>
            </section>
          </>
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
        ) : (
          <section className="job-page">
            {activeJob ? (
              <JobDetails
                activeJob={activeJob}
                onStatusChange={updateStatus}
                onTogglePaid={togglePaid}
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

function JobDetails({
  activeJob,
  onStatusChange,
  onTogglePaid,
}: {
  activeJob: Job
  onStatusChange: (id: string, status: JobStatus) => void
  onTogglePaid: (id: string) => void
}) {
  return (
    <div className="details-panel details-page-panel">
      <div className="details-header">
        <div>
          <p className="eyebrow">{activeJob.id}</p>
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

function useStoredJobs(): [Job[], Dispatch<SetStateAction<Job[]>>] {
  const [jobs, setJobs] = useState<Job[]>(() => {
    const saved = localStorage.getItem('alex-appliance-jobs')
    return saved ? (JSON.parse(saved) as Job[]) : starterJobs
  })

  useEffect(() => {
    let ignore = false

    async function loadJobs() {
      if (isApiConfigured) {
        const data = await fetchJobsFromApi()
        if (!ignore && data?.length) setJobs(data.map(rowToJob))
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
  }, [])

  useEffect(() => {
    localStorage.setItem('alex-appliance-jobs', JSON.stringify(jobs))
  }, [jobs])

  return [jobs, setJobs]
}

function mapsDirectionsUrl(address: string) {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}&travelmode=driving`
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
    customer: row.customer,
    phone: row.phone,
    address: row.address,
    appliance: row.appliance,
    issue: row.issue,
    date: row.service_date,
    window: row.service_window,
    status: row.status,
    invoice: Number(row.invoice),
    paid: row.paid,
    lat: row.lat,
    lng: row.lng,
  }
}

async function saveJobToSupabase(job: Job) {
  if (isApiConfigured) {
    await saveJobToApi(jobToRow(job))
    return
  }

  if (!supabase) return
  await supabase.from('jobs').upsert(jobToRow(job))
}

async function syncJobPatch(id: string, patch: Partial<Pick<JobRow, 'paid' | 'status'>>) {
  if (isApiConfigured) {
    await updateJobInApi(id, patch)
    return
  }

  if (!supabase) return
  await supabase.from('jobs').update(patch).eq('id', id)
}

export default App
