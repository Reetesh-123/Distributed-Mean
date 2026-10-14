import { promises as fs } from "fs";
import path from "path";
import { Response } from "express";
import { config } from "../config";

/**
 * Read access to the .npy files the workers write, so the raw numbers can be looked at in a browser.
 * The API only reads here. It never writes or computes results.
 */

interface NpyHeader {
  bytesPerValue: 4 | 8;
  length: number;
  dataStart: number;
}

const MAGIC = "\x93NUMPY";
const RECOMPUTE_FILE_LIMIT = 5000; // above this many files the cross-check would take too long
const PARALLEL_READS = 50;

const rawPath = (jobId: string, fileIndex: number): string =>
  path.join(config.dataDir, jobId, "raw", `${String(fileIndex).padStart(5, "0")}.npy`);

/** Parse the header of a 1-D float32 or float64 .npy file. */
async function readHeader(handle: fs.FileHandle): Promise<NpyHeader> {
  const start = Buffer.alloc(12);
  await handle.read(start, 0, 12, 0);
  if (start.toString("latin1", 0, 6) !== MAGIC) throw new Error("not a .npy file");
  const major = start[6];
  const headerLength = major === 1 ? start.readUInt16LE(8) : start.readUInt32LE(8);
  const headerStart = major === 1 ? 10 : 12;
  const text = Buffer.alloc(headerLength);
  await handle.read(text, 0, headerLength, headerStart);
  const header = text.toString("latin1");
  const dtype = /'descr':\s*'([^']+)'/.exec(header)?.[1];
  const length = Number(/'shape':\s*\((\d+),?\)/.exec(header)?.[1]);
  if ((dtype !== "<f4" && dtype !== "<f8") || !Number.isInteger(length)) throw new Error(`unsupported .npy header: ${header}`);
  return { bytesPerValue: dtype === "<f4" ? 4 : 8, length, dataStart: headerStart + headerLength };
}

/** Read `count` values starting at `offset` from an open .npy file. */
async function readValues(handle: fs.FileHandle, header: NpyHeader, offset: number, count: number): Promise<number[]> {
  const n = Math.max(0, Math.min(count, header.length - offset));
  const buffer = Buffer.alloc(n * header.bytesPerValue);
  await handle.read(buffer, 0, buffer.length, header.dataStart + offset * header.bytesPerValue);
  return Array.from({ length: n }, (_, i) =>
    header.bytesPerValue === 4 ? buffer.readFloatLE(i * 4) : buffer.readDoubleLE(i * 8),
  );
}

/** First `count` values of a file, or null if the file does not exist. */
async function readHead(file: string, count: number): Promise<number[] | null> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, "r");
  } catch {
    return null;
  }
  try {
    return await readValues(handle, await readHeader(handle), 0, count);
  } finally {
    await handle.close();
  }
}

export interface RawPreview {
  files: number[]; // file indexes shown as columns
  rows: { position: number; values: (number | null)[]; recomputed: number | null; result: number | null }[];
}

/**
 * A small table: the first `positions` numbers of the first `shownFiles` raw files, next to the mean
 * recomputed from ALL raw files (the same check as tools/show_job.py) and the mean the system produced.
 */
export async function previewJob(
  job: { id: string; f: number; result_path: string | null },
  positions: number,
  shownFiles: number,
): Promise<RawPreview> {
  const files = Array.from({ length: Math.min(shownFiles, job.f) }, (_, i) => i);
  const columns = await Promise.all(files.map((index) => readHead(rawPath(job.id, index), positions)));

  let recomputed: number[] | null = null;
  if (job.f <= RECOMPUTE_FILE_LIMIT) {
    const sums = new Array<number>(positions).fill(0);
    let missing = false;
    for (let first = 0; first < job.f && !missing; first += PARALLEL_READS) {
      const batch = Array.from({ length: Math.min(PARALLEL_READS, job.f - first) }, (_, i) => first + i);
      for (const values of await Promise.all(batch.map((index) => readHead(rawPath(job.id, index), positions)))) {
        if (!values) { missing = true; break; }
        values.forEach((value, i) => { sums[i] += value; });
      }
    }
    if (!missing) recomputed = sums.map((sum) => sum / job.f);
  }

  const result = job.result_path ? await readHead(path.join(config.dataDir, job.id, "result.npy"), positions) : null;
  const shown = Math.max(0, ...columns.map((column) => column?.length ?? 0));
  const rows = Array.from({ length: shown }, (_, position) => ({
    position,
    values: columns.map((column) => column?.[position] ?? null),
    recomputed: recomputed?.[position] ?? null,
    result: result?.[position] ?? null,
  }));
  return { files, rows };
}

/** Stream one raw file as CSV (one value per line, line 1 = position 0). Returns false if the file does not exist. */
export async function streamRawFileAsCsv(jobId: string, fileIndex: number, res: Response): Promise<boolean> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(rawPath(jobId, fileIndex), "r");
  } catch {
    return false;
  }
  try {
    const header = await readHeader(handle);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="raw-${jobId.slice(0, 8)}-${fileIndex}.csv"`);
    const chunk = 65536;
    for (let offset = 0; offset < header.length; offset += chunk) {
      const values = await readValues(handle, header, offset, chunk);
      const ok = res.write(values.map((value) => value.toFixed(10)).join("\n") + "\n");
      if (!ok) await new Promise((resolve) => res.once("drain", resolve));
    }
    res.end();
  } finally {
    await handle.close();
  }
  return true;
}
