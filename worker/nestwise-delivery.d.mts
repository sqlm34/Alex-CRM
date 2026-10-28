export type NestwiseEnvironment = {
  NESTWISE_CONFIG?: string;
  NESTWISE_DISPATCH_ENABLED?: string;
  NESTWISE_ENVIRONMENT?: string;
  NESTWISE_PRODUCTION_APPROVED?: string;
  NESTWISE_ENDPOINT?: string;
  NESTWISE_CONNECTION?: string;
  NESTWISE_KEY_ID?: string;
  NESTWISE_SIGNING_SECRET?: string;
  NESTWISE_DISPATCH_NOT_BEFORE?: string;
  NESTWISE_DISPATCH_EXPIRES_AT?: string;
  NESTWISE_RECEIVER?: {fetch(input: string, init?: RequestInit): Promise<Response>};
};
export function nestwiseEnvironment<T extends NestwiseEnvironment>(env: T): T;
export function dispatchAllowed(env: NestwiseEnvironment, now?: number): boolean;
export function productionDispatchConfigured(env: NestwiseEnvironment): boolean;
export function safelyDispatchNestwise(sql: { query: (text: string, params: unknown[]) => Promise<unknown> }, env: NestwiseEnvironment): Promise<void>;
