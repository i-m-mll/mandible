#!/usr/bin/env bun
import { dlopen, read } from "bun:ffi";
import fs from "node:fs";

type EvictionResult = { ok: true; bytes: number } | { ok: false; error: Error };

/** Invalidate a file's OS cache on macOS without reading or modifying its bytes. */
export function evictFileCache(path: string): EvictionResult {
  try {
    if (process.platform !== "darwin") throw new Error("File-cache eviction requires macOS libSystem");
    const fd = fs.openSync(path, "r");
    try {
      const bytes = fs.fstatSync(fd).size;
      if (bytes === 0) return { ok: true, bytes };
      const library = dlopen("/usr/lib/libSystem.B.dylib", {
        mmap: { args: ["ptr", "usize", "i32", "i32", "i32", "i64"], returns: "i64" },
        msync: { args: ["ptr", "usize", "i32"], returns: "i32" },
        munmap: { args: ["ptr", "usize"], returns: "i32" },
        __error: { args: [], returns: "ptr" },
      });
      try {
        const { mmap, msync, munmap, __error } = library.symbols;
        const failure = (operation: string) => new Error(`${operation} ${path}: errno ${read.i32(__error()!)}`);
        const PROT_READ = 1;
        const MAP_SHARED = 1;
        const MS_INVALIDATE = 2;
        const mapped = mmap(null, bytes, PROT_READ, MAP_SHARED, fd, 0n);
        if (mapped === -1n) throw failure("mmap");
        const address = Number(mapped);
        try {
          if (msync(address, bytes, MS_INVALIDATE) !== 0) throw failure("msync(MS_INVALIDATE)");
        } finally {
          if (munmap(address, bytes) !== 0) throw failure("munmap");
        }
        return { ok: true, bytes };
      } finally {
        library.close();
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

if (import.meta.main) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error("Usage: bun scripts/evict-file-cache.ts <file> [file ...]");
    process.exit(2);
  }
  for (const path of paths) {
    const result = evictFileCache(path);
    if (!result.ok) {
      console.error(result.error.message);
      process.exit(1);
    }
    console.log(`Invalidated ${result.bytes} bytes: ${path}`);
  }
}
