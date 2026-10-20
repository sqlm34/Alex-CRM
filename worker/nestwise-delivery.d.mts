export type NestwiseEnvironment = {
  NESTWISE_DISPATCH_ENABLED?: string;
  NESTWISE_ENVIRONMENT?: string;
  NESTWISE_ENDPOINT?: string;
  NESTWISE_CONNECTION?: string;
  NESTWISE_KEY_ID?: string;
  NESTWISE_SIGNING_SECRET?: string;
};
export function safelyDispatchNestwise(sql: { query: (text: string, params: unknown[]) => Promise<unknown> }, env: NestwiseEnvironment): Promise<void>;
