/** Request validation helpers. Limits come from the assignment: 1 < F < 100000 and 1 < C < 1000000. */

export const MAX_FILES = 100_000;
export const MAX_NUMBERS_PER_FILE = 1_000_000;
export const MAX_WORKERS = 32;

export const isInteger = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

/** Returns an error message, or null if F and C are valid. */
export function validateJobSize(fileCount: unknown, numbersPerFile: unknown): string | null {
  if (!isInteger(fileCount) || fileCount <= 1 || fileCount >= MAX_FILES) {
    return `F must be an integer with 1 < F < ${MAX_FILES}`;
  }
  if (!isInteger(numbersPerFile) || numbersPerFile <= 1 || numbersPerFile >= MAX_NUMBERS_PER_FILE) {
    return `C must be an integer with 1 < C < ${MAX_NUMBERS_PER_FILE}`;
  }
  return null;
}
