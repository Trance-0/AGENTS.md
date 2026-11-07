import fs from "node:fs";
import path from "node:path";

// Commit parsed events and their cursor together. Re-reading after a crash or
// file replacement is safe because usage event IDs are unique in SQLite.
export function ingestUsage(directory, store) {
  const names = fs.readdirSync(directory).filter(name => /^usage-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
  let inserted = 0;
  for (const name of names) {
    const file = path.join(directory, name);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) continue;
      const previous = store.cursor(name);
      let offset = previous && previous.inode === String(stat.ino) && previous.offset <= stat.size ? previous.offset : 0;
      const buffer = Buffer.alloc(Math.min(stat.size - offset, 256 * 1024));
      const count = fs.readSync(fd, buffer, 0, buffer.length, offset);
      const end = buffer.subarray(0, count).lastIndexOf(10);
      if (end < 0 && count < 256 * 1024) continue;
      store.transaction(() => {
        if (end >= 0) {
          for (const line of buffer.subarray(0, end).toString("utf8").split("\n")) {
            let event;
            try { event = JSON.parse(line); } catch { continue; }
            if (store.ingest(event)) inserted++;
          }
          offset += end + 1;
        } else offset += count;
        store.setCursor(name, stat.ino, offset);
      });
    } finally { fs.closeSync(fd); }
  }
  return inserted;
}

export function watchUsage(directory, store, warn) {
  let failed = false;
  const tick = () => {
    try { ingestUsage(directory, store); failed = false; }
    catch {
      if (!failed) warn("Usage collection delayed: dashboard/metrics reader — shared usage logs could not be read or saved; retrying.");
      failed = true;
    }
  };
  tick();
  const timer = setInterval(tick, 2000); timer.unref();
  return () => clearInterval(timer);
}
