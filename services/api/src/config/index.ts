/** Runtime configuration, read once from environment variables (see docker-compose.yml). */

const numberFromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : Number(raw);
};

const requiredFromEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
};

export const config = {
  databaseUrl: requiredFromEnv("DATABASE_URL"),
  rabbitmqUrl: requiredFromEnv("RABBITMQ_URL"),
  dataDir: process.env.DATA_DIR ?? "/data", // shared folder where workers read and write the .npy / .csv files
  httpPort: numberFromEnv("PORT", 3000),
  maxTaskInputs: numberFromEnv("MAX_FAN_IN", 5), // a task never has more inputs than this (the "5 files per worker" rule)
  schedulerTickMs: numberFromEnv("TICK_MS", 500), // how often the scheduler re-plans jobs and checks worker health
  maxTaskAttempts: numberFromEnv("MAX_ATTEMPTS", 3), // after this many failed attempts the job fails
  workerHeartbeatTimeoutMs: numberFromEnv("WORKER_DEAD_MS", 10_000), // no heartbeat for this long means the worker is dead
  backupFactor: numberFromEnv("BACKUP_FACTOR", 2), // a task gets a backup copy after running this many times the median
};
