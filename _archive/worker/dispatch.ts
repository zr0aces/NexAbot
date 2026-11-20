import type { Queue } from "bullmq";
import { db } from "../../packages/database";
export async function dispatch(q: Queue, now = new Date()) {
  const rows = await db.outboxEvent.findMany({
    where: {
      availableAt: { lte: now },
      OR: [
        { publishedAt: null },
        { publishedAt: { lt: new Date(+now - 60000) } },
      ],
    },
    orderBy: { availableAt: "asc" },
    take: 100,
  });
  for (const e of rows) {
    if (e.publishedAt) {
      const existing = await q.getJob(e.id);
      if (
        existing &&
        ((await existing.isActive()) ||
          (await existing.isWaiting()) ||
          (await existing.isDelayed()))
      ) {
        await db.outboxEvent.updateMany({
          where: { id: e.id },
          data: { publishedAt: now },
        });
        continue;
      }
    }
    await q.add(
      e.eventType,
      {},
      {
        jobId: e.id,
        priority: e.eventType === "PROCESS" ? 1 : 2,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    await db.outboxEvent.updateMany({
      where: { id: e.id },
      data: { publishedAt: now },
    });
  }
}
