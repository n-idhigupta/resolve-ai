import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
export const extractionSchema = z.strictObject({
  pages: z
    .array(
      z.strictObject({
        page: z.number().int().positive(),
        text: z.string().max(100000),
      }),
    )
    .max(20),
  images: z
    .array(
      z.strictObject({
        page: z.number().int().positive(),
        dataUrl: z.string().max(3000000).startsWith('data:image/png;base64,'),
      }),
    )
    .max(4),
  omissions: z.array(z.string().max(60)).max(100),
});
export async function extractEvidence(bytes: Buffer, mime: string) {
  return new Promise<z.infer<typeof extractionSchema>>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {};
    for (const k of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'])
      if (process.env[k]) env[k] = process.env[k];
    const child = spawn(
      process.execPath,
      [
        '--max-old-space-size=256',
        '--disallow-code-generation-from-strings',
        fileURLToPath(new URL('./extract-child.js', import.meta.url)),
        mime,
      ],
      { env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] },
    );
    const timer = setTimeout(() => {
      child.kill();
      reject(Error('EXTRACTION_TIMEOUT'));
    }, 15000);
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 12000000) {
        child.kill();
        return;
      }
      chunks.push(c);
    });
    child.stdin.on('error', () => {});
    child.on('error', () => {
      clearTimeout(timer);
      reject(Error('EXTRACTION_UNAVAILABLE'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || size > 12000000) {
        reject(Error('EXTRACTION_UNSUPPORTED'));
        return;
      }
      try {
        resolve(
          extractionSchema.parse(JSON.parse(Buffer.concat(chunks).toString())),
        );
      } catch {
        reject(Error('EXTRACTION_INVALID'));
      }
    });
    child.stdin.end(bytes);
  });
}
