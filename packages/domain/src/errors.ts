export type DomainErrorCode =
  | 'INVALID_TRANSITION'
  | 'INVALID_ORDER_ID'
  | 'INVALID_AMOUNT'
  | 'INVALID_QUANTITY'
  | 'EMPTY_CART'
  | 'PER_ORDER_LIMIT'
  | 'PER_CUSTOMER_LIMIT'
  | 'VOUCHER_INACTIVE'
  | 'VOUCHER_EXHAUSTED'
  | 'VOUCHER_MIN_SUBTOTAL'
  | 'REFUND_EXCEEDS_PAID';

/** A business rule violation. `code` is what the API puts in Problem Details. */
export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}
