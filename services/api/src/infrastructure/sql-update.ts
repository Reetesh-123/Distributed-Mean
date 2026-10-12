import { Queryable } from "./database";

/**
 * Run `UPDATE <table> SET col = value, ... WHERE id = <id>`. Columns in `nowColumns` are set to now().
 * Table and column names are written in our own code (never taken from a request), so they are safe to put in the SQL.
 * The values always go through query parameters.
 */
export async function updateById(
  db: Queryable,
  table: "jobs" | "tasks",
  id: string,
  values: Record<string, unknown>,
  nowColumns: string[] = [],
): Promise<void> {
  const columns = Object.keys(values);
  const assignments = [
    ...columns.map((column, index) => `${column} = $${index + 2}`), // $1 is the id
    ...nowColumns.map((column) => `${column} = now()`),
  ];
  await db.query(`UPDATE ${table} SET ${assignments.join(", ")} WHERE id = $1`, [id, ...columns.map((c) => values[c])]);
}
