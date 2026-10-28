import { z } from 'zod'

export const empty = z.object({}).strict()
export const areaInput = z.object({ zip: z.string().regex(/^\d{5}$/), address: z.string().trim().max(300).default('') }).strict()
export const serviceInput = z.object({
  appliance: z.string().trim().min(1).max(60).describe('Use an exact appliance label returned by getServices, for example Washer repair. Never infer microwave installation type.'), issue: z.string().trim().min(1).max(1200),
  diagnosis: z.enum(['unknown', 'suspected_sealed_system', 'confirmed_sealed_system']),
  requestedService: z.enum(['diagnostic', 'repair', 'refrigerant', 'compressor', 'sealed_system']),
}).strict()
export const slotsInput = areaInput.extend({ address: z.string().trim().min(10).max(300), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), service: serviceInput }).strict()
export const bookingInput = slotsInput.extend({
  customer: z.string().trim().min(2).max(120), phone: z.string().regex(/^\+1\d{10}$/),
  email: z.email().max(254), window: z.string().min(1).max(40),
  idempotencyKey: z.string().uuid(), confirmed: z.literal(true),
}).strict()
export const statusInput = z.object({ bookingId: z.string().min(1).max(100) }).strict()
export const cancelInput = statusInput.extend({ confirmed: z.literal(true), idempotencyKey: z.string().uuid() }).strict()
export const createToolInput = bookingInput.extend({ confirmationToken: z.string().uuid().optional() }).strict()
export const cancelToolInput = cancelInput.extend({ confirmationToken: z.string().uuid().optional() }).strict()
export const approvalInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('createBooking'), details: bookingInput, device_id: z.string().min(12).max(160), started_at: z.number(), turnstile_token: z.string().min(1).max(4096), website: z.literal('') }).strict(),
  z.object({ action: z.literal('cancelBooking'), details: cancelInput, device_id: z.string().min(12).max(160), started_at: z.number(), turnstile_token: z.string().min(1).max(4096), website: z.literal('') }).strict(),
])
export type BookingInput = z.infer<typeof bookingInput>
export type ApprovalInput = z.infer<typeof approvalInput>
