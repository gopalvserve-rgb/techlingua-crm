import { ServiceUnavailableException } from '@nestjs/common';

/**
 * DEF-S2-05 — an EXPECTED "waiting on the client's credentials" state, not a bug.
 *
 * Still a 503 to the caller (the UI surfaces the reason verbatim), but the Error
 * Log must not gain a red `level=error` row every time the admin clicks "Pull now"
 * on a Google Sheet channel whose credentials have not arrived yet — or asks for an
 * OTP before the SMS gateway exists. The global exception filter checks the
 * `notConfigured` marker and skips the capture.
 */
export class NotConfiguredException extends ServiceUnavailableException {
  /** duck-typed so the filter never needs to import this class */
  readonly notConfigured = true;

  constructor(message: string) {
    super(message);
  }
}

/** True for any exception that is a documented "not configured yet" state. */
export const isNotConfigured = (e: unknown): boolean => (e as { notConfigured?: boolean })?.notConfigured === true;
