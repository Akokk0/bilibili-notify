import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vite-plus/test";

const { parse } = createRequire(new URL("../../apps/server/package.json", import.meta.url))("yaml");
const gate = parse(
	await readFile(new URL("../../.github/workflows/gate.yml", import.meta.url), "utf8"),
);

it("全仓 Biome 检查只在第 1 个测试分片执行一次", () => {
	const lint = Object.entries(gate.jobs).flatMap(([job, { steps }]) =>
		steps
			.filter((step) => step.run === "vp exec biome ci .")
			.map((step) => ({ job, when: step.if })),
	);
	expect(lint).toEqual([{ job: "test", when: "matrix.shard == 1" }]);
});

it("四个测试分片拿到同一次构建的库、面板、拓展和可执行的工具", async () => {
	const { build, test } = gate.jobs;
	expect(build?.steps.some((step) => step.run === "vpr build")).toBe(true);
	expect(test.strategy.matrix.shard).toEqual([1, 2, 3, 4]);
	expect(test.needs).toContain("build");
	expect(test.steps.some((step) => step.run === "vpr build")).toBe(false);
	const upload = build.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
	const download = test.steps.find((step) => step.uses?.startsWith("actions/download-artifact@"));
	expect(download.with.name).toBe(upload.with.name);
	expect(upload.with["if-no-files-found"]).toBe("error");
	const dir = await mkdtemp(join(tmpdir(), "bn-gate-build-"));
	try {
		const source = join(dir, "source");
		const target = join(dir, "target");
		await mkdir(target);
		const outputs = [
			"apps/contract/lib/index.d.mts",
			"apps/server/lib/index.mjs",
			"apps/web/dist/assets/index.js",
			"extensions/bridge/dist/index.mjs",
			"packages/image/lib/index.mjs",
			"tools/create-extension/lib/templates/project/.github/workflows/check.yml.tmpl",
			"tools/bn-cli/lib/cli.mjs",
		];
		for (const path of outputs) {
			await mkdir(dirname(join(source, path)), { recursive: true });
			await writeFile(join(source, path), path, { mode: 0o755 });
		}
		const env = { ...process.env, RUNNER_TEMP: dir };
		execFileSync(
			"bash",
			["-ec", build.steps.find((step) => step.name === "Archive workspace build").run],
			{ cwd: source, env },
		);
		execFileSync(
			"bash",
			["-ec", test.steps.find((step) => step.name === "Restore workspace build").run],
			{ cwd: target, env },
		);
		for (const path of outputs) expect(await readFile(join(target, path), "utf8")).toBe(path);
		expect((await stat(join(target, "tools/bn-cli/lib/cli.mjs"))).mode & 0o111).toBe(0o111);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
