import { it, expect } from 'vitest';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { validateContent } from './scanner.js';
it('validates actual image and PDF structures and rejects content spoofing', async () => {
  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: 'white' },
  })
    .png()
    .toBuffer();
  await expect(validateContent(png, 'image/png', 'photo.png')).resolves.toBe(
    'image/png',
  );
  const doc = await PDFDocument.create();
  doc.addPage([100, 100]);
  const pdf = Buffer.from(await doc.save());
  await expect(
    validateContent(pdf, 'application/pdf', 'receipt.pdf'),
  ).resolves.toBe('application/pdf');
  await expect(
    validateContent(Buffer.from('not image'), 'image/png', 'photo.png'),
  ).rejects.toThrow();
  await expect(
    validateContent(png, 'image/jpeg', 'photo.jpg'),
  ).rejects.toThrow();
  await expect(
    validateContent(Buffer.from([255, 255]), 'text/plain', 'x.txt'),
  ).rejects.toThrow();
});
