import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// /api -> carsem-api, /agent -> the agent service. Same origin for the browser.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:4021", changeOrigin: true, rewrite: path => path.replace(/^\/api/, "") },
      "/agent": { target: "http://localhost:4031", changeOrigin: true, rewrite: path => path.replace(/^\/agent/, "") },
    },
  },
});
