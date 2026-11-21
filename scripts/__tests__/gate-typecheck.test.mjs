import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vite-plus/test";

const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
const root = JSON.parse(read("package.json"));
const web = JSON.parse(read("apps/web/package.json"));
const { parse } = createRequire(new URL("../../apps/server/package.json", import.meta.url))("yaml");

it("独立类型检查覆盖面板；构建成功后的检查覆盖其余全部工作区包", () => {
	expect(root.scripts.typecheck).toBe("pnpm -r run typecheck");
	expect(web.scripts.build).toMatch(/^tsc -b &&/);
	expect(JSON.parse(read("apps/web/tsconfig.json")).compilerOptions.noEmit).toBe(true);
	expect(web.scripts.typecheck).toBe("tsc --noEmit");
	const filter = root.scripts["typecheck:after-build"]?.match(
		/^pnpm -r --filter "([^"]+)" run typecheck$/,
	)?.[1];
	expect(filter).toBeDefined();
	const list = (...args) =>
		JSON.parse(
			execFileSync("vp", ["exec", "pnpm", "-r", ...args, "list", "--depth", "-1", "--json"], {
				encoding: "utf8",
			}),
		)
			.map((pkg) => pkg.name)
			.filter((name) => name !== root.name)
			.sort();
	expect(list("--filter", filter)).toEqual(list().filter((name) => name !== web.name));
	const gate = parse(read(".github/workflows/gate.yml"));
	expect(gate.jobs.test.steps.find((step) => step.name === "Typecheck").run).toBe(
		"vpr typecheck:after-build",
	);
	expect(read(".claude/gate.sh")).toMatch(/vp run build\nvp run typecheck:after-build/);
});
