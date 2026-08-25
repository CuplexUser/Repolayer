import type { Dialect } from './dialect.js';
import type { FieldDef, FieldMap, FieldType, Schema } from './schema.js';

/**
 * Reading a live table back and comparing it against the schema descriptor.
 *
 * `ensureTable()` creates a table and stops there: it never alters one, and on its own it
 * cannot tell you that the table your migration tool produced is not the table your code
 * thinks it is querying. This is the other half of that story, and it is deliberately
 * read-only. It executes no DDL, proposes no `ALTER`, and keeps no version table. repolayer
 * is still not a migration engine; it can now just tell you when you need one.
 *
 * The comparison is a pure function over a normalized `TableShape`, so every adapter's job
 * reduces to reading its own catalog, and the whole matrix of types, dialects, and findings
 * is unit-testable with no database anywhere.
 */

/** One column as the engine's catalog reports it. */
export interface LiveColumn {
  column: string;
  /** The engine's own type name, lowercased. Deliberately not a `FieldType`. */
  dataType: string;
  nullable: boolean;
  primaryKey: boolean;
  /** Whether the column carries a DDL default, which decides if an unknown column is fatal. */
  hasDefault: boolean;
  /** MySQL and MariaDB only; undefined elsewhere. */
  collation?: string;
}

/** Engine-independent description of a live table, produced by each adapter. */
export interface TableShape {
  exists: boolean;
  columns: LiveColumn[];
  /** Columns carrying a single-column unique constraint or index, primary key excluded. */
  uniqueColumns: string[];
}

export type FindingKind =
  | 'missingTable'
  | 'missingColumn'
  | 'extraRequiredColumn'
  | 'typeIncompatible'
  | 'typeUnknown'
  | 'nullabilityMismatch'
  | 'primaryKeyMismatch'
  | 'missingUnique'
  | 'extraUnique'
  | 'collationMismatch';

export interface TableFinding {
  kind: FindingKind;
  /**
   * `error` means this will break at runtime, or already is breaking silently.
   * `warning` means repolayer noticed something it has no opinion on.
   */
  severity: 'error' | 'warning';
  /** Schema field name, where the finding is about a field repolayer knows. */
  field?: string;
  column: string;
  expected?: string;
  actual?: string;
  message: string;
}

export interface TableDiff {
  table: string;
  /** True when nothing at `error` severity was found. Warnings do not clear it. */
  ok: boolean;
  findings: TableFinding[];
}

/**
 * What each `FieldType` may be stored as, per dialect.
 *
 * The inverse of the three type switches in `ddl.ts`, widened past what repolayer itself
 * emits, because the whole point is to check a table somebody else's migration tool made.
 * A type in neither list is reported as `typeUnknown` rather than assumed wrong: repolayer
 * genuinely does not know whether an exotic column will round trip.
 */
interface TypeRules {
  ok: string[];
  bad: string[];
}

const POSTGRES_TYPES: Record<FieldType, TypeRules> = {
  string: { ok: ['text', 'character varying', 'character'], bad: [] },
  number: { ok: ['double precision', 'real', 'numeric'], bad: [] },
  integer: { ok: ['bigint', 'integer', 'smallint'], bad: [] },
  // `toDb` sends a JS boolean, and Postgres will not implicitly cast one to a number.
  boolean: { ok: ['boolean'], bad: ['smallint', 'integer', 'bigint'] },
  date: {
    ok: ['timestamp with time zone'],
    // A zoneless column reads back as a local-time Date, shifting every instant silently.
    bad: ['timestamp without time zone', 'date', 'text', 'character varying'],
  },
  json: {
    ok: ['jsonb', 'json'],
    // `fromDb` returns a Postgres json value untouched, because the driver has already
    // parsed it. A text column is parsed by nobody, so the field yields a raw string.
    bad: ['text', 'character varying'],
  },
};

const MYSQL_TYPES: Record<FieldType, TypeRules> = {
  string: { ok: ['varchar', 'char', 'text', 'tinytext', 'mediumtext', 'longtext'], bad: [] },
  // mysql2 is configured with `decimalNumbers: false`, so a DECIMAL arrives as a string.
  number: { ok: ['double', 'float'], bad: ['decimal', 'newdecimal'] },
  integer: { ok: ['bigint', 'int', 'mediumint', 'smallint', 'tinyint'], bad: [] },
  boolean: { ok: ['tinyint'], bad: ['bit'] },
  date: {
    ok: ['datetime'],
    // TIMESTAMP converts both ways using the session time zone and tops out in 2038.
    // DATE throws the clock away entirely.
    bad: ['timestamp', 'date', 'varchar', 'char', 'text'],
  },
  json: {
    ok: ['longtext', 'mediumtext', 'text', 'varchar'],
    // Native JSON normalizes the document it stores, so `eq` against the exact text
    // `toDb` produced stops matching. This is why `ddl.ts` emits LONGTEXT instead.
    bad: ['json'],
  },
};

/** Expected SQLite affinity per field type. SQLite has five, and repolayer uses three. */
const SQLITE_AFFINITY: Record<FieldType, string[]> = {
  string: ['text'],
  number: ['real', 'numeric'],
  integer: ['integer'],
  boolean: ['integer'],
  date: ['text'],
  json: ['text'],
};

/**
 * SQLite's documented rules for turning a declared type into an affinity.
 *
 * Comparing declared type names would be wrong here in a way it is not on the other
 * engines: SQLite accepts any text at all as a type, and `VARCHAR(80)`, `CLOB`, and `TEXT`
 * all describe the same column. Affinity is the thing that actually decides behavior.
 */
function sqliteAffinity(declared: string): string {
  const type = declared.toUpperCase();
  if (type.includes('INT')) return 'integer';
  if (type.includes('CHAR') || type.includes('CLOB') || type.includes('TEXT')) return 'text';
  if (type === '' || type.includes('BLOB')) return 'blob';
  if (type.includes('REAL') || type.includes('FLOA') || type.includes('DOUB')) return 'real';
  return 'numeric';
}

/**
 * Coerces one value out of an engine's catalog into text.
 *
 * Catalog rows arrive as `unknown`, and the drivers are not consistent about what they hand
 * back: a MySQL information_schema column can be a Buffer rather than a string depending on
 * the connection charset. Anything that is not usable text becomes an empty string, which
 * matches no type name, rather than "[object Object]", which would look like one.
 *
 * Not re-exported from the package barrel, but adapters outside this repo can import it:
 * writing `readTableShape` means reading a catalog, and every catalog has this problem.
 */
export function catalogText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return '';
}

/** Collation every string column repolayer creates on MySQL carries. Mirrors `ddl.ts`. */
const MYSQL_TEXT_COLLATION = 'utf8mb4_bin';

type Verdict = 'ok' | 'incompatible' | 'unknown';

function checkType(type: FieldType, dataType: string, dialect: Dialect): Verdict {
  if (dialect === 'sqlite') {
    const affinity = sqliteAffinity(dataType);
    return SQLITE_AFFINITY[type].includes(affinity) ? 'ok' : 'incompatible';
  }

  const rules = dialect === 'postgres' ? POSTGRES_TYPES[type] : MYSQL_TYPES[type];
  if (rules.ok.includes(dataType)) return 'ok';
  if (rules.bad.includes(dataType)) return 'incompatible';
  return 'unknown';
}

function expectedType(type: FieldType, dialect: Dialect): string {
  if (dialect === 'sqlite') return `${SQLITE_AFFINITY[type][0] as string} affinity`;
  const rules = dialect === 'postgres' ? POSTGRES_TYPES[type] : MYSQL_TYPES[type];
  return rules.ok.join(' or ');
}

/**
 * Compares a live table against the schema that is supposed to describe it.
 *
 * Pure, and takes the shape rather than a connection, so the adapters share one definition
 * of what counts as drift instead of each deciding for itself.
 *
 * Two things it deliberately does not check. Column defaults, because every engine
 * normalizes a default expression differently and `ddl.ts` already writes them per dialect,
 * so comparing them would produce noise on a correct table. And extra columns in general:
 * `selectList()` names every column it reads, so an unknown column is invisible to a read.
 * The one exception is an unknown column that is NOT NULL with no default, which makes
 * every insert fail, because `create()` builds its column list from the schema alone.
 */
export function diffTable(
  schema: Schema,
  table: string,
  shape: TableShape,
  dialect: Dialect,
): TableDiff {
  const findings: TableFinding[] = [];

  if (!shape.exists) {
    return {
      table,
      ok: false,
      findings: [
        {
          kind: 'missingTable',
          severity: 'error',
          column: '',
          message:
            `Table "${table}" does not exist. Create it with your migration tool, or call ` +
            `ensureTable() in development.`,
        },
      ],
    };
  }

  // Matched case insensitively on every engine. Postgres folds unquoted identifiers to
  // lowercase and repolayer never quotes them, so a `createdAt` field is a `createdat`
  // column there; MySQL and SQLite treat column names case insensitively anyway.
  const live = new Map<string, LiveColumn>();
  for (const column of shape.columns) live.set(column.column.toLowerCase(), column);
  const unique = new Set(shape.uniqueColumns.map((column) => column.toLowerCase()));

  const fields = schema.fields as FieldMap;
  const claimed = new Set<string>();

  for (const field of schema.fieldNames) {
    const def = fields[field] as FieldDef;
    const column = schema.columns[field] as string;
    const key = column.toLowerCase();
    claimed.add(key);

    const actual = live.get(key);
    if (actual === undefined) {
      findings.push({
        kind: 'missingColumn',
        severity: 'error',
        field,
        column,
        message:
          `Field "${field}" expects column "${column}", which the table does not have. ` +
          `Every read names its columns explicitly, so this fails on the next query.`,
      });
      continue;
    }

    const verdict = checkType(def.type, actual.dataType, dialect);
    if (verdict !== 'ok') {
      findings.push({
        kind: verdict === 'incompatible' ? 'typeIncompatible' : 'typeUnknown',
        severity: verdict === 'incompatible' ? 'error' : 'warning',
        field,
        column,
        expected: expectedType(def.type, dialect),
        actual: actual.dataType,
        message:
          verdict === 'incompatible'
            ? `Field "${field}" is declared ${def.type}, but column "${column}" is ` +
              `${actual.dataType}, which will not round trip. Expected ` +
              `${expectedType(def.type, dialect)}.`
            : `Field "${field}" is declared ${def.type} and column "${column}" is ` +
              `${actual.dataType}, which repolayer has no opinion on. Verify it round trips.`,
      });
    }

    const isPrimaryKey = field === schema.primaryKey;

    // Nullability is not compared on the primary key. `defineSchema` already refuses a
    // nullable one, so the schema side is a constant, and the live side is not: SQLite
    // lets a non-INTEGER PRIMARY KEY column hold NULL, a legacy quirk it keeps for
    // compatibility, so `id TEXT PRIMARY KEY` reports as nullable there and nowhere else.
    // Comparing would flag every SQLite table repolayer itself generated. That the column
    // is the primary key at all is what matters, and `primaryKeyMismatch` below checks it.
    const shouldBeNullable = def.nullable === true;
    if (!isPrimaryKey && actual.nullable !== shouldBeNullable) {
      findings.push({
        kind: 'nullabilityMismatch',
        severity: 'error',
        field,
        column,
        expected: shouldBeNullable ? 'nullable' : 'not null',
        actual: actual.nullable ? 'nullable' : 'not null',
        message: shouldBeNullable
          ? `Field "${field}" is nullable but column "${column}" is NOT NULL, so writing ` +
            `null to it will fail.`
          : `Field "${field}" is not nullable but column "${column}" allows null, so a ` +
            `read can hand back null where the inferred type says it cannot.`,
      });
    }

    if (actual.primaryKey !== isPrimaryKey) {
      findings.push({
        kind: 'primaryKeyMismatch',
        severity: 'error',
        field,
        column,
        expected: isPrimaryKey ? 'primary key' : 'not the primary key',
        actual: actual.primaryKey ? 'primary key' : 'not the primary key',
        message: isPrimaryKey
          ? `Field "${field}" is the schema's primary key, but column "${column}" is not ` +
            `the table's. findById, update, delete, and keyset paging all key on it.`
          : `Column "${column}" is the table's primary key, but the schema's is ` +
            `"${schema.primaryKey}".`,
      });
    }

    if (def.unique === true && !isPrimaryKey && !unique.has(key)) {
      findings.push({
        kind: 'missingUnique',
        severity: 'error',
        field,
        column,
        message:
          `Field "${field}" is declared unique but column "${column}" carries no unique ` +
          `constraint, so duplicates will be accepted instead of raising ` +
          `UniqueConstraintError.`,
      });
    }

    if (def.unique !== true && !isPrimaryKey && unique.has(key)) {
      findings.push({
        kind: 'extraUnique',
        severity: 'warning',
        field,
        column,
        message:
          `Column "${column}" carries a unique constraint the schema does not declare, so ` +
          `writes can fail with UniqueConstraintError where the schema suggests they cannot.`,
      });
    }

    // The one check that catches a bug nothing else would. `ddl.ts` creates string columns
    // utf8mb4_bin on purpose, because the MySQL default is case insensitive and would
    // change what eq, in, unique, and ORDER BY mean on this engine and no other.
    if (
      dialect === 'mysql' &&
      def.type === 'string' &&
      actual.collation !== undefined &&
      actual.collation !== MYSQL_TEXT_COLLATION
    ) {
      findings.push({
        kind: 'collationMismatch',
        severity: 'error',
        field,
        column,
        expected: MYSQL_TEXT_COLLATION,
        actual: actual.collation,
        message:
          `Column "${column}" is ${actual.collation}, not ${MYSQL_TEXT_COLLATION}. A case ` +
          `insensitive collation silently changes eq, in, unique, and ORDER BY on this ` +
          `engine only, which is the divergence repolayer exists to prevent.`,
      });
    }
  }

  for (const column of shape.columns) {
    if (claimed.has(column.column.toLowerCase())) continue;
    if (column.nullable || column.hasDefault) continue;
    findings.push({
      kind: 'extraRequiredColumn',
      severity: 'error',
      column: column.column,
      message:
        `Column "${column.column}" is NOT NULL with no default and is not in the schema. ` +
        `Inserts build their column list from the schema, so every create() will fail.`,
    });
  }

  return { table, ok: !findings.some((f) => f.severity === 'error'), findings };
}
