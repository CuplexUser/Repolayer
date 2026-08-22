import { runMysqlConformance } from './mysql-conformance.js';

await runMysqlConformance('mysql', 'TEST_MYSQL_URL', process.env['TEST_MYSQL_URL']);
