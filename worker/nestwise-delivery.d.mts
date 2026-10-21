export type NestwiseEnvironment = {
  NESTWISE_DISPATCH_ENABLED?: string;
  NESTWISE_ENVIRONMENT?: string;
  NESTWISE_ENDPOINT?: string;
  NESTWISE_CONNECTION?: string;
  NESTWISE_KEY_ID?: string;
  NESTWISE_SIGNING_SECRET?: string;
  NESTWISE_DISPATCH_NOT_BEFORE?: string;
  NESTWISE_DISPATCH_EXPIRES_AT?: string;
  NESTWISE_RECEIVER?: {fetch(input: string, init?: RequestInit): Promise<Response>};
};
export function safelyDispatchNestwise(sql: { query: (text: string, params: unknown[]) => Promise<unknown> }, env: NestwiseEnvironment): Promise<void>;
