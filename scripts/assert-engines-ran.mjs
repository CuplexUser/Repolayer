// Fails the build when a conformance suite skipped itself instead of running.
//
//   node scripts/assert-engines-ran.mjs report.json test/postgres.test.ts test/mysql.test.ts
//
// Each engine's suite skips with a message when its TEST_*_URL is absent, which is right
// locally and wrong in CI: a silent skip there quietly reduces "passing" to SQLite only,
// which is exactly the failure this package's whole claim depends on not happening.
//
// Reads the JSON report from the single `vitest run` the workflow already does, so proving
// the engines ran costs nothing beyond parsing a file.
import { readFileSync } from 'node:fs';

const [reportPath, ...required] = process.argv.slice(2);

if (!reportPath || required.length === 0) {
  console.error('Usage: node scripts/assert-engines-ran.mjs <report.json> <test-file>...');
  process.exit(2);
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const failures = [];

for (const file of required) {
  // The report holds absolute paths; match on the suffix so this works on any checkout.
  const normalized = file.replaceAll('\\', '/');
  const result = report.testResults?.find((entry) =>
    entry.name.replaceAll('\\', '/').endsWith(normalized),
  );

  if (!result) {
    failures.push(`${file}: not present in the report at all`);
    continue;
  }

  const assertions = result.assertionResults ?? [];
  const passed = assertions.filter((a) => a.status === 'passed').length;
  const skipped = assertions.filter((a) => a.status === 'skipped' || a.status === 'pending').length;

  if (passed === 0) {
    failures.push(
      `${file}: ${skipped} skipped, 0 passed. Its TEST_*_URL is probably missing, so this ` +
        `engine was never actually exercised.`,
    );
  } else {
    console.log(`${file}: ${passed} passed`);
  }
}

if (failures.length > 0) {
  console.error('\nConformance coverage is not what it looks like:\n');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log('\nEvery required engine ran its conformance suite.');
