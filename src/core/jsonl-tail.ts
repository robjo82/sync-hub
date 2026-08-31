import { readFileSync, statSync } from 'node:fs';

/**
 * Reads a JSONL transcript, optionally skipping the first `fromOffset` **bytes**.
 *
 * The subtlety this exists for: the watcher records a file's size (bytes, from statSync) and
 * hands it back as the offset for the next read. Slicing a decoded string by that number is
 * wrong for any file that isn't pure ASCII — one accented character is two bytes but one string
 * index, so the slice lands too far into the file and silently drops everything in between.
 * Measured on the real corpus (Aug 2026): up to 194 564 characters skipped on a single 45MB
 * Claude Code session, and the drift grows with both file size and accent density. Slicing the
 * Buffer first, then decoding, keeps offsets and content in the same unit.
 *
 * Returns null when the file cannot be read at all.
 */
export function readJsonlFrom(filePath: string, fromOffset?: number): string | null {
  let buffer: Buffer;
  try {
    buffer = readFileSync(filePath);
  } catch {
    return null;
  }
  if (!fromOffset || fromOffset <= 0) return buffer.toString('utf-8');
  // An offset past the end means the file shrank since it was recorded (rotated, rewritten,
  // truncated): the offset no longer points at anything meaningful, so re-read the whole file
  // rather than returning nothing. Re-ingesting is free — insertMessage dedups by hash.
  if (fromOffset >= buffer.length) return buffer.toString('utf-8');
  return buffer.subarray(fromOffset).toString('utf-8');
}

/** Byte size of a file, or null if it cannot be stat'ed. */
export function fileSize(filePath: string): number | null {
  try {
    return statSync(filePath).size;
  } catch {
    return null;
  }
}
