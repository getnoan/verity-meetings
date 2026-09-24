/** A write the database refused because it would double-book a host
 *  (the exclusion constraint) or reuse a token. The caller answers
 *  "that time was just taken"; it is never retried as-is. */
export class StoreConflict extends Error {
  constructor(message) { super(message); this.name = "StoreConflict"; }
}
