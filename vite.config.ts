import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
	plugins: [
		preact(),
		tailwindcss(),
		VitePWA({
			registerType: "autoUpdate",
			includeAssets: [
				"icon-192.png",
				"icon-512.png",
				"fonts/roboto-flex.woff2",
			],
			manifest: {
				name: "Gifsky",
				short_name: "Gifsky",
				description: "Offline GIF encoder powered by gifski WebAssembly.",
				theme_color: "#0c1030",
				background_color: "#0c1030",
				display: "standalone",
				orientation: "portrait",
				start_url: "/",
				scope: "/",
				icons: [
					{
						src: "/icon-192.png",
						sizes: "192x192",
						type: "image/png",
						purpose: "any maskable",
					},
					{
						src: "/icon-512.png",
						sizes: "512x512",
						type: "image/png",
						purpose: "any maskable",
					},
				],
			},
			workbox: {
				globPatterns: ["**/*.{js,css,html,svg,png,wasm,woff2}"],
				maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
			},
		}),
	],
	optimizeDeps: {
		exclude: ["gifski-wasm"],
	},
	worker: {
		format: "es",
	},
});
