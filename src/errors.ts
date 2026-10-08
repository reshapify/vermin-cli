import { VerminError } from "@vermin/sdk";

/**
 * Exit codes. Scripts and agents can branch on these without parsing output.
 * The API's `error.code` is also printed (and included with `--json`).
 */
export const EXIT = {
  ok: 0,
  /** Unexpected or internal error. */
  error: 1,
  /** Bad command line: unknown command or flag, missing argument. */
  usage: 2,
  /** No key, invalid or revoked key, or the key lacks the permission. */
  auth: 3,
  /** Out of credits, spend cap reached, or the key's budget is used up. */
  credits: 4,
  /** Rate limited or Vermin's capacity is busy: retry later. */
  retry: 5,
  /** The target page couldn't be read: blocked, unreachable, timed out, unsupported. */
  target: 6,
  /** Unknown crawl id or resource. */
  notFound: 7,
  /** Interrupted (Ctrl-C). */
  interrupted: 130,
} as const;

const BY_CODE: Record<string, number> = {
  missing_api_key: EXIT.auth,
  unauthorized: EXIT.auth,
  forbidden: EXIT.auth,
  insufficient_credits: EXIT.credits,
  spend_cap_reached: EXIT.credits,
  rate_limited: EXIT.retry,
  capacity_exceeded: EXIT.retry,
  connection_error: EXIT.retry,
  blocked_url: EXIT.target,
  blocked_by_site: EXIT.target,
  fetch_failed: EXIT.target,
  timeout: EXIT.target,
  unsupported_content: EXIT.target,
  not_found: EXIT.notFound,
  invalid_request: EXIT.usage,
};

export function exitCodeFor(err: unknown): number {
  if (err instanceof UsageError) return EXIT.usage;
  if (err instanceof VerminError) return BY_CODE[err.code] ?? EXIT.error;
  if (err instanceof Error && err.name === "AbortError") return EXIT.interrupted;
  return EXIT.error;
}

/** A problem with how the command was invoked. */
export class UsageError extends Error {
  override name = "UsageError";
}

/** One short, actionable next step per error code. */
export function hintFor(err: unknown): string | undefined {
  if (!(err instanceof VerminError)) return undefined;
  switch (err.code) {
    case "missing_api_key":
      return "Run `vermin login`, or set VERMIN_API_KEY. Create a key at https://vermin.dev/dashboard/api-keys";
    case "unauthorized":
      return "The key is invalid, revoked or expired. Create one at https://vermin.dev/dashboard/api-keys and run `vermin login`.";
    case "forbidden":
      return "This key is restricted to other permissions. An admin can change it at https://vermin.dev/dashboard/api-keys";
    case "insufficient_credits":
      return /budget/i.test(err.message)
        ? "This key's credit budget is used up for now. An admin can raise it at https://vermin.dev/dashboard/api-keys"
        : "Top up or upgrade at https://vermin.dev/dashboard/billing";
    case "spend_cap_reached":
      return "Raise the spend cap at https://vermin.dev/dashboard/billing";
    case "rate_limited":
    case "capacity_exceeded":
      return err.retryAfterMs ? `Retry in ${Math.ceil(err.retryAfterMs / 1000)}s.` : "Retry shortly.";
    case "blocked_by_site":
      return "The site blocked the request. Try `--tier render`. It cost 0 credits.";
    default:
      return undefined;
  }
}
