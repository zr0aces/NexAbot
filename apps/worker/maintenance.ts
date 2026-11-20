import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { db } from "../../packages/database";
import { settings } from "../../packages/shared/config";
import {
  dirs,
  pathFor,
  clearUsageCache,
} from "../../packages/image-processing";
export async function cleanup(now = Date.now()) {
  const s = settings(
    (await db.owner.findUnique({ where: { id: 1 } }))?.settings,
  );
  const rows = await db.image.findMany({
    where: {
      uploadStatus: "SYNCED",
      googleMediaItemId: { not: null },
      stagingPath: { not: null },
      uploadedAt: { lt: new Date(now - s.stagingHours * 3600000) },
    },
    take: 200,
  });
  for (const i of rows) {
    await rm(pathFor(i.id), { force: true });
    await db.image.update({ where: { id: i.id }, data: { stagingPath: null } });
  }
  for (const dir of dirs) {
    for (const f of await readdir(dir)) {
      const part = f.endsWith(".part"),
        thumb = dir === dirs[1] && f.endsWith(".webp");
      if (!part && !thumb) continue;
      const p = join(dir, f);
      const m = await stat(p).catch(() => null);
      if (m && m.mtimeMs < now - (part ? 1 : s.thumbnailDays) * 86400000)
        await rm(p, { force: true });
    }
  }
  await db.webhookEvent.deleteMany({
    where: { receivedAt: { lt: new Date(now - 90 * 86400000) } },
  });
  clearUsageCache();
}
