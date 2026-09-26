import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { AllExceptionsFilter } from './http-exception.filter';
import { businessError } from '../errors/error-codes';

function respond(exception: unknown) {
  const json = jest.fn();
  const response = {
    headersSent: false,
    status: jest.fn(() => ({ json })),
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({
        url: '/api/v1/x',
        originalUrl: '/api/v1/x',
        method: 'POST',
        headers: {},
      }),
    }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter().catch(exception, host);
  const [[status]] = response.status.mock.calls as unknown as [[number]];
  const [[body]] = json.mock.calls as [[Record<string, unknown>]];
  return { status, body };
}

describe('error responses: machine-readable code and retryable', () => {
  // Unexpected errors are logged with their stack; keep the test output clean
  beforeAll(() => jest.spyOn(Logger.prototype, 'error').mockImplementation());
  afterAll(() => jest.restoreAllMocks());

  it('keeps the existing shape and adds code/retryable', () => {
    const { status, body } = respond(new NotFoundException('Sale not found'));
    expect(status).toBe(404);
    expect(body).toMatchObject({
      statusCode: 404,
      message: 'Sale not found',
      error: 'Not Found',
      code: 'NOT_FOUND',
      retryable: false,
      path: '/api/v1/x',
      method: 'POST',
    });
  });

  it('VALIDATION_FAILED for class-validator message lists', () => {
    const { body } = respond(
      new BadRequestException(['amount must be a number']),
    );
    expect(body).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: ['amount must be a number'],
    });
  });

  it('derives codes from well-known messages', () => {
    expect(
      respond(new BadRequestException('Insufficient stock for SKU-1')).body
        .code,
    ).toBe('INSUFFICIENT_STOCK');
    expect(
      respond(
        new ConflictException(
          'This register has no open shift to pay the expense from',
        ),
      ).body.code,
    ).toBe('SHIFT_NOT_OPEN');
    expect(
      respond(new ConflictException('Cannot pay an expense that is draft')).body
        .code,
    ).toBe('INVALID_STATE_TRANSITION');
  });

  it('keeps a code thrown by a service (and its extra fields), unchanged status', () => {
    const { status, body } = respond(
      new BadRequestException({
        message: 'A reason is required',
        error: 'Bad Request',
        code: 'reason_required',
        variance: -12,
      }),
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({
      code: 'reason_required',
      retryable: false,
      variance: -12,
    });
  });

  it('businessError() sets an explicit code and retry hint', () => {
    const { status, body } = respond(
      businessError(ConflictException, 'SHIFT_CLOSED', 'Shift is closed', {
        retryable: false,
        shiftId: 's1',
      }),
    );
    expect(status).toBe(409);
    expect(body).toMatchObject({
      code: 'SHIFT_CLOSED',
      retryable: false,
      shiftId: 's1',
      message: 'Shift is closed',
    });
  });

  it('permission and approval errors', () => {
    expect(
      respond(
        new ForbiddenException({
          message: 'Missing permission',
          missingPermissions: ['sales.void'],
        }),
      ).body.code,
    ).toBe('PERMISSION_DENIED');
    expect(
      respond(
        new ForbiddenException({
          message: 'Manager approval needed',
          missingPermissions: ['sales.void'],
          approvable: true,
        }),
      ).body.code,
    ).toBe('APPROVAL_REQUIRED');
  });

  it('retryable for 429 / 503 / unexpected errors, not for 4xx', () => {
    expect(respond(new HttpException('Slow down', 429)).body).toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
    });
    expect(respond(new ServiceUnavailableException()).body).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      retryable: true,
    });
    expect(respond(new InternalServerErrorException()).body.retryable).toBe(
      true,
    );
    expect(respond(new Error('kaboom')).body).toMatchObject({
      statusCode: 500,
      code: 'INTERNAL_ERROR',
      retryable: true,
    });
    expect(respond(new ConflictException('x')).body.retryable).toBe(false);
  });

  it('flags transient database errors', () => {
    const error = new QueryFailedError('UPDATE ...', [], {
      code: '40001',
      message: 'could not serialize access',
    } as unknown as Error);
    expect(respond(error).body).toMatchObject({
      statusCode: 500,
      code: 'TRANSIENT_DATABASE_ERROR',
      retryable: true,
    });
  });
});
