import { build } from "./server";
import { db } from "../../packages/database";
process.umask(0o077);
const app = await build();
await app.listen({ port: 3000, host: "0.0.0.0" });
for (const s of ["SIGTERM", "SIGINT"])
  process.once(s, async () => {
    await app.close();
    await db.$disconnect();
  });
