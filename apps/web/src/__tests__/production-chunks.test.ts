import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";

it("keeps every production JavaScript chunk within Vite's 500 kB warning limit", () => {
	const output = mkdtempSync(join(tmpdir(), "bn-web-chunks-"));
	try {
		execFileSync("vp", ["build", "--outDir", output, "--emptyOutDir"], {
			cwd: fileURLToPath(new URL("../../", import.meta.url)),
			env: { ...process.env, NODE_ENV: "production", BN_RUNTIME_PROFILE: "production" },
		});
		const assets = join(output, "assets");
		const chunks = readdirSync(assets).filter((name) => name.endsWith(".js"));
		expect(chunks.length).toBeGreaterThan(0);
		const oversized = chunks
			.map((name) => ({ name, bytes: statSync(join(assets, name)).size }))
			.filter(({ bytes }) => bytes > 500_000);
		expect(oversized).toEqual([]);
	} finally {
		rmSync(output, { recursive: true, force: true });
	}
}, 60_000);
