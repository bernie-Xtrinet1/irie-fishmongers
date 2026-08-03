import {
  CHECKOUT_PENDING_INITIAL_LEASE_SECONDS,
  MAX_CHECKOUT_PENDING_SECONDS,
  MAX_RESERVATION_LIFETIME_SECONDS,
  RESERVATION_ENTRY_VERSION,
  RESERVATION_HASH_TTL_SECONDS,
  RESERVATION_TTL_SECONDS,
  cartIndexKey,
  isCurrentReservationKey,
  isLegacyReservationKey,
  productIndexKey,
  productSuspectKey,
  productTotalKey,
  reservationKey,
} from './inventory.constants';

describe('reservationKey', () => {
  it('generates the exact expected key', () => {
    expect(reservationKey('cart-1', 'product-1')).toBe('inv:reserved:{cart-1}:product-1');
  });

  it('produces the same hash tag for the same cart across different products', () => {
    const first = reservationKey('cart-1', 'product-1');
    const second = reservationKey('cart-1', 'product-2');
    expect(first.match(/\{.*?\}/)?.[0]).toBe(second.match(/\{.*?\}/)?.[0]);
  });

  it('produces different hash tags for different carts', () => {
    const first = reservationKey('cart-1', 'product-1');
    const second = reservationKey('cart-2', 'product-1');
    expect(first.match(/\{.*?\}/)?.[0]).not.toBe(second.match(/\{.*?\}/)?.[0]);
  });

  it('produces output recognized as a current key, not a legacy one', () => {
    const key = reservationKey('cart-1', 'product-1');
    expect(isCurrentReservationKey(key)).toBe(true);
    expect(isLegacyReservationKey(key)).toBe(false);
  });

  it('rejects an empty cartId', () => {
    expect(() => reservationKey('', 'product-1')).toThrow('cartId cannot be empty');
  });

  it('rejects an empty productId', () => {
    expect(() => reservationKey('cart-1', '')).toThrow('productId cannot be empty');
  });

  it.each(['{', '}', ':'])('rejects a cartId containing %s', (delimiter) => {
    expect(() => reservationKey(`cart${delimiter}1`, 'product-1')).toThrow(
      "cartId cannot contain '{', '}', or ':'",
    );
  });

  it.each(['{', '}', ':'])('rejects a productId containing %s', (delimiter) => {
    expect(() => reservationKey('cart-1', `product${delimiter}1`)).toThrow(
      "productId cannot contain '{', '}', or ':'",
    );
  });

  it('rejects leading/trailing whitespace on either argument', () => {
    expect(() => reservationKey(' cart-1 ', 'product-1')).toThrow('cartId cannot contain whitespace');
    expect(() => reservationKey('cart-1', ' product-1 ')).toThrow(
      'productId cannot contain whitespace',
    );
  });

  it('rejects embedded whitespace on either argument', () => {
    expect(() => reservationKey('cart 1', 'product-1')).toThrow('cartId cannot contain whitespace');
    expect(() => reservationKey('cart-1', 'product 1')).toThrow('productId cannot contain whitespace');
  });
});

describe('isLegacyReservationKey / isCurrentReservationKey', () => {
  it('recognizes a valid legacy key only as legacy', () => {
    const key = 'inv:reserved:product-1';
    expect(isLegacyReservationKey(key)).toBe(true);
    expect(isCurrentReservationKey(key)).toBe(false);
  });

  it('recognizes a valid current key only as current', () => {
    const key = 'inv:reserved:{cart-1}:product-1';
    expect(isCurrentReservationKey(key)).toBe(true);
    expect(isLegacyReservationKey(key)).toBe(false);
  });

  it.each([
    ['empty productId segment', 'inv:reserved:'],
    ['empty cart tag', 'inv:reserved:{}:product-1'],
    ['missing productId after a valid tag', 'inv:reserved:{cart-1}:'],
    ['missing productId segment entirely', 'inv:reserved:{cart-1}'],
    ['an extra nested segment', 'inv:reserved:{cart-1}:{extra}:product-1'],
    ['a wrong prefix', 'not:reserved:product-1'],
    ['whitespace inside the cart tag', 'inv:reserved:{cart 1}:product-1'],
    ['whitespace inside the productId segment', 'inv:reserved:{cart-1}:product 1'],
    ['whitespace inside a legacy productId', 'inv:reserved:product 1'],
  ])('rejects a malformed key with %s by both discriminators', (_description, key) => {
    expect(isLegacyReservationKey(key)).toBe(false);
    expect(isCurrentReservationKey(key)).toBe(false);
  });

  it.each([
    'inv:reserved:product-1',
    'inv:reserved:{cart-1}:product-1',
    'inv:reserved:',
    'inv:reserved:{}:product-1',
    'inv:reserved:{cart-1}:{extra}:product-1',
    'not:reserved:product-1',
  ])('never recognizes %s as both legacy and current at once', (key) => {
    expect(isLegacyReservationKey(key) && isCurrentReservationKey(key)).toBe(false);
  });
});

describe('cartIndexKey / productIndexKey / productTotalKey / productSuspectKey', () => {
  it('generates the exact expected keys', () => {
    expect(cartIndexKey('cart-1')).toBe('inv:reserved:cart-index:{cart-1}');
    expect(productIndexKey('product-1')).toBe('inv:reserved:product-index:{product-1}');
    expect(productTotalKey('product-1')).toBe('inv:reserved:product-total:{product-1}');
    expect(productSuspectKey('product-1')).toBe('inv:reserved:product-total-suspect:{product-1}');
  });

  it('rejects an empty identifier', () => {
    expect(() => cartIndexKey('')).toThrow('cartId cannot be empty');
    expect(() => productIndexKey('')).toThrow('productId cannot be empty');
    expect(() => productTotalKey('')).toThrow('productId cannot be empty');
    expect(() => productSuspectKey('')).toThrow('productId cannot be empty');
  });

  it.each(['{', '}', ':'])('rejects an identifier containing %s', (delimiter) => {
    expect(() => cartIndexKey(`cart${delimiter}1`)).toThrow(
      "cartId cannot contain '{', '}', or ':'",
    );
    expect(() => productIndexKey(`product${delimiter}1`)).toThrow(
      "productId cannot contain '{', '}', or ':'",
    );
  });

  it('rejects whitespace in an identifier', () => {
    expect(() => cartIndexKey(' cart-1 ')).toThrow('cartId cannot contain whitespace');
    expect(() => productIndexKey('product 1')).toThrow('productId cannot contain whitespace');
  });
});

describe('reservation timing and version constants', () => {
  it('has the exact approved values', () => {
    expect(RESERVATION_TTL_SECONDS).toBe(900);
    expect(RESERVATION_HASH_TTL_SECONDS).toBe(1800);
    expect(RESERVATION_ENTRY_VERSION).toBe(1);
    expect(MAX_RESERVATION_LIFETIME_SECONDS).toBe(3600);
    expect(CHECKOUT_PENDING_INITIAL_LEASE_SECONDS).toBe(180);
    expect(MAX_CHECKOUT_PENDING_SECONDS).toBe(600);
  });
});
