/**
 * express-mysql-session ships no types. Only the shape we actually use is
 * declared, rather than pulling in a hand-written full definition that would
 * drift from the library.
 */
declare module 'express-mysql-session' {
  import type { Store } from 'express-session';

  interface MySQLStoreOptions {
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    createDatabaseTable?: boolean;
    clearExpired?: boolean;
    checkExpirationInterval?: number;
    expiration?: number;
    schema?: {
      tableName?: string;
      columnNames?: { session_id?: string; expires?: string; data?: string };
    };
  }

  type MySQLStoreClass = new (
    options: MySQLStoreOptions,
    connection?: unknown,
    uri?: string,
  ) => Store;

  export default function MySQLStoreFactory(session: unknown): MySQLStoreClass;
}
