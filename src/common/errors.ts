/**
 * Readable error text for logs. Connection errors (e.g. ECONNREFUSED) often arrive in Node
 * as an AggregateError with an empty message; in that case we fall back to the error code.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message || (err as NodeJS.ErrnoException).code || err.name;
  }
  return String(err);
}
