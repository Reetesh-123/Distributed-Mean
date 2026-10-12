/**
 * SQL condition: the worker's heartbeat is recent. Bind $1 to config.workerHeartbeatTimeoutMs.
 * A worker without a recent heartbeat counts as dead, whatever its stored status says.
 */
export const heartbeatIsFresh = (lastSeenColumn = "last_seen"): string =>
  `${lastSeenColumn} > now() - ($1 || ' milliseconds')::interval`;
