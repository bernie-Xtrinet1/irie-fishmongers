import {
  CheckoutRecoveryLockService,
  CheckoutRecoveryLease,
} from './checkout-recovery-lock.service';
import { CheckoutRecoveryWorkerService } from './checkout-recovery-worker.service';
import { CheckoutRecoverySchedulerService } from './checkout-recovery-scheduler.service';
import { CheckoutRecoveryTelemetryService } from './checkout-recovery-telemetry.service';

describe('Checkout recovery scheduler', () => {
  const lease = { assertHeld: jest.fn() };
  let lock: { runExclusive: jest.Mock };
  let worker: { runCycle: jest.Mock };
  let telemetry: { record: jest.Mock };
  let scheduler: CheckoutRecoverySchedulerService;
  beforeEach(() => {
    lock = {
      runExclusive: jest
        .fn()
        .mockImplementation(async (work: (value: CheckoutRecoveryLease) => Promise<void>) => {
          await work(lease);
          return true;
        }),
    };
    worker = { runCycle: jest.fn().mockResolvedValue(undefined) };
    telemetry = { record: jest.fn() };
    scheduler = new CheckoutRecoverySchedulerService(
      lock as unknown as CheckoutRecoveryLockService,
      worker as unknown as CheckoutRecoveryWorkerService,
      telemetry as unknown as CheckoutRecoveryTelemetryService,
    );
  });
  it('runs protected work and emits ownership', async () => {
    await scheduler.runScheduledBatch();
    expect(worker.runCycle).toHaveBeenCalledWith(lease);
    expect(telemetry.record).toHaveBeenCalledWith('scheduler_lock_acquired', 'OWNED');
  });
  it('treats lock contention as successful skip', async () => {
    lock.runExclusive.mockResolvedValue(false);
    await expect(scheduler.runScheduledBatch()).resolves.toBeUndefined();
    expect(worker.runCycle).not.toHaveBeenCalled();
    expect(telemetry.record).toHaveBeenCalledWith('scheduler_lock_skipped', 'CONTENDED');
  });
  it('isolates cycle failure and permits a later tick', async () => {
    worker.runCycle.mockRejectedValueOnce(new Error('secret failure'));
    await scheduler.runScheduledBatch();
    await scheduler.runScheduledBatch();
    expect(worker.runCycle).toHaveBeenCalledTimes(2);
    expect(telemetry.record).toHaveBeenCalledWith('checkout_recovery_failed', 'CYCLE_FAILURE');
  });
  it('uses local overlap only as an optimization in addition to distributed locking', async () => {
    let finish!: () => void;
    worker.runCycle.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const first = scheduler.runScheduledBatch();
    await scheduler.runScheduledBatch();
    finish();
    await first;
    expect(lock.runExclusive).toHaveBeenCalledTimes(1);
    expect(telemetry.record).toHaveBeenCalledWith('scheduler_lock_skipped', 'LOCAL_OVERLAP');
  });
});
