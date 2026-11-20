import { db } from "../../packages/database";
import { envelope, relevant } from "../../packages/line-client";
import { pressured } from "../../packages/image-processing";
import { Fault } from "../../packages/shared/model";
export async function ingest(raw: unknown) {
  const payload = envelope.parse(raw);
  for (const e of payload.events.filter(relevant)) {
    const id = e.source!.groupId!,
      date = new Date(e.timestamp);
    await db.$transaction(async (tx) => {
      const seen = await tx.webhookEvent.createMany({
        data: {
          webhookEventId: e.webhookEventId,
          eventType: e.type,
          processingStatus: "PROCESSED",
          processedAt: new Date(),
        },
        skipDuplicates: true,
      });
      if (!seen.count) return;
      await tx.lineGroup.createMany({
        data: {
          lineGroupId: id,
          lastEventAt: date,
          membershipAt: date,
          membershipStatus: e.type === "leave" ? "LEFT" : "JOINED",
        },
        skipDuplicates: true,
      });
      await tx.$queryRaw`SELECT id FROM "LineGroup" WHERE "lineGroupId"=${id} FOR UPDATE`;
      await tx.lineGroup.updateMany({
        where: { lineGroupId: id, lastEventAt: { lt: date } },
        data: { lastEventAt: date },
      });
      if (e.type !== "message") {
        await tx.lineGroup.updateMany({
          where: { lineGroupId: id, membershipAt: { lte: date } },
          data: {
            membershipStatus: e.type === "leave" ? "LEFT" : "JOINED",
            membershipAt: date,
            ...(e.type === "leave" ? { enabled: false } : {}),
          },
        });
        if (e.type === "join")
          await tx.outboxEvent.create({
            data: { eventType: "GROUP_SUMMARY", aggregateId: id },
          });
        return;
      }
      const g = await tx.lineGroup.findUniqueOrThrow({
        where: { lineGroupId: id },
      });
      if (
        !g.enabled ||
        g.membershipStatus !== "JOINED" ||
        date < g.membershipAt ||
        (g.enabledSince && date < g.enabledSince)
      )
        return;
      const imageId = crypto.randomUUID();
      const created = await tx.image.createMany({
        data: {
          id: imageId,
          lineGroupId: id,
          lineMessageId: e.message!.id,
          channelId: payload.destination,
          lineEventTimestamp: date,
        },
        skipDuplicates: true,
      });
      if (!created.count) return;
      if (await pressured())
        throw new Fault(
          "DISK_PRESSURE",
          "Ingestion paused: staging disk reserve reached.",
          true,
        );
      await tx.outboxEvent.create({
        data: { eventType: "PROCESS", aggregateId: imageId },
      });
    });
  }
}
