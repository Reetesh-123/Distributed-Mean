import { ItemRef } from "../domain/messages";
import { WaitingItem } from "../domain/rows";
import { Queryable } from "../infrastructure/database";

/** The job's waiting items (state READY), oldest first. */
export async function findWaitingItems(db: Queryable, jobId: string): Promise<WaitingItem[]> {
  const { rows } = await db.query<WaitingItem>(
    `SELECT id, path, count FROM items WHERE job_id = $1 AND state = 'READY' ORDER BY created_at, id`,
    [jobId],
  );
  return rows;
}

/** Add a new waiting item. A path that already exists is ignored. Returns true if a row was added. */
export async function insertItem(db: Queryable, jobId: string, producedByTaskId: string, item: ItemRef): Promise<boolean> {
  const result = await db.query(
    `INSERT INTO items (job_id, path, count, produced_by) VALUES ($1, $2, $3, $4) ON CONFLICT (path) DO NOTHING`,
    [jobId, item.path, item.count, producedByTaskId],
  );
  return result.rowCount === 1;
}

/** Mark items as taken by a combine task, so no other task can use them. */
export async function markItemsUsed(db: Queryable, itemIds: string[], usedByTaskId: string): Promise<void> {
  await db.query(`UPDATE items SET state = 'USED', used_by = $2 WHERE id = ANY($1::uuid[])`, [itemIds, usedByTaskId]);
}
