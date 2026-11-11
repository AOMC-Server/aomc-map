import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

const backend = process.env.BACKEND_URL ?? "http://localhost:3000";

export default defineConfig({
	plugins: [preact()],
	server: {
		proxy: {
			"/api": backend,
			"/blobs": backend,
			"/auth": backend,
			"/scalar": backend,
		},
	},
});
