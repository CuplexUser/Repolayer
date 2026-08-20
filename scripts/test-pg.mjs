// Runs the full suite with TEST_DATABASE_URL pointed at the docker-compose Postgres.
// Exists so `npm run test:pg` works identically on Windows, macOS, and Linux without
// needing cross-env or shell-specific env syntax.
import { spawn } from 'node:child_process';

const url =
  process.env.TEST_DATABASE_URL ??
  'postgres://repolayer:repolayer@127.0.0.1:54329/repolayer';

const child = spawn(
  process.execPath,
  [new URL('../node_modules/vitest/vitest.mjs', import.meta.url).pathname, 'run', ...process.argv.slice(2)],
  { stdio: 'inherit', env: { ...process.env, TEST_DATABASE_URL: url } },
);

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
