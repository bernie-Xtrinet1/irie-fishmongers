// Single source of truth for whether the timer-driven @Cron scheduler
// (ScheduleModule.forRoot) is registered. Enabled unless ENABLE_SCHEDULER is
// explicitly the string 'false' - so absence => enabled and dev/prod need no
// extra config. The e2e suite sets ENABLE_SCHEDULER=false (via its jest
// setup) so wall-clock cron ticks can't fire mid-run and race a suite's
// teardown. Deliberately its own flag rather than derived from NODE_ENV, so
// scheduling can be toggled independently of the environment (e.g. a
// scheduler-only test run, or disabling crons on a read-replica instance).
export function isSchedulerEnabled(): boolean {
  return process.env.ENABLE_SCHEDULER !== 'false';
}
