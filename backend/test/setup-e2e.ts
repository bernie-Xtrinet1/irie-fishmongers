// e2e runs bootstrap the full AppModule for several minutes against a shared
// Postgres. Disable the timer-driven @Cron scheduler so no wall-clock tick
// (notably the every-5-min SLA-breach sweep) fires during a run and races a
// suite's afterAll teardown, which caused nondeterministic Prisma P2025
// ("No record was found for an update") failures attributed to whatever
// unrelated suite happened to be mid-run.
//
// Set here in setupFiles so it lands before any test file imports AppModule
// (whose @Module decorator reads the flag at import time). Cron logic stays
// covered by the services' own unit specs, which invoke the handlers
// directly rather than via the timer.
process.env.ENABLE_SCHEDULER = 'false';
