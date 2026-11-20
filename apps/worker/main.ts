import { dispatch } from "./dispatch";
import { Worker, Queue } from "bullmq";
import { Redis } from "ioredis";
import pino from "pino";
import { env } from "../../packages/shared/config";
import { db } from "../../packages/database";
import { initDirs } from "../../packages/image-processing";
import { processEvent } from "./process";
import { cleanup } from "./maintenance";
process.umask(0o077);
await initDirs();
const logger = pino(),
  redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const connection = { url: env.REDIS_URL };
const q = new Queue("line-images", { connection });
await q.setGlobalConcurrency(1);
const w = new Worker("line-images", (job) => processEvent(job.id!), {
  connection,
  concurrency: 1,
});
w.on("error", (e) => logger.error({ type: e.name }, "Worker connection error"));
w.on("failed", (job) =>
  logger.warn({ job: job?.id }, "Worker interrupted; outbox will replay"),
);
let busy = false,
  lastClean = 0;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const now = new Date();
    await dispatch(q, now);
    await redis.set("worker:heartbeat", now.toISOString(), "EX", 90);
    if (+now - lastClean >= 60000) {
      await cleanup();
      lastClean = +now;
    }
  } catch (e) {
    logger.error({ type: (e as Error).name }, "Dispatcher or cleanup failed");
  } finally {
    busy = false;
  }
}
await tick();
const timer = setInterval(tick, 1000);
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, async () => {
    clearInterval(timer);
    await w.close();
    await q.close();
    await redis.quit();
    await db.$disconnect();
    process.exit(0);
  });
