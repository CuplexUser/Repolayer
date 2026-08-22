// Runs the conformance suite against one or more real engines.
//
//   node scripts/test-db.mjs postgres
//   node scripts/test-db.mjs postgres mysql mariadb
//
// Starts the docker compose service for each engine, waits for its healthcheck, then runs
// vitest once with the matching TEST_*_URL variables set. Those variables are what un-skip
// each half of the suite, so a missing one means that engine was silently not tested.
//
// Exists as a script rather than a shell one-liner so it behaves the same on Windows,
// macOS, and Linux without cross-env or shell-specific env syntax.
import { spawn, spawnSync } from 'node:child_process';

const ENGINES = {
  postgres: {
    service: 'postgres',
    env: 'TEST_DATABASE_URL',
    url: 'postgres://repolayer:repolayer@127.0.0.1:54329/repolayer',
  },
  mysql: {
    service: 'mysql',
    env: 'TEST_MYSQL_URL',
    url: 'mysql://repolayer:repolayer@127.0.0.1:33069/repolayer',
  },
  mariadb: {
    service: 'mariadb',
    env: 'TEST_MARIADB_URL',
    url: 'mysql://repolayer:repolayer@127.0.0.1:33070/repolayer',
  },
};

const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
const passthrough = process.argv.slice(2).filter((arg) => arg.startsWith('-'));

if (requested.length === 0) {
  console.error(`Usage: node scripts/test-db.mjs <${Object.keys(ENGINES).join('|')}> ...`);
  process.exit(2);
}

const unknown = requested.filter((name) => !(name in ENGINES));
if (unknown.length > 0) {
  console.error(
    `Unknown engine ${unknown.join(', ')}. Known engines: ${Object.keys(ENGINES).join(', ')}.`,
  );
  process.exit(2);
}

const chosen = requested.map((name) => ENGINES[name]);
// An engine already reachable through its env var needs no container. That is how this
// works against a server someone else is hosting.
const needContainers = chosen.filter((engine) => !process.env[engine.env]);

if (needContainers.length > 0) {
  const docker = spawnSync('docker', ['--version'], { stdio: 'ignore', shell: true });
  if (docker.status !== 0) {
    console.error(
      [
        'Docker is not available, so the database containers cannot be started.',
        '',
        'Either install Docker Desktop, or point the suite at a server you already have:',
        ...needContainers.map((engine) => `  ${engine.env}=<url>`),
        '',
        'Without those variables the affected suites skip with a message rather than fail.',
      ].join('\n'),
    );
    process.exit(1);
  }

  const services = needContainers.map((engine) => engine.service);
  console.log(`Starting: ${services.join(', ')}`);
  const up = spawnSync('docker', ['compose', 'up', '-d', '--wait', ...services], {
    stdio: 'inherit',
    shell: true,
  });
  if (up.status !== 0) process.exit(up.status ?? 1);
}

const env = { ...process.env };
for (const engine of chosen) env[engine.env] ??= engine.url;

const child = spawn(
  process.execPath,
  [new URL('../node_modules/vitest/vitest.mjs', import.meta.url).pathname, 'run', ...passthrough],
  { stdio: 'inherit', env },
);

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
