import { runMysqlConformance } from './mysql-conformance.js';

// MariaDB runs the same adapter and the same suite as MySQL. If the two ever diverge, this
// is the file that says so.
await runMysqlConformance('mariadb', 'TEST_MARIADB_URL', process.env['TEST_MARIADB_URL']);
