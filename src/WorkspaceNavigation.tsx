import { CalendarDays, ClipboardList, Menu, Plus, Search, UsersRound } from 'lucide-react'

type NavigationProps = {
  page: string
  query: string
  name: string
  onQuery: (value: string) => void
  onNavigate: (page: 'schedule' | 'dashboard' | 'clients' | 'owner') => void
  onCreate: () => void
  onMenu: () => void
}

export function WorkspaceToolbar({ query, name, onQuery, onNavigate, onCreate }: NavigationProps) {
  return <div className="crm-toolbar">
    <form className="crm-global-search" role="search" onSubmit={event => { event.preventDefault(); onNavigate('dashboard') }}>
      <Search size={19} aria-hidden="true" />
      <input aria-label="Search jobs by customer, phone or address" placeholder="Search customer, phone, address" value={query} onChange={event => onQuery(event.target.value)} />
    </form>
    <div className="crm-toolbar-actions">
      <button className="primary-action" type="button" onClick={onCreate}><Plus size={18} />New job</button>
      <button className="crm-profile" type="button" title="Account settings" aria-label={`Account settings for ${name}`} onClick={() => onNavigate('owner')}>
        <span aria-hidden="true">{name.split(/\s+/).map(part => part[0]).slice(0, 2).join('')}</span><strong>{name}</strong>
      </button>
    </div>
  </div>
}

export function WorkspaceBottomNav({ page, onNavigate, onCreate, onMenu }: NavigationProps) {
  return <nav className="crm-bottom-nav" aria-label="Quick navigation">
    <button type="button" aria-current={page === 'schedule' ? 'page' : undefined} onClick={() => onNavigate('schedule')}><CalendarDays size={21} /><span>Schedule</span></button>
    <button type="button" aria-current={page === 'dashboard' || page === 'job' ? 'page' : undefined} onClick={() => onNavigate('dashboard')}><ClipboardList size={21} /><span>Jobs</span></button>
    <button className="crm-create-job" type="button" aria-label="New job" title="New job" onClick={onCreate}><Plus size={25} /></button>
    <button type="button" aria-current={page === 'clients' || page === 'clientEdit' ? 'page' : undefined} onClick={() => onNavigate('clients')}><UsersRound size={21} /><span>Clients</span></button>
    <button type="button" onClick={onMenu}><Menu size={21} /><span>More</span></button>
  </nav>
}
