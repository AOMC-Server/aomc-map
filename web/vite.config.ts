import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

const backend = process.env.BACKEND_URL ?? "http://localhost:3000";

export default defineConfig({
	plugins: [preact()],
	server: {
		proxy: {
			"/api": backend,
			"/blobs": backend,
			"^/map/": backend,
			"/auth": backend,
			"/scalar": backend,
			// Files are downloaded from the server; folders (ending in /) are pages of the app.
			"/files": {
				target: backend,
				bypass: (req) => {
					const path = req.url?.split("?")[0] ?? "";
					return path === "/files" || path.endsWith("/")
						? "/index.html"
						: undefined;
				},
			},
		},
	},
});
