import type { D1Database, Fetcher } from "@cloudflare/workers-types";
export type Env = {
  DB: D1Database;
  ASSETS: Fetcher;
  AUTH_ENCRYPTION_KEY: string;
};
export type Row = Record<string, any>;
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code?: string,
  ) {
    super(message);
  }
}
