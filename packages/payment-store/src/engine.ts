import { decimalToMinor } from '@resolveai/shared';
import {
  PayPalError,
  type PayPalClient,
  type PayPalOrder,
  type PayPalCapture,
  type CreateOrderRequest,
} from '@resolveai/paypal-client';
import { PaymentError, hashPayload } from './db.js';
import { PaymentStore, type Account } from './store.js';
export type ProviderFactory = (account: Account) => PayPalClient;
export function verifyOrder(
  order: PayPalOrder,
  local: { id: string; amountMinor: string; currency: string },
  account: Account,
  expectedProviderId?: string,
) {
  if (expectedProviderId && order.id !== expectedProviderId)
    throw new PaymentError(
      409,
      'PROVIDER_ORDER_ID_MISMATCH',
      'Returned provider order ID does not match the persisted association',
    );
  const units = order.purchase_units;
  if (order.intent !== 'CAPTURE' || !units || units.length !== 1)
    throw new PaymentError(
      409,
      'PROVIDER_ORDER_INVALID',
      'Expected one CAPTURE purchase unit',
    );
  const unit = units[0]!;
  if (
    unit.reference_id !== local.id ||
    unit.custom_id !== local.id ||
    unit.payee?.merchant_id !== account.providerMerchantId ||
    unit.amount.currency_code !== local.currency ||
    unit.amount.currency_code !== 'USD' ||
    decimalToMinor(unit.amount.value).toString() !== local.amountMinor
  )
    throw new PaymentError(
      409,
      'PROVIDER_ORDER_MISMATCH',
      'Provider amount, currency, seller or order association does not match',
    );
  return unit;
}
export function verifyCapture(
  capture: PayPalCapture,
  order: PayPalOrder,
  local: { id: string; amountMinor: string; currency: string },
  account: Account,
) {
  const unit = verifyOrder(order, local, account);
  if (
    unit.payments?.captures?.length !== 1 ||
    unit.payments.captures[0]?.id !== capture.id ||
    capture.final_capture === false ||
    capture.amount.currency_code !== local.currency ||
    decimalToMinor(capture.amount.value).toString() !== local.amountMinor ||
    (capture.supplementary_data?.related_ids.order_id &&
      capture.supplementary_data.related_ids.order_id !== order.id)
  )
    throw new PaymentError(
      409,
      'CAPTURE_MISMATCH',
      'Capture is not a full matching payment for this order',
    );
}
export class PaymentEngine {
  constructor(
    readonly store: PaymentStore,
    readonly provider: ProviderFactory,
  ) {}
  async run(merchantId: string, id: string) {
    const op = await this.store.claim(merchantId, id);
    if (!op) return;
    try {
      const context = await this.store.load(merchantId, id);
      if (!context)
        throw new PaymentError(
          409,
          'ACCOUNT_UNAVAILABLE',
          'Payment account unavailable',
        );
      const { account, order, merchant } = context;
      if (merchant.status !== 'ACTIVE')
        throw new PaymentError(
          409,
          'MERCHANT_UNAVAILABLE',
          'Merchant cannot accept payments',
        );
      const client = this.provider(account);
      if (hashPayload(op.requestPayload) !== op.requestHash)
        throw new PaymentError(
          409,
          'PAYLOAD_HASH_MISMATCH',
          'Stored payment payload changed',
        );
      if (order.status === 'CANCELLED')
        throw new PaymentError(409, 'ORDER_CANCELLED', 'Order was cancelled');
      if (op.kind === 'CREATE') {
        let remote: PayPalOrder;
        if (op.providerOrderId)
          remote = await client.getOrder(op.providerOrderId);
        else {
          await this.store.beforePost(op);
          const created = await client.createOrder(
            op.requestPayload as CreateOrderRequest,
            op.requestId,
          );
          if (!(await this.store.rememberProviderOrder(op, created.id))) return;
          remote = await client.getOrder(created.id);
          if (remote.id !== created.id)
            throw new PaymentError(
              409,
              'PROVIDER_ID_MISMATCH',
              'Provider order ID changed',
            );
        }
        verifyOrder(remote, order, account, op.providerOrderId ?? remote.id);
        const approval = remote.links?.find(
          (l) => l.rel === 'approve' || l.rel === 'payer-action',
        )?.href;
        let approvalUrl: string | undefined;
        if (approval) {
          const url = new URL(approval);
          if (
            url.protocol !== 'https:' ||
            url.hostname !== 'www.sandbox.paypal.com'
          )
            throw new PaymentError(
              409,
              'INVALID_APPROVAL_URL',
              'Unexpected approval origin',
            );
          approvalUrl = approval;
        }
        if (remote.status === 'VOIDED') {
          await this.store.update(op, {
            state: 'FAILED',
            paymentState: 'CANCELLED',
            providerOrderId: remote.id,
            providerStatus: remote.status,
            action: 'PAYPAL_ORDER_VOIDED',
            nextMs: null,
          });
          return;
        }
        if (
          ![
            'CREATED',
            'PAYER_ACTION_REQUIRED',
            'SAVED',
            'APPROVED',
            'COMPLETED',
          ].includes(remote.status)
        )
          throw new PaymentError(
            409,
            'UNKNOWN_ORDER_STATUS',
            'Unsupported provider order status',
          );
        const approved = ['APPROVED', 'COMPLETED'].includes(remote.status);
        const persisted = await this.store.update(op, {
          state: 'COMPLETED',
          paymentState: approved ? 'APPROVED' : 'AWAITING_BUYER_APPROVAL',
          providerOrderId: remote.id,
          providerStatus: remote.status,
          ...(approvalUrl ? { approvalUrl } : {}),
          action: approved
            ? 'BUYER_APPROVAL_VERIFIED'
            : 'PAYPAL_ORDER_VERIFIED',
          nextMs: approved ? null : 15000,
        });
        if (persisted && approved)
          await this.store.ensureCapture({ ...op, providerOrderId: remote.id });
        return;
      }
      if (!op.providerOrderId)
        throw new PaymentError(
          409,
          'MISSING_PROVIDER_ORDER',
          'Capture requires persisted provider order',
        );
      let remote = await client.getOrder(op.providerOrderId);
      let unit = verifyOrder(
        remote,
        order,
        account,
        op.providerOrderId ?? remote.id,
      );
      let captures = unit.payments?.captures ?? [];
      if (captures.length === 0 && remote.status === 'APPROVED') {
        if (
          op.postAttempts >= 5 ||
          (op.retryUntil && op.retryUntil.getTime() <= Date.now())
        ) {
          await this.store.update(op, {
            state: 'UNKNOWN',
            paymentState: 'RECONCILIATION_REQUIRED',
            errorCode: 'RETRY_WINDOW_CLOSED',
            action: 'CAPTURE_RETRY_FROZEN_READS_CONTINUE',
            nextMs: 60000,
          });
          return;
        }
        await this.store.beforePost(op);
        await client.captureOrder(op.providerOrderId, op.requestId);
        remote = await client.getOrder(op.providerOrderId);
        unit = verifyOrder(
          remote,
          order,
          account,
          op.providerOrderId ?? remote.id,
        );
        captures = unit.payments?.captures ?? [];
      }
      if (captures.length === 0) {
        if (remote.status === 'VOIDED') {
          await this.store.update(op, {
            state: 'FAILED',
            paymentState: 'CANCELLED',
            providerStatus: remote.status,
            action: 'PAYPAL_ORDER_VOIDED',
            nextMs: null,
          });
          return;
        }
        await this.store.update(op, {
          state: remote.status === 'COMPLETED' ? 'UNKNOWN' : 'PENDING',
          paymentState:
            remote.status === 'COMPLETED'
              ? 'RECONCILIATION_REQUIRED'
              : 'CAPTURE_PENDING',
          providerStatus: remote.status,
          action: 'CAPTURE_AWAITING_PROVIDER_STATE',
          nextMs: 15000,
        });
        return;
      }
      if (captures.length !== 1)
        throw new PaymentError(
          409,
          'MULTIPLE_CAPTURES',
          'Multiple captures require review',
        );
      const captured = await client.getCapture(captures[0]!.id);
      verifyCapture(captured, remote, order, account);
      if (captured.status === 'COMPLETED') {
        const completedAt = new Date(
          captured.create_time ?? new Date().toISOString(),
        );
        if (!Number.isFinite(completedAt.getTime()))
          throw new PaymentError(
            409,
            'INVALID_PROVIDER_TIME',
            'Invalid capture timestamp',
          );
        await this.store.complete(op, {
          id: captured.id,
          amountMinor: decimalToMinor(captured.amount.value).toString(),
          currency: captured.amount.currency_code,
          status: captured.status,
          completedAt,
        });
        return;
      }
      if (['DECLINED', 'FAILED', 'DENIED'].includes(captured.status)) {
        await this.store.update(op, {
          state: 'FAILED',
          paymentState: 'FAILED',
          providerCaptureId: captured.id,
          providerStatus: captured.status,
          action: 'CAPTURE_DEFINITIVELY_FAILED',
          nextMs: null,
        });
        return;
      }
      if (captured.status !== 'PENDING')
        throw new PaymentError(
          409,
          'CAPTURE_REQUIRES_REVIEW',
          'Unexpected settlement state',
        );
      await this.store.update(op, {
        state: 'PENDING',
        paymentState: 'CAPTURE_PENDING',
        providerCaptureId: captured.id,
        providerStatus: captured.status,
        action: 'CAPTURE_PENDING',
        nextMs: 15000,
      });
    } catch (error) {
      const current = await this.store.load(merchantId, id);
      const attempts = current?.op.postAttempts ?? 0;
      const deadline = current?.op.retryUntil;
      const retryExpired =
        attempts >= 5 || Boolean(deadline && deadline.getTime() <= Date.now());
      const manual = error instanceof PaymentError;
      const code =
        error instanceof PayPalError || error instanceof PaymentError
          ? error.code
          : 'PROCESSING_UNCERTAIN';
      const definitelyFailed =
        error instanceof PayPalError &&
        !error.uncertain &&
        !error.retryable &&
        [400, 401, 403, 422].includes(error.status) &&
        ![
          'ORDER_ALREADY_CAPTURED',
          'DUPLICATE_REQUEST_ID',
          'PREVIOUS_REQUEST_IN_PROGRESS',
        ].includes(error.code);
      const frozen = manual || (retryExpired && !op.providerOrderId);
      await this.store.update(op, {
        state: definitelyFailed ? 'FAILED' : 'UNKNOWN',
        paymentState: definitelyFailed ? 'FAILED' : 'RECONCILIATION_REQUIRED',
        errorCode: code,
        action: definitelyFailed
          ? 'PAYMENT_DEFINITIVELY_FAILED'
          : 'PAYMENT_RECONCILIATION_REQUIRED',
        nextMs:
          definitelyFailed || frozen
            ? null
            : Math.max(
                error instanceof PayPalError ? (error.retryAfterMs ?? 0) : 0,
                Math.min(60000, 1000 * 2 ** Math.min(op.attemptCount, 6)),
              ),
      });
    }
  }
}
