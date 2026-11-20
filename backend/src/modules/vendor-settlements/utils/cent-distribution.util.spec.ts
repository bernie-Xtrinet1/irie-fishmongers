import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import {
  centsBigIntToDecimal,
  decimalToCentsBigInt,
  distributeAmountHamilton,
  parseExactMonetary2dp,
} from './cent-distribution.util';

describe('cent-distribution.util', () => {
  describe('parseExactMonetary2dp', () => {
    it('accepts exact 0, 1, and 2 decimal place inputs', () => {
      expect(parseExactMonetary2dp('100', 'amount').toFixed(2)).toBe('100.00');
      expect(parseExactMonetary2dp('10.5', 'amount').toFixed(2)).toBe('10.50');
      expect(parseExactMonetary2dp(45.55, 'amount').toFixed(2)).toBe('45.55');
      expect(parseExactMonetary2dp(new Prisma.Decimal('0.01'), 'amount').toFixed(2)).toBe('0.01');
      expect(parseExactMonetary2dp('10.5000', 'amount').toFixed(2)).toBe('10.50');
    });

    it('strictly rejects sub-cent inputs (> 2 decimal places) without silent rounding', () => {
      for (const bad of ['10.004', '10.005', '10.123', 10.004, 0.001, 0.1 + 0.2]) {
        expect(() => parseExactMonetary2dp(bad, 'amount')).toThrow(BadRequestException);
      }
    });

    it('rejects non-finite, empty, zero, and negative inputs when not allowed', () => {
      for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '', '   ', 'abc', '0', '-1.00', -5]) {
        expect(() => parseExactMonetary2dp(bad, 'amount')).toThrow(BadRequestException);
      }
      expect(parseExactMonetary2dp('0.00', 'amount', { allowZero: true }).toFixed(2)).toBe('0.00');
      expect(
        parseExactMonetary2dp('-12.34', 'amount', { allowNegative: true }).toFixed(2),
      ).toBe('-12.34');
      expect(() =>
        parseExactMonetary2dp('12.34', 'amount', { allowNegative: true, onlyNegative: true }),
      ).toThrow(BadRequestException);
    });

    it('converts exact 2dp values to and from BigInt cents losslessly', () => {
      const cents = decimalToCentsBigInt('99999999.99', 'amount');
      expect(cents).toBe(9999999999n);
      expect(centsBigIntToDecimal(cents).toFixed(2)).toBe('99999999.99');
    });
  });

  describe('distributeAmountHamilton', () => {
    it('distributes $100.00 across 3 equal targets deterministically as 33.34 / 33.33 / 33.33 sorted targetId ASC', () => {
      const result = distributeAmountHamilton({
        amount: '100.00',
        targets: [
          { targetId: 'vo-c', weight: '33.33', maxCeiling: '33.34' },
          { targetId: 'vo-a', weight: '33.33', maxCeiling: '33.34' },
          { targetId: 'vo-b', weight: '33.33', maxCeiling: '33.34' },
        ],
      });

      expect(result.allocatedCents).toBe(10000n);
      expect(result.residualCents).toBe(0n);
      expect(result.allocations.map((a) => ({ id: a.targetId, amt: a.amount.toFixed(2) }))).toEqual([
        { id: 'vo-a', amt: '33.34' },
        { id: 'vo-b', amt: '33.33' },
        { id: 'vo-c', amt: '33.33' },
      ]);
    });

    it('is 100% invariant to input enumeration order and repeated invocations', () => {
      const baseTargets = [
        { targetId: 'id-3', weight: '17.25', maxCeiling: '50.00' },
        { targetId: 'id-1', weight: '31.50', maxCeiling: '50.00' },
        { targetId: 'id-4', weight: '19.75', maxCeiling: '50.00' },
        { targetId: 'id-2', weight: '31.50', maxCeiling: '50.00' },
      ];

      const run1 = distributeAmountHamilton({ amount: '47.89', targets: baseTargets });
      const run2 = distributeAmountHamilton({
        amount: '47.89',
        targets: [...baseTargets].reverse(),
      });
      const run3 = distributeAmountHamilton({
        amount: '47.89',
        targets: [baseTargets[2]!, baseTargets[0]!, baseTargets[3]!, baseTargets[1]!],
      });

      const snapshot = (r: typeof run1) =>
        r.allocations.map((a) => `${a.targetId}:${a.amountCents.toString()}`);

      expect(run1.allocatedCents).toBe(4789n);
      expect(snapshot(run2)).toEqual(snapshot(run1));
      expect(snapshot(run3)).toEqual(snapshot(run1));
    });

    it('awards remainder cents strictly by descending fractional remainder regardless of targetId order', () => {
      // Total 10 cents weighted 10:15:25 (= 2 + 3 + 5 => sum weights 50).
      // Split 1 cent? Better: split 11 cents across weights [1, 2, 3] (sum=6):
      // id-a (w=1): 11*1/6 = 1 rem 5
      // id-b (w=2): 11*2/6 = 3 rem 4
      // id-c (w=3): 11*3/6 = 5 rem 3
      // Base sum = 1 + 3 + 5 = 9, leftover = 2 -> goes to id-a (rem 5) and id-b (rem 4)!
      const result = distributeAmountHamilton({
        amount: '0.11',
        targets: [
          { targetId: 'id-c', weight: '3', maxCeiling: '10.00' },
          { targetId: 'id-b', weight: '2', maxCeiling: '10.00' },
          { targetId: 'id-a', weight: '1', maxCeiling: '10.00' },
        ],
      });

      expect(result.allocations.map((a) => ({ id: a.targetId, cents: a.amountCents }))).toEqual([
        { id: 'id-a', cents: 2n },
        { id: 'id-b', cents: 4n },
        { id: 'id-c', cents: 5n },
      ]);
    });

    it('enforces target ceilings during iterative constrained water-filling without exceeding any cap', () => {
      const result = distributeAmountHamilton({
        amount: '80.00',
        targets: [
          { targetId: 'vo-a', weight: '90.00', maxCeiling: '40.00' },
          { targetId: 'vo-b', weight: '10.00', maxCeiling: '50.00' },
        ],
      });

      expect(result.allocatedCents).toBe(8000n);
      expect(result.allocations.map((a) => ({ id: a.targetId, amt: a.amount.toFixed(2) }))).toEqual([
        { id: 'vo-a', amt: '40.00' },
        { id: 'vo-b', amt: '40.00' },
      ]);
    });

    it('rejects excess over aggregate target ceiling by default and exposes explicit residual when opted in', () => {
      expect(() =>
        distributeAmountHamilton({
          amount: '50.00',
          targets: [{ targetId: 'vo-a', weight: '40.00', maxCeiling: '40.00' }],
        }),
      ).toThrow(BadRequestException);

      const capped = distributeAmountHamilton({
        amount: '50.00',
        targets: [{ targetId: 'vo-a', weight: '40.00', maxCeiling: '40.00' }],
        allowCeilingResidual: true,
      });

      expect(capped.allocatedCents).toBe(4000n);
      expect(capped.residualCents).toBe(1000n);
      expect(capped.residualAmount.toFixed(2)).toBe('10.00');
    });

    it('never shifts positive allocation onto a zero-weight target', () => {
      const result = distributeAmountHamilton({
        amount: '50.00',
        targets: [
          { targetId: 'vo-a', weight: '100', maxCeiling: '30.00' },
          { targetId: 'vo-b', weight: '0', maxCeiling: '50.00' },
        ],
        allowCeilingResidual: true,
      });

      expect(result.allocatedCents).toBe(3000n);
      expect(result.residualCents).toBe(2000n);
      expect(result.allocations.find((a) => a.targetId === 'vo-b')?.amountCents).toBe(0n);
    });
  });
});
