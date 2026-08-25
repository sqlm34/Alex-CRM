import { createClient } from '@supabase/supabase-js'

export type JobRow = {
  id: string
  customer: string
  phone: string
  address: string
  appliance: string
  issue: string
  service_date: string
  service_window: string
  status: 'new' | 'scheduled' | 'in_progress' | 'complete'
  invoice: number
  paid: boolean
  finance_items?: FinanceItemRow[] | null
  payments?: PaymentRow[] | null
  lat: number
  lng: number
  created_at?: string
  created_by_user_id?: string | null
}

export type FinanceItemRow = {
  id: string
  label: string
  amount: number
}

export type PaymentRow = {
  id: string
  amount: number
  createdAt: string
  method?: string
  paymentIntentId?: string
  status?: string
}

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl as string, supabaseAnonKey as string)
  : null
