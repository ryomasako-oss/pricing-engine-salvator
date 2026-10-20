/* The app's own Vite config on ports of its own, so a browser test never
   attaches to someone else's dev server on 5173/8787. */

import { mergeConfig } from "vite";
import base from "../vite.config";

const api = process.env.E2E_API_PORT ?? "8797";

export default mergeConfig(base, {
  server: {
    port: Number(process.env.E2E_WEB_PORT ?? "5183"),
    strictPort: true,
    proxy: { "/api": { target: `http://localhost:${api}`, changeOrigin: true } },
  },
});
