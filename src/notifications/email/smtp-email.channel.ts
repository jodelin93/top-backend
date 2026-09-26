import { randomUUID } from 'crypto';
import { hostname } from 'os';
import * as net from 'net';
import * as tls from 'tls';
import { Logger } from '@nestjs/common';
import { EmailChannel, EmailMessage } from './email-channel';
import { maskEmailsIn } from '../../documents/print-job-rules';

/**
 * SMTP settings from the environment. E-mail is disabled unless SMTP_HOST is set.
 *
 *   SMTP_HOST, SMTP_PORT (587), SMTP_SECURE (true = implicit TLS, usually port 465),
 *   SMTP_USER, SMTP_PASSWORD, SMTP_FROM (sender address),
 *   SMTP_REQUIRE_TLS (true: refuse to send unencrypted, default true in production)
 */
export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  from: string;
  requireTls: boolean;
  timeoutMs: number;
}

export function smtpConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SmtpConfig | null {
  const host = env.SMTP_HOST?.trim();
  if (!host) return null;
  const secure = env.SMTP_SECURE === 'true';
  return {
    host,
    port: Number(env.SMTP_PORT) || (secure ? 465 : 587),
    secure,
    user: env.SMTP_USER || undefined,
    password: env.SMTP_PASSWORD || undefined,
    from: env.SMTP_FROM?.trim() || `no-reply@${host}`,
    requireTls: env.SMTP_REQUIRE_TLS
      ? env.SMTP_REQUIRE_TLS === 'true'
      : env.NODE_ENV === 'production',
    timeoutMs: Number(env.SMTP_TIMEOUT_MS) || 15_000,
  };
}

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+$/;
// Header values: no line breaks (header injection)
const oneLine = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();

/** RFC 2047 encoded-word for non-ASCII header text */
export function encodeHeader(value: string): string {
  const clean = oneLine(value);
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  return `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

/** The full RFC 5322 message (base64 body, CRLF line endings) */
export function buildMessage(
  from: string,
  message: EmailMessage,
  date = new Date(),
): string {
  const encode = (text: string) =>
    Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'utf8')
      .toString('base64')
      .replace(/.{1,76}/g, '$&\r\n');
  const body = encode(message.text);
  const domain = from.split('@')[1] ?? 'localhost';
  const headers = [
    `From: ${oneLine(from)}`,
    `To: ${oneLine(message.to)}`,
    `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
  ];
  if (message.html) {
    // Text and HTML versions of the same message (e-mailed receipts)
    const boundary = `=_alt_${randomUUID().replace(/-/g, '')}`;
    return [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      'Auto-Submitted: auto-generated',
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      body,
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      encode(message.html),
      `--${boundary}--`,
      '',
    ].join('\r\n');
  }
  return [
    ...headers,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
    '',
    body,
  ].join('\r\n');
}

interface SmtpReply {
  code: number;
  lines: string[];
}

/** Line-oriented SMTP conversation over a (possibly upgraded) socket */
class SmtpConversation {
  private buffer = '';
  private waiting: {
    resolve: (reply: SmtpReply) => void;
    reject: (error: Error) => void;
  } | null = null;
  private pendingLines: string[] = [];
  // Replies that arrived before anyone asked for them
  private replies: SmtpReply[] = [];
  private failure: Error | null = null;

  constructor(
    public socket: net.Socket,
    private timeoutMs: number,
  ) {
    this.attach(socket);
  }

  attach(socket: net.Socket) {
    this.socket = socket;
    // A new (TLS) transport starts a clean conversation: nothing read over the
    // previous one may be taken as a reply on this one (STARTTLS injection)
    this.buffer = '';
    this.pendingLines = [];
    this.replies = [];
    this.failure = null;
    this.waiting = null;
    socket.setTimeout(this.timeoutMs);
    socket.on('data', (chunk: Buffer) => this.onData(chunk.toString('utf8')));
    socket.on('timeout', () => this.fail(new Error('SMTP timeout')));
    socket.on('error', (error: Error) => this.fail(error));
    socket.on('close', () => this.fail(new Error('SMTP connection closed')));
  }

  /**
   * Called right after the 220 reply to STARTTLS: the server must not have sent
   * anything else, otherwise a man-in-the-middle could have injected plaintext
   * replies to be read after the upgrade (CVE-2011-0411 class).
   */
  assertNoBufferedInput() {
    if (this.buffer || this.pendingLines.length || this.replies.length) {
      throw new Error('SMTP server sent unexpected data after STARTTLS');
    }
  }

  detach() {
    this.socket.removeAllListeners('data');
    this.socket.removeAllListeners('timeout');
    this.socket.removeAllListeners('error');
    this.socket.removeAllListeners('close');
  }

  private fail(error: Error) {
    this.failure ??= error;
    if (this.waiting) {
      this.waiting.reject(error);
      this.waiting = null;
    }
  }

  private onData(text: string) {
    this.buffer += text;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      this.pendingLines.push(line);
      // "250-..." continues, "250 ..." ends a reply
      if (/^\d{3}(?: |$)/.test(line)) {
        const reply = {
          code: Number(line.slice(0, 3)),
          lines: this.pendingLines.map((l) => l.slice(4)),
        };
        this.pendingLines = [];
        if (this.waiting) {
          this.waiting.resolve(reply);
          this.waiting = null;
        } else {
          this.replies.push(reply);
        }
      }
    }
  }

  read(): Promise<SmtpReply> {
    const queued = this.replies.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }

  async command(line: string | null, expect: number[]): Promise<SmtpReply> {
    const reply = this.read();
    if (line !== null) this.socket.write(`${line}\r\n`);
    const result = await reply;
    if (!expect.includes(result.code)) {
      throw new Error(
        // The server's reply may quote the recipient: masked, as it ends up in logs
        `SMTP ${line?.split(' ')[0] ?? 'greeting'} failed: ${result.code} ${maskEmailsIn(result.lines.join(' '))}`,
      );
    }
    return result;
  }
}

/**
 * Minimal SMTP client (EHLO, STARTTLS, AUTH PLAIN/LOGIN, one recipient per
 * message) so the app needs no mail library. One connection per message:
 * notification e-mail is low volume.
 */
export class SmtpEmailChannel implements EmailChannel {
  readonly enabled = true;
  private readonly logger = new Logger(SmtpEmailChannel.name);

  constructor(private config: SmtpConfig) {}

  async send(message: EmailMessage): Promise<void> {
    if (!EMAIL.test(message.to) || !EMAIL.test(this.config.from)) {
      throw new Error('Invalid e-mail address');
    }
    const socket = await this.connect();
    const smtp = new SmtpConversation(socket, this.config.timeoutMs);
    try {
      await smtp.command(null, [220]);
      const helo = hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';
      let ehlo = await smtp.command(`EHLO ${helo}`, [250]);

      const encrypted = () => smtp.socket instanceof tls.TLSSocket;
      if (!encrypted() && ehlo.lines.some((l) => /^STARTTLS\b/i.test(l))) {
        await smtp.command('STARTTLS', [220]);
        smtp.assertNoBufferedInput();
        smtp.detach();
        smtp.attach(await this.upgrade(smtp.socket));
        ehlo = await smtp.command(`EHLO ${helo}`, [250]);
      }
      if (!encrypted() && this.config.requireTls) {
        throw new Error(
          'The SMTP server does not offer TLS (SMTP_REQUIRE_TLS)',
        );
      }

      if (this.config.user) {
        const auth = ehlo.lines.find((l) => /^AUTH\b/i.test(l)) ?? '';
        if (/\bPLAIN\b/i.test(auth) || !/\bLOGIN\b/i.test(auth)) {
          const token = Buffer.from(
            `\0${this.config.user}\0${this.config.password ?? ''}`,
          ).toString('base64');
          await smtp.command(`AUTH PLAIN ${token}`, [235]);
        } else {
          await smtp.command('AUTH LOGIN', [334]);
          await smtp.command(
            Buffer.from(this.config.user).toString('base64'),
            [334],
          );
          await smtp.command(
            Buffer.from(this.config.password ?? '').toString('base64'),
            [235],
          );
        }
      }

      await smtp.command(`MAIL FROM:<${this.config.from}>`, [250]);
      await smtp.command(`RCPT TO:<${message.to}>`, [250, 251]);
      await smtp.command('DATA', [354]);
      // Dot-stuffing: a line starting with "." gets another one
      const data = buildMessage(this.config.from, message).replace(
        /^\./gm,
        '..',
      );
      await smtp.command(`${data}\r\n.`, [250]);
      await smtp.command('QUIT', [221]).catch(() => undefined);
    } finally {
      smtp.detach();
      smtp.socket.destroy();
    }
    this.logger.debug(`E-mail sent (${message.subject.slice(0, 60)})`);
  }

  private connect(): Promise<net.Socket> {
    const { host, port, secure, timeoutMs } = this.config;
    return new Promise((resolve, reject) => {
      const socket = secure
        ? tls.connect({ host, port, servername: host })
        : net.connect({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('SMTP connection timeout'));
      }, timeoutMs);
      socket.once(secure ? 'secureConnect' : 'connect', () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  private upgrade(socket: net.Socket): Promise<tls.TLSSocket> {
    return new Promise((resolve, reject) => {
      const secured = tls.connect({ socket, servername: this.config.host });
      secured.once('secureConnect', () => resolve(secured));
      secured.once('error', reject);
    });
  }
}
