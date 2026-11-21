import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";

function assertChunkSizes(output: string) {
	const assets = join(output, "assets");
	const chunks = readdirSync(assets).filter((name) => name.endsWith(".js"));
	expect(chunks.length).toBeGreaterThan(0);
	const oversized = chunks
		.map((name) => ({ name, bytes: statSync(join(assets, name)).size }))
		.filter(({ bytes }) => bytes > 500_000);
	expect(oversized).toEqual([]);
}

it("keeps every production JavaScript chunk within Vite's 500 kB warning limit", () => {
	if (process.env.BN_GATE_WEB_DIST) return assertChunkSizes(process.env.BN_GATE_WEB_DIST);
	const output = mkdtempSync(join(tmpdir(), "bn-web-chunks-"));
	try {
		execFileSync("vp", ["build", "--outDir", output, "--emptyOutDir"], {
			cwd: fileURLToPath(new URL("../../", import.meta.url)),
			env: { ...process.env, NODE_ENV: "production", BN_RUNTIME_PROFILE: "production" },
		});
		assertChunkSizes(output);
	} finally {
		rmSync(output, { recursive: true, force: true });
	}
}, 60_000);

it("rejects missing or oversized JavaScript from the supplied gate build", () => {
	const output = mkdtempSync(join(tmpdir(), "bn-web-chunk-limit-"));
	try {
		const assets = join(output, "assets");
		mkdirSync(assets);
		expect(() => assertChunkSizes(output)).toThrow();
		const chunk = join(assets, "entry.js");
		writeFileSync(chunk, "");
		truncateSync(chunk, 500_000);
		assertChunkSizes(output);
		truncateSync(chunk, 500_001);
		expect(() => assertChunkSizes(output)).toThrow(/entry\.js/);
	} finally {
		rmSync(output, { recursive: true, force: true });
	}
});
