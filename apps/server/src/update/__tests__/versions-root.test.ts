import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { loadBootstrapConfig } from "../../config/loader.js";
import { DEFAULT_DATA_DIR, resolveDataDir, resolveVersionsRoot } from "../versions-root.js";

/**
 * `boot.mjs` 要在**加载服务端之前**知道版本目录在哪,那时候 `loadBootstrapConfig`
 * 还没跑。于是有了一份只解 `dataDir` 的最小重实现 —— 而两份实现就意味着会漂。
 *
 * 漂开的症状最难查:服务端把新版本装进 A 目录,boot 去 B 目录找,**两边都不报错**,
 * 用户看到的是「更新装好了,重启后还是旧版本」。
 *
 * 所以下面这组用例不自己复述优先级,而是拿**真的 `loadBootstrapConfig`** 跑同一组
 * 输入,断言两边算出来的 dataDir 一样。loader 那头改了优先级,这里会红。
 */

const created: string[] = [];

afterEach(() => {
	for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempCwd(): string {
	const dir = mkdtempSync(join(tmpdir(), "bn-versions-root-"));
	created.push(dir);
	return dir;
}

/** 同一组输入喂给两边,dataDir 必须一致。 */
function expectAgreement(input: { argv: string[]; env: NodeJS.ProcessEnv; cwd: string }): string {
	const fromLoader = loadBootstrapConfig({ ...input, log: () => {} }).dataDir;
	const fromBoot = resolveDataDir(input);

	// loader 那头允许相对路径原样留着,boot 这边一律 resolve —— 比较前对齐,
	// 比的是「指向同一个目录」而不是「字符串长得一样」。
	expect(resolve(input.cwd, fromBoot)).toBe(resolve(input.cwd, fromLoader));
	return fromBoot;
}

describe("resolveDataDir 与 loadBootstrapConfig 必须算出同一个 dataDir", () => {
	it("CLI 给了 --data-dir", () => {
		const cwd = tempCwd();
		expectAgreement({
			argv: ["--data-dir", join(cwd, "d")],
			env: { BN_CONFIG_DISABLED: "1" },
			cwd,
		});
	});

	it("CLI 用 --data-dir=… 的写法", () => {
		const cwd = tempCwd();
		expectAgreement({
			argv: [`--data-dir=${join(cwd, "d")}`],
			env: { BN_CONFIG_DISABLED: "1" },
			cwd,
		});
	});

	it("B 模型:yaml 里写了 dataDir,env 里写的是另一个 —— 文件赢", () => {
		// 这一条是最容易漂的:B 模型的规矩是「文件即真相,env 只在首启动 seed 过」。
		// boot 那边要是按 env 优先,用户改过 yaml 的 dataDir 之后就会两边分家。
		const cwd = tempCwd();
		const cfg = join(cwd, "bn.config.yaml");
		mkdirSync(join(cwd, "from-file"), { recursive: true });
		writeFileSync(cfg, `dataDir: ${join(cwd, "from-file")}\nlogLevel: silent\n`, "utf8");

		const dir = expectAgreement({
			argv: [],
			env: { BN_CONFIG: cfg, BN_DATA_DIR: join(cwd, "from-env") },
			cwd,
		});

		expect(dir).toBe(join(cwd, "from-file"));
	});

	it("B 模型:CLI 仍然压得过文件", () => {
		const cwd = tempCwd();
		const cfg = join(cwd, "bn.config.yaml");
		writeFileSync(cfg, `dataDir: ${join(cwd, "from-file")}\nlogLevel: silent\n`, "utf8");

		const dir = expectAgreement({
			argv: ["--data-dir", join(cwd, "from-cli")],
			env: { BN_CONFIG: cfg },
			cwd,
		});

		expect(dir).toBe(join(cwd, "from-cli"));
	});

	it("什么都没配 → 两边的默认值也得是同一个目录", () => {
		// 这是两份实现唯一真会分歧的一档,而这组守卫以前从没用它跑过:boot 侧回落 /data,
		// loader 侧回落 ./data(相对 cwd)。Docker / 桌面今天都显式给了 dataDir 所以没露馅,
		// 但谁在 compose 里删掉 BN_DATA_DIR,就是「装到 A 目录、boot 去 B 目录找」。
		const cwd = tempCwd();
		expectAgreement({ argv: [], env: {}, cwd });
	});

	it("B 模型:yaml 里没写 dataDir → 两边回落到同一个目录", () => {
		const cwd = tempCwd();
		const cfg = join(cwd, "bn.config.yaml");
		writeFileSync(cfg, "logLevel: silent\n", "utf8");
		expectAgreement({ argv: [], env: { BN_CONFIG: cfg }, cwd });
	});

	it("BN_CONFIG_DISABLED(桌面壳 / sidecar)→ 只看 CLI 与 env", () => {
		// 桌面版就走这条:外壳用 `--data-dir` 把用户数据目录传进来。boot 要是只认
		// BN_DATA_DIR,它会去 /data 找版本目录 —— 那在桌面上根本不存在。
		const cwd = tempCwd();
		expectAgreement({
			argv: [],
			env: { BN_CONFIG_DISABLED: "1", BN_DATA_DIR: join(cwd, "from-env") },
			cwd,
		});
	});
});

describe("resolveVersionsRoot", () => {
	it("就是 dataDir 底下的 versions/", () => {
		const cwd = tempCwd();
		expect(resolveVersionsRoot({ argv: ["--data-dir", "/srv/bn"], env: {}, cwd })).toBe(
			join("/srv/bn", "versions"),
		);
	});

	it("什么都没给 → 相对 cwd 的 ./data(和 loader 同一个默认,不再各写各的)", () => {
		const cwd = tempCwd();
		expect(resolveVersionsRoot({ argv: [], env: {}, cwd })).toBe(
			resolve(cwd, DEFAULT_DATA_DIR, "versions"),
		);
	});

	it("配置文件读不出来时不抛 —— 启动最早期,坏一个文件不该让进程起不来", () => {
		const cwd = tempCwd();
		const cfg = join(cwd, "bn.config.yaml");
		writeFileSync(cfg, "{{{ 这不是 yaml", "utf8");

		expect(() => resolveVersionsRoot({ argv: [], env: { BN_CONFIG: cfg }, cwd })).not.toThrow();
	});
});
