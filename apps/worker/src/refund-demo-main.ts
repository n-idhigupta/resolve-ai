import { PaymentDatabase } from '@resolveai/payment-store';
import { startMockRefundWorker } from './refund-worker.js';
if (
  process.env.RESOLVEAI_WORKER_ISOLATED !== 'true' ||
  process.env.PAYPAL_CLIENT_SECRET ||
  process.env.GEMINI_API_KEY ||
  process.env.OPENAI_API_KEY
)
  throw Error('Isolated credential-free mock worker required');
const db = new PaymentDatabase(process.env.WORKER_DATABASE_URL!);
const worker = await startMockRefundWorker(process.env.REDIS_URL!, db);
console.log(
  'Synthetic mock refund worker ready; no provider credentials or network calls.',
);
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void worker.close().then(() => db.close());
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
