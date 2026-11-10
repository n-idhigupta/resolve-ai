import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:net';
import sharp from 'sharp';
import { PDFDocument, PDFName } from 'pdf-lib';
export async function clamCommand(
  command: string,
  bytes?: Buffer,
  host = process.env.CLAMAV_HOST ?? '127.0.0.1',
  port = Number(process.env.CLAMAV_PORT ?? 3310),
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let reply = '';
    socket.setTimeout(15000);
    socket.on('timeout', () => socket.destroy(Error('SCANNER_TIMEOUT')));
    socket.on('error', reject);
    socket.on('data', (chunk) => {
      reply += chunk.toString();
      if (reply.length > 4096) socket.destroy(Error('SCANNER_REPLY_TOO_LARGE'));
      if (reply.includes('\0') || reply.includes('\n')) {
        socket.end();
        resolve(reply.replace(/\0/g, '').trim());
      }
    });
    socket.on('connect', () => {
      socket.write('z' + command + '\0');
      if (bytes) {
        for (let i = 0; i < bytes.length; i += 65536) {
          const part = bytes.subarray(i, i + 65536),
            length = Buffer.alloc(4);
          length.writeUInt32BE(part.length);
          socket.write(length);
          socket.write(part);
        }
        socket.write(Buffer.alloc(4));
      }
    });
    socket.on('end', () => {
      if (!reply) reject(Error('SCANNER_EMPTY_RESPONSE'));
    });
  });
}
export async function scan(bytes: Buffer) {
  const version = await clamCommand('VERSION');
  const date = version.split('/').slice(2).join('/');
  const timestamp = Date.parse(date);
  if (!Number.isFinite(timestamp) || Date.now() - timestamp > 7 * 86400000)
    throw Error('SCANNER_SIGNATURES_STALE');
  const result = await clamCommand('INSTREAM', bytes);
  if (result.endsWith(' FOUND')) return { clean: false, version };
  if (!result.endsWith(' OK')) throw Error('SCANNER_UNAVAILABLE');
  return { clean: true, version };
}
export async function validateContent(
  bytes: Buffer,
  mime: string,
  filename: string,
) {
  const ext = filename.split('.').pop()?.toLowerCase();
  const allowed: Record<string, string[]> = {
    'image/jpeg': ['jpg', 'jpeg'],
    'image/png': ['png'],
    'application/pdf': ['pdf'],
    'text/plain': ['txt'],
  };
  if (!ext || !allowed[mime]?.includes(ext)) throw Error('TYPE_MISMATCH');
  if (mime.startsWith('image/')) {
    const result = await sharp(bytes, {
      limitInputPixels: 20000000,
      failOn: 'warning',
    }).metadata();
    if (
      result.format !== (mime === 'image/png' ? 'png' : 'jpeg') ||
      (result.pages ?? 1) !== 1
    )
      throw Error('TYPE_MISMATCH');
    await sharp(bytes, { limitInputPixels: 20000000 }).raw().toBuffer();
  } else if (mime === 'application/pdf') {
    if (
      !bytes.subarray(0, 5).equals(Buffer.from('%PDF-')) ||
      bytes.length > 5242880
    )
      throw Error('PDF_UNSUPPORTED');
    const pdf = await PDFDocument.load(bytes, {
      ignoreEncryption: false,
      throwOnInvalidObject: true,
      updateMetadata: false,
    });
    if (pdf.getPageCount() > 100 || pdf.isEncrypted)
      throw Error('PDF_UNSUPPORTED');
    for (const [, object] of pdf.context.enumerateIndirectObjects()) {
      const text = object.toString();
      if (/\/(JavaScript|JS|Launch|EmbeddedFile|OpenAction|AA)\b/.test(text))
        throw Error('PDF_ACTIVE_CONTENT');
    }
    if (pdf.catalog.has(PDFName.of('OpenAction')))
      throw Error('PDF_ACTIVE_CONTENT');
  } else {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (
      bytes.includes(0) ||
      bytes.some((b) => b < 32 && ![9, 10, 13].includes(b))
    )
      throw Error('TEXT_UNSUPPORTED');
  }
  return mime;
}

export async function validateIsolated(
  bytes: Buffer,
  mime: string,
  filename: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--max-old-space-size=128',
        fileURLToPath(new URL('./validate-child.js', import.meta.url)),
        mime,
        filename,
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] },
    );
    let reply = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(Error('VALIDATION_TIMEOUT'));
    }, 10000);
    child.on('error', () => {
      clearTimeout(timer);
      reject(Error('VALIDATION_UNAVAILABLE'));
    });
    child.stdout.on('data', (part: Buffer) => {
      reply += part.toString();
      if (reply.length > 20) child.kill();
    });
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && reply === 'VALID') resolve();
      else reject(Error('CONTENT_UNSUPPORTED'));
    });
    child.stdin.end(bytes);
  });
}
