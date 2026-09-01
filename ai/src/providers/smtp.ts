/**
 * Just enough SMTP to send one email.
 *
 * No dependency, for the same reason the Google JWT is signed with node:crypto:
 * this sits in the path of a credential, and — unlike everything else here — in
 * the path of a SAFETY feature. A mail library is a large amount of code and a
 * transitive tree to audit for the sake of nine commands and a DATA block.
 *
 * Supports the three shapes a real deployment uses:
 *   tls       implicit TLS, port 465 (Gmail, most hosted relays)
 *   starttls  plaintext then upgrade, port 587 (the other Gmail default)
 *   none      port 25 to a relay on localhost — and the only mode that can be
 *             tested against an in-process server, which is why it exists
 *
 * Deliberately NOT implemented: connection pooling, retries (the caller owns
 * that, because it owns what a failure means), DKIM, attachments, HTML bodies.
 */

import net from "node:net";
import tls from "node:tls";

export type MailMessage = {
  to: string[];
  subject: string;
  /** Plain text. Sent base64 so Devanagari and Tamil survive the transport. */
  text: string;
};

/** The seam everything above this file depends on. */
export type MailSender = (msg: MailMessage) => Promise<void>;

export type SmtpConfig = {
  host: string;
  port: number;
  security: "tls" | "starttls" | "none";
  user: string | null;
  pass: string | null;
  /** Envelope sender. Gmail rewrites this to the authenticated account. */
  from: string;
  timeoutMs?: number;
};

type Reply = { code: number; lines: string[] };

const DEFAULT_TIMEOUT_MS = 15_000;

/** A line-oriented SMTP reader that understands multi-line replies. */
class Conn {
  #socket: net.Socket;
  #buf = "";
  #lines: string[] = [];
  #waiters: Array<{ resolve: (r: Reply) => void; reject: (e: Error) => void }> = [];
  #failure: Error | null = null;

  constructor(socket: net.Socket, timeoutMs: number) {
    this.#socket = socket;
    this.#attach(timeoutMs);
  }

  #attach(timeoutMs: number): void {
    const s = this.#socket;
    s.setEncoding("utf8");
    s.setTimeout(timeoutMs, () => this.#fail(new Error("smtp: timed out")));
    s.on("data", (chunk: string) => this.#onData(chunk));
    s.on("error", (err: Error) => this.#fail(err));
    s.on("close", () => this.#fail(new Error("smtp: connection closed")));
  }

  #onData(chunk: string): void {
    this.#buf += chunk;
    let idx: number;
    while ((idx = this.#buf.indexOf("\n")) !== -1) {
      const line = this.#buf.slice(0, idx).replace(/\r$/, "");
      this.#buf = this.#buf.slice(idx + 1);
      this.#lines.push(line);
      // A continuation is `250-`; the final line of a reply is `250 ` or bare.
      if (/^\d{3}(?: |$)/.test(line)) {
        const lines = this.#lines;
        this.#lines = [];
        const waiter = this.#waiters.shift();
        waiter?.resolve({ code: Number(line.slice(0, 3)), lines });
      }
    }
  }

  #fail(err: Error): void {
    if (this.#failure) return;
    this.#failure = err;
    for (const w of this.#waiters.splice(0)) w.reject(err);
  }

  read(): Promise<Reply> {
    if (this.#failure) return Promise.reject(this.#failure);
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  /** Send a command and wait for its reply. */
  async command(line: string, expect: number[]): Promise<Reply> {
    if (this.#failure) throw this.#failure;
    this.#socket.write(`${line}\r\n`);
    return this.expect(expect, line);
  }

  async expect(codes: number[], what: string): Promise<Reply> {
    const reply = await this.read();
    if (!codes.includes(reply.code)) {
      // The server's own text is the only useful diagnosis — an app password
      // that was never enabled, a relay that refuses the sender, a rate limit.
      throw new Error(
        `smtp: ${redactCommand(what)} got ${reply.code}: ${reply.lines.join(" | ").slice(0, 300)}`,
      );
    }
    return reply;
  }

  /** STARTTLS: keep the socket, wrap it, and start reading the new one. */
  upgrade(host: string, timeoutMs: number): void {
    const plain = this.#socket;
    plain.removeAllListeners("data");
    plain.removeAllListeners("error");
    plain.removeAllListeners("close");
    plain.setTimeout(0);
    this.#socket = tls.connect({ socket: plain, servername: host });
    this.#buf = "";
    this.#lines = [];
    this.#attach(timeoutMs);
  }

  end(): void {
    try {
      this.#socket.write("QUIT\r\n");
    } catch {
      // Already gone. The mail was accepted at DATA; QUIT is a courtesy.
    }
    this.#socket.destroy();
  }
}

/** An AUTH line carries the password in base64 — never put it in an error. */
function redactCommand(line: string): string {
  if (/^AUTH /i.test(line)) return "AUTH";
  // The bare base64 arguments of AUTH LOGIN arrive as their own "commands".
  if (/^[A-Za-z0-9+/]+=*$/.test(line) && line.length > 8) return "<credential>";
  return line.slice(0, 60);
}

/** RFC 2047, so a non-ASCII subject is not mangled or rejected. */
function encodeHeader(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function formatMessage(cfg: SmtpConfig, msg: MailMessage): string {
  const headers = [
    `From: ${cfg.from}`,
    `To: ${msg.to.join(", ")}`,
    `Subject: ${encodeHeader(msg.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    // So a mail client shows this above the fold and does not thread it into an
    // earlier alert.
    "X-Priority: 1",
    "Importance: high",
  ];
  // Base64 in 76-column lines: the body carries Devanagari, Tamil and Bengali,
  // and 8-bit transport is not something every relay in the path guarantees.
  const body = Buffer.from(msg.text, "utf8")
    .toString("base64")
    .replace(/(.{76})/g, "$1\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${body}\r\n`;
}

/**
 * Connect, authenticate, send one message, disconnect.
 *
 * `connect` is injectable so the protocol above can be tested against an
 * in-process server rather than trusted by inspection.
 */
export function createSmtpSender(
  cfg: SmtpConfig,
  connect: (opts: { host: string; port: number; secure: boolean }) => net.Socket = defaultConnect,
): MailSender {
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async function send(msg: MailMessage): Promise<void> {
    if (msg.to.length === 0) throw new Error("smtp: no recipients");

    const socket = connect({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.security === "tls",
    });
    const conn = new Conn(socket, timeoutMs);

    try {
      await conn.expect([220], "greeting");
      await conn.command(`EHLO ${clientName(cfg.from)}`, [250]);

      if (cfg.security === "starttls") {
        await conn.command("STARTTLS", [220]);
        conn.upgrade(cfg.host, timeoutMs);
        // The extension list is renegotiated after the upgrade; AUTH is
        // usually advertised only once the channel is encrypted.
        await conn.command(`EHLO ${clientName(cfg.from)}`, [250]);
      }

      if (cfg.user && cfg.pass) {
        await conn.command("AUTH LOGIN", [334]);
        await conn.command(Buffer.from(cfg.user, "utf8").toString("base64"), [334]);
        await conn.command(Buffer.from(cfg.pass, "utf8").toString("base64"), [235]);
      }

      await conn.command(`MAIL FROM:<${cfg.from}>`, [250]);
      for (const to of msg.to) {
        // 251 is "will forward" — an accepted recipient, not a failure.
        await conn.command(`RCPT TO:<${to}>`, [250, 251]);
      }
      await conn.command("DATA", [354]);
      // Dot-stuffing: a body line of "." alone would otherwise end the message.
      const payload = formatMessage(cfg, msg).replace(/\r\n\./g, "\r\n..");
      await conn.command(`${payload}\r\n.`, [250]);
    } finally {
      conn.end();
    }
  };
}

function defaultConnect(opts: { host: string; port: number; secure: boolean }): net.Socket {
  return opts.secure
    ? tls.connect({ host: opts.host, port: opts.port, servername: opts.host })
    : net.connect({ host: opts.host, port: opts.port });
}

/** EHLO wants a domain. The sender's is the one we can be sure of. */
function clientName(from: string): string {
  const at = from.lastIndexOf("@");
  const domain = at === -1 ? "" : from.slice(at + 1).trim();
  return domain || "localhost";
}
