import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mimeContent, gmailContent } from './message-content.mjs';
import { readMessage } from './imap.mjs';

test('MIME alternatives decode text, HTML, folded headers, and attachments', () => {
  const content = mimeContent('Content-Type: multipart/mixed;\r\n boundary="outer"\r\n\r\n--outer\r\nContent-Type: multipart/alternative; boundary=inner\r\n\r\n--inner\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nHello =E2=9C=93\r\n--inner\r\nContent-Type: text/html\r\nContent-Transfer-Encoding: base64\r\n\r\nPGI+SGVsbG88L2I+\r\n--inner--\r\n--outer\r\nContent-Type: application/pdf; name="report.pdf"\r\n\r\nencoded-data\r\n--outer--\r\n');
  assert.equal(content.text, 'Hello ✓');
  assert.equal(content.html, '<b>Hello</b>');
  assert.deepEqual(content.attachments, [{ name: 'report.pdf' }]);
});

test('Gmail nested body parts decode base64url and do not render attachment data', () => {
  const content = gmailContent({ parts: [{ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('Hello ✓').toString('base64url') } }] }, { filename: 'note.txt', body: { data: 'c2VjcmV0', size: 6 } }] });
  assert.equal(content.text, 'Hello ✓'); assert.deepEqual(content.attachments, [{ name: 'note.txt', size: 6 }]);
});

test('IMAP body uses stable UID and byte-counted literals; body text cannot end the command', async t => {
  const source = 'Content-Type: text/plain; charset=utf-8\r\n\r\nHello ✓\r\na3 OK this is message content\r\nLast line';
  const commands = [];
  const server = createServer(socket => {
    socket.write('* OK ready\r\n'); let input = '';
    socket.on('data', chunk => {
      input += chunk;
      while (input.includes('\r\n')) {
        const end = input.indexOf('\r\n'), line = input.slice(0, end); input = input.slice(end + 2); commands.push(line);
        const tag = line.split(' ')[0];
        if (line.includes('UID FETCH')) {
          socket.write(`* 1 FETCH (BODY[] {${Buffer.byteLength(source)}}\r\n`);
          const bytes = Buffer.from(source); socket.write(bytes.subarray(0, 52));
          setImmediate(() => socket.write(Buffer.concat([bytes.subarray(52), Buffer.from(`\r\n)\r\n${tag} OK done\r\n`)])));
        } else socket.write(`${tag} OK done\r\n`);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const content = await readMessage(`127.0.0.1:${server.address().port}`, { login: 'person', password: 'test', uid: 42 });
  assert.equal(content.text, 'Hello ✓\r\na3 OK this is message content\r\nLast line');
  assert.ok(commands.some(line => line.endsWith('UID FETCH 42 (BODY.PEEK[])')));
});
