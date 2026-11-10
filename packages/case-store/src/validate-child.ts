import { validateContent } from './scanner.js';
const chunks: Buffer[] = [];
let length = 0;
process.stdin.on('data', (part: Buffer) => {
  length += part.length;
  if (length > 10485760) process.exit(2);
  chunks.push(part);
});
process.stdin.on('end', () => {
  void validateContent(
    Buffer.concat(chunks),
    process.argv[2] ?? '',
    process.argv[3] ?? '',
  )
    .then(() => {
      process.stdout.write('VALID');
    })
    .catch(() => {
      process.exitCode = 2;
    });
});
