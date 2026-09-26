/**
 * Outgoing e-mail (notifications). The app talks to this interface; the SMTP
 * adapter is used when SMTP_HOST is set, otherwise e-mail is disabled.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  // Optional HTML version (sent as multipart/alternative with `text`), e.g. receipts
  html?: string;
}

export interface EmailChannel {
  readonly enabled: boolean;
  send(message: EmailMessage): Promise<void>;
}

export const EMAIL_CHANNEL = Symbol('EMAIL_CHANNEL');

/** Used when no SMTP server is configured */
export class DisabledEmailChannel implements EmailChannel {
  readonly enabled = false;
  send(): Promise<void> {
    return Promise.resolve();
  }
}
