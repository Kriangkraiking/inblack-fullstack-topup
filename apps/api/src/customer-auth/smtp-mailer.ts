import { Socket } from 'node:net';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

const TIMEOUT_MS = 5000;
/** Addresses reach here validated by Zod. This is a second line against header injection. */
const SAFE_ADDRESS = /^[^\s<>"\r\n,;]+@[^\s<>"\r\n,;]+$/;

/**
 * Plain SMTP without TLS or auth, which is what mailpit speaks (SPEC 3). Small enough to keep
 * instead of a dependency: one message per connection, base64 body so Thai text and lines that
 * start with a dot need no escaping.
 */
export class SmtpMailer implements Mailer {
  constructor(
    private readonly host = process.env.SMTP_HOST ?? 'mailpit',
    private readonly port = Number(process.env.SMTP_PORT ?? 1025),
    private readonly from = process.env.MAIL_FROM ?? 'no-reply@inblackm.test',
  ) {}

  async send({ to, subject, text }: MailMessage): Promise<void> {
    if (!SAFE_ADDRESS.test(to) || !SAFE_ADDRESS.test(this.from)) throw new Error('unsafe address');
    if (/[\r\n]/.test(subject)) throw new Error('unsafe subject');
    const session = await SmtpSession.open(this.host, this.port);
    try {
      await session.expect(220);
      await session.command('EHLO inblack-api', 250);
      await session.command(`MAIL FROM:<${this.from}>`, 250);
      await session.command(`RCPT TO:<${to}>`, 250);
      await session.command('DATA', 354);
      const body = Buffer.from(text, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
      const message = [
        `From: InBlack Top-Up <${this.from}>`,
        `To: <${to}>`,
        `Subject: ${subject}`,
        `Date: ${new Date().toUTCString()}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: base64',
        '',
        body,
        '.',
      ].join('\r\n');
      await session.command(message, 250);
      await session.command('QUIT', 221);
    } finally {
      session.close();
    }
  }
}

/** Reads replies line by line; a reply ends at the line whose code is followed by a space. */
class SmtpSession {
  private buffer = '';
  private waiting: { resolve: (code: number) => void; reject: (error: Error) => void } | null = null;
  private failure: Error | null = null;

  private constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8');
    socket.setTimeout(TIMEOUT_MS, () => this.fail(new Error('smtp timeout')));
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      this.flush();
    });
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => this.fail(new Error('smtp connection closed')));
  }

  static open(host: string, port: number): Promise<SmtpSession> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      socket.once('error', reject);
      socket.connect(port, host, () => {
        socket.off('error', reject);
        resolve(new SmtpSession(socket));
      });
    });
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.waiting?.reject(error);
    this.waiting = null;
  }

  private flush(): void {
    const waiter = this.waiting;
    if (!waiter) return;
    for (;;) {
      const end = this.buffer.indexOf('\r\n');
      if (end === -1) return;
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        this.waiting = null;
        waiter.resolve(Number(line.slice(0, 3)));
        return;
      }
    }
  }

  async expect(code: number): Promise<void> {
    if (this.failure) throw this.failure;
    const got = await new Promise<number>((resolve, reject) => {
      this.waiting = { resolve, reject };
      this.flush();
    });
    if (got !== code) throw new Error(`smtp answered ${got}, expected ${code}`);
  }

  async command(line: string, code: number): Promise<void> {
    if (this.failure) throw this.failure;
    this.socket.write(`${line}\r\n`);
    await this.expect(code);
  }

  close(): void {
    this.socket.destroy();
  }
}
