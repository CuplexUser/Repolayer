/**
 * Every adapter maps its driver's native failures onto these, so application code can
 * branch on the error type without knowing which engine is underneath.
 */
export class RepoError extends Error {
  override readonly name: string = 'RepoError';
  override readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** Thrown by `update` and `delete` when no row matches the given id. */
export class NotFoundError extends RepoError {
  override readonly name = 'NotFoundError';

  constructor(
    readonly table: string,
    readonly id: unknown,
  ) {
    super(`No row in "${table}" with id ${JSON.stringify(id)}`);
  }
}

/**
 * A unique constraint (or primary key) rejected the write. `fields` names the offending
 * schema fields where the driver tells us which they were; it may be empty otherwise.
 */
export class UniqueConstraintError extends RepoError {
  override readonly name = 'UniqueConstraintError';

  constructor(
    readonly table: string,
    readonly fields: string[],
    options?: { cause?: unknown },
  ) {
    super(
      fields.length > 0
        ? `Unique constraint violated on "${table}" (${fields.join(', ')})`
        : `Unique constraint violated on "${table}"`,
      options,
    );
  }
}

/**
 * The query could not be compiled: an unknown field, a bad operator, a malformed value.
 * Always thrown before any SQL reaches the database.
 */
export class QueryError extends RepoError {
  override readonly name = 'QueryError';
}

/** The adapter could not open, borrow, or use a connection. */
export class ConnectionError extends RepoError {
  override readonly name = 'ConnectionError';
}

/** The schema descriptor itself is invalid. Thrown by `defineSchema`. */
export class SchemaError extends RepoError {
  override readonly name = 'SchemaError';
}
