import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Empty prefix ("" instead of the default "VITE_") so a plain PORT in
  // .env is picked up too, not just VITE_-prefixed vars — see below.
  const env = loadEnv(mode, process.cwd(), "");
  // server/worker.js reads process.env.PORT directly (default 25100). This
  // used to be hardcoded here, so changing PORT silently broke dev with a
  // confusing "API not responding" instead of actually following it.
  const apiPort = env.PORT || "25100";

  return {
    plugins: [react()],
    server: {
      host: true, // listen on the local network, not just localhost
      proxy: {
        "/api": `http://localhost:${apiPort}`,
      },
    },
  };
});
