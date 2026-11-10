globalThis.fetch = async () => {
  throw Error('EXTRACTION_NETWORK_DISABLED');
};
import sharp from 'sharp';
import { createCanvas } from '@napi-rs/canvas';
const chunks: Buffer[] = [];
let size = 0;
process.stdin.on('data', (c: Buffer) => {
  size += c.length;
  if (size > 10485760) process.exit(2);
  chunks.push(c);
});
process.stdin.on('end', () => {
  void run(Buffer.concat(chunks))
    .then((out) => process.stdout.write(JSON.stringify(out)))
    .catch(() => {
      process.exitCode = 2;
    });
});
async function run(bytes: Buffer) {
  const mime = process.argv[2];
  const pages: { page: number; text: string }[] = [],
    images: { page: number; dataUrl: string }[] = [],
    omissions: string[] = [];
  if (mime === 'text/plain') {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    pages.push({ page: 1, text: text.slice(0, 100000) });
    if (text.length > 100000) omissions.push('TEXT_TRUNCATED');
  } else if (mime === 'image/png' || mime === 'image/jpeg') {
    const png = await sharp(bytes, { limitInputPixels: 20000000 })
      .resize({
        width: 1024,
        height: 1024,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();
    if (png.length > 2097152) throw Error('IMAGE_TOO_LARGE');
    images.push({
      page: 1,
      dataUrl: 'data:image/png;base64,' + png.toString('base64'),
    });
  } else if (mime === 'application/pdf') {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjs.getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: true,
      verbosity: 0,
      stopAtErrors: true,
    });
    const doc = await task.promise;
    try {
      if (doc.numPages > 20) omissions.push('PDF_PAGES_OMITTED');
      let chars = 0;
      for (let n = 1; n <= Math.min(20, doc.numPages); n++) {
        const page = await doc.getPage(n);
        const content = await page.getTextContent();
        const text = content.items
          .map((i) => ('str' in i ? i.str : ''))
          .join(' ');
        chars += text.length;
        if (chars > 100000) {
          omissions.push('TEXT_TRUNCATED');
          break;
        }
        if (text.trim()) pages.push({ page: n, text });
        else if (images.length < 4) {
          const raw = page.getViewport({ scale: 1 }),
            scale = Math.min(1, 1024 / Math.max(raw.width, raw.height)),
            viewport = page.getViewport({ scale }),
            canvas = createCanvas(
              Math.ceil(viewport.width),
              Math.ceil(viewport.height),
            );
          await page.render({
            canvas: canvas as unknown as HTMLCanvasElement,
            canvasContext: canvas.getContext(
              '2d',
            ) as unknown as CanvasRenderingContext2D,
            viewport,
          }).promise;
          const png = canvas.toBuffer('image/png');
          if (png.length > 2097152) throw Error('IMAGE_TOO_LARGE');
          images.push({
            page: n,
            dataUrl: 'data:image/png;base64,' + png.toString('base64'),
          });
        } else omissions.push('SCANNED_PAGES_OMITTED');
        page.cleanup();
      }
    } finally {
      await task.destroy();
    }
  } else throw Error('UNSUPPORTED');
  return { pages, images, omissions };
}
