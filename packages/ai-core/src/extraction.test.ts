import sharp from 'sharp';
import { it, expect } from 'vitest';
import { extractEvidence } from '../dist/extraction.js';
it('isolates UTF-8 extraction and rejects invalid and oversized content', async () => {
  expect(
    (await extractEvidence(Buffer.from('Synthetic text'), 'text/plain'))
      .pages[0]?.text,
  ).toBe('Synthetic text');
  await expect(
    extractEvidence(Buffer.from([0xff, 0xfe]), 'text/plain'),
  ).rejects.toThrow();
  expect(
    (await extractEvidence(Buffer.from('x'.repeat(100001)), 'text/plain'))
      .omissions,
  ).toContain('TEXT_TRUNCATED');
}, 30000);
it('decodes and re-encodes an actual PNG with bounded dimensions', async () => {
  const bytes = await sharp({
    create: { width: 8, height: 8, channels: 3, background: '#ffffff' },
  })
    .png()
    .toBuffer();
  const result = await extractEvidence(bytes, 'image/png');
  expect(result.images[0]?.dataUrl).toMatch(/^data:image\/png;base64,/);
});
it('parses an actual bounded synthetic PDF page', async () => {
  const stream = 'BT /F1 12 Tf 20 100 Td (Synthetic PDF evidence) Tj ET';
  const pdf =
    '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj\n4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n5 0 obj << /Length ' +
    stream.length +
    ' >> stream\n' +
    stream +
    '\nendstream endobj\ntrailer << /Root 1 0 R >>\n%%EOF';
  const result = await extractEvidence(Buffer.from(pdf), 'application/pdf');
  expect(result.pages[0]?.text).toContain('Synthetic PDF evidence');
}, 20000);
