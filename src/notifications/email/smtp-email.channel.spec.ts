import * as net from 'net';
import { SmtpEmailChannel } from './smtp-email.channel';

describe('SMTP STARTTLS', () => {
  it('refuses plaintext replies injected after the STARTTLS 220', async () => {
    const received: string[] = [];
    const server = net.createServer((socket) => {
      socket.write('220 test ESMTP\r\n');
      let buffer = '';
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        let index: number;
        while ((index = buffer.indexOf('\r\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          received.push(line);
          if (line.startsWith('EHLO')) {
            socket.write('250-test\r\n250 STARTTLS\r\n');
          } else if (line === 'STARTTLS') {
            // Attacker appends a reply meant to be read after the upgrade
            socket.write('220 go ahead\r\n250-evil\r\n250 AUTH PLAIN\r\n');
          }
        }
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as net.AddressInfo;
    try {
      const channel = new SmtpEmailChannel({
        host: '127.0.0.1',
        port,
        secure: false,
        from: 'pos@example.com',
        requireTls: true,
        timeoutMs: 5000,
      });
      await expect(
        channel.send({ to: 'a@example.com', subject: 's', text: 't' }),
      ).rejects.toThrow(/unexpected data after STARTTLS/);
    } finally {
      server.close();
    }
    expect(received).not.toContain('MAIL FROM:<pos@example.com>');
  });
});
