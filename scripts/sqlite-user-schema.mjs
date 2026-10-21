/**
 * The schema objects a database copy must recreate, grouped in creation order.
 *
 * Shadow tables (an FTS5 table's `_config`, `_data`, ...) are excluded: SQLite
 * creates them with their virtual table and reserves their names, so copying
 * them by name fails. The virtual table itself is copied through its columns.
 */
export function userSchema(db, schema = "main") {
  const rows = db.prepare(
    `SELECT objects.type, objects.name, objects.tbl_name, objects.sql
       FROM ${schema}.sqlite_master objects
       LEFT JOIN pragma_table_list listed ON listed.schema = ? AND listed.name = objects.name
      WHERE objects.sql IS NOT NULL AND objects.name NOT LIKE 'sqlite_%'
        AND listed.type IS NOT 'shadow'
      ORDER BY CASE objects.type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, objects.name`,
  ).all(schema);
  return {
    tables: rows.filter((row) => row.type === "table"),
    indexes: rows.filter((row) => row.type === "index"),
    views: rows.filter((row) => row.type === "view"),
    triggers: rows.filter((row) => row.type === "trigger"),
  };
}
