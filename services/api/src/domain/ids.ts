const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** First 8 characters of an id, enough to recognise it in logs and in the UI. */
export const shortId = (id: string): string => id.slice(0, 8);

/** True only for ids shaped like 8-4-4-4-12 hex digits. Postgres rejects anything else with an error. */
export const isUuid = (value: unknown): value is string => typeof value === "string" && UUID_PATTERN.test(value);
