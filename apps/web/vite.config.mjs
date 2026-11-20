import { defineConfig } from "vite";
import tailwind from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { readVersion } from "../../scripts/version-control.mjs";

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(readVersion(fileURLToPath(new URL("../../", import.meta.url)))),
  },
  plugins: [tailwind()],
  server: { proxy: { "/api": "http://localhost:3000" } },
});
