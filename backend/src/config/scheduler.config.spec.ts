import { isSchedulerEnabled } from './scheduler.config';

describe('isSchedulerEnabled', () => {
  const original = process.env.ENABLE_SCHEDULER;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.ENABLE_SCHEDULER;
    } else {
      process.env.ENABLE_SCHEDULER = original;
    }
  });

  it('is enabled by default when the flag is absent', () => {
    delete process.env.ENABLE_SCHEDULER;
    expect(isSchedulerEnabled()).toBe(true);
  });

  it('is enabled when the flag is "true"', () => {
    process.env.ENABLE_SCHEDULER = 'true';
    expect(isSchedulerEnabled()).toBe(true);
  });

  it('is disabled only when the flag is exactly "false"', () => {
    process.env.ENABLE_SCHEDULER = 'false';
    expect(isSchedulerEnabled()).toBe(false);
  });

  it('treats any other value as enabled', () => {
    process.env.ENABLE_SCHEDULER = 'off';
    expect(isSchedulerEnabled()).toBe(true);
  });
});
