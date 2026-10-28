import SqliteDatabase from "../sqlite.js";

/** A direct CLI reader owns one read-only connection, without a retained transaction. */
export async function withCliReadOnlyDatabase<T>(filename: string, read: (db: SqliteDatabase) => T | Promise<T>): Promise<T> {
  const db = new SqliteDatabase(filename, { readonly: true, fileMustExist: true, timeout: 5000 });
  try {
    db.pragma("query_only = ON");
    return await read(db);
  } finally {
    db.close();
  }
}
