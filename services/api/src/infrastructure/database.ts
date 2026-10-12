import { Pool, PoolClient } from "pg";
import { config } from "../config";

export const pool = new Pool({ connectionString: config.databaseUrl });

/** Anything that can run a query: the pool, or a client inside a transaction. */
export type Queryable = Pick<PoolClient, "query">;

/** Run `work` in one transaction: commit if it resolves, roll back if it throws. */
export async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
