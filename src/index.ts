import { loadConfig } from './config.ts';
import { openDatabase } from './db.ts';
import { createApp } from './http/server.ts';
import { createScheduler } from './monitor/scheduler.ts';
import { PLANS } from './plans.ts';

function main(): void {
  const config = loadConfig();
  const db = openDatabase(config.databasePath);
  const scheduler = createScheduler(db, config);
  const server = createApp({ db, config, scheduler });

  server.listen(config.port, () => {
    console.log(`Driftwatch listening on ${config.baseUrl} (port ${config.port})`);
    console.log(
      `  database:  ${config.databasePath}\n` +
        `  email:     ${config.email.provider}\n` +
        `  billing:   ${config.stripe.enabled ? 'stripe enabled' : 'disabled (everyone on Free)'}\n` +
        `  plans:     ${Object.values(PLANS)
          .map((plan) => `${plan.name} $${plan.priceUsd}`)
          .join(', ')}`,
    );
    if (config.devLogin) {
      console.log('  ⚠ DRIFTWATCH_DEV_LOGIN is on: sign-in links are shown in the browser.');
    }
    if (config.probe.allowPrivateTargets) {
      console.log(
        '  ⚠ PROBE_ALLOW_PRIVATE_TARGETS is on: monitors may target private addresses.\n' +
          '    Safe only if every account on this instance is yours.',
      );
    }
  });

  if (config.scheduler.enabled) scheduler.start();

  const shutdown = (signal: string) => {
    console.log(`\n${signal} received, shutting down.`);
    scheduler.stop();
    server.close(() => {
      // WAL checkpoint happens on close, so this must run before exit.
      db.close();
      process.exit(0);
    });
    // Don't hang forever on a stuck keep-alive connection.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
  });
}

main();
