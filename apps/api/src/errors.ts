import { PaymentError } from '@resolveai/payment-store';
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function installErrors(app: FastifyInstance) {
  app.setErrorHandler((error, request, reply) => {
    let status = 500,
      code = 'INTERNAL_ERROR',
      detail = 'Unexpected server error';
    if (error instanceof AppError || error instanceof PaymentError) {
      status = error.status;
      code = error.code;
      detail = error.message;
    } else if (
      error instanceof ZodError ||
      (error instanceof Error && 'validation' in error)
    ) {
      status = 422;
      code = 'VALIDATION_ERROR';
      detail = 'Request validation failed';
    } else if (
      error instanceof Error &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      status = error.statusCode;
      code = status === 429 ? 'RATE_LIMITED' : 'INVALID_REQUEST';
      detail = 'Request rejected';
    }
    if (status >= 500)
      request.log.error(
        { errorType: error instanceof Error ? error.name : 'unknown' },
        'Request failed',
      );
    reply
      .status(status)
      .type('application/problem+json')
      .send({
        type: `urn:resolveai:error:${code}`,
        title: code,
        status,
        code,
        detail,
        requestId: request.id,
      });
  });
  app.setNotFoundHandler((request, reply) =>
    reply.status(404).type('application/problem+json').send({
      type: 'urn:resolveai:error:NOT_FOUND',
      title: 'NOT_FOUND',
      status: 404,
      code: 'NOT_FOUND',
      detail: 'Resource not found',
      requestId: request.id,
    }),
  );
}
