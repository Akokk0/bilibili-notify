import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { bootSelectedPayload } from "../boot.js";

/**
 * 进程最早期决定跑哪一份载荷,然后**在同一个进程里**把它加载起来。
 *
 * 不 spawn 子进程:那要多养一个常驻 node(小机器上几十 MB 是真的),还要转发信号、
 * 处理孤儿。同进程 `import()` 之后,那份载荷里的 `import.meta.url` 指的就是它自己
 * 的目录 —— dashboard 资源和版本号因此自动跟着走(见 config/web-dist.ts)。
 *
 * 代价是**镜像里这段启动代码是冻住的**:它必须能启动任何未来版本的载荷。所以
 * 「载荷导出 startStandaloneServer」是一条向前兼容契约,而不是内部约定 —— 下面
 * 那条「缺导出就回落」的用例守的就是它。
 */

const created: string[] = [];

afterEach(() => {
	for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scaffold(...versions: string[]) {
	const root = mkdtempSync(join(tmpdir(), "bn-boot-payload-"));
	created.push(root);
	const versionsRoot = join(root, "versions");
	mkdirSync(versionsRoot, { recursive: true });
	for (const v of versions) mkdirSync(join(versionsRoot, v), { recursive: true });
	return { root, versionsRoot, imagePath: join(root, "app") };
}

function deps(over: {
	versionsRoot: string;
	imagePath: string;
	imageVersion?: string;
	loadPayload?: (entry: string) => Promise<unknown>;
}) {
	return {
		imageVersion: over.imageVersion ?? "0.8.0",
		imagePath: over.imagePath,
		versionsRoot: over.versionsRoot,
		maxBootFailures: 3,
		log: () => {},
		loadPayload:
			over.loadPayload ?? (async () => ({ startStandaloneServer: async () => ({ url: "x" }) })),
	};
}

describe("bootSelectedPayload", () => {
	it("有更新的载荷 → 加载载荷目录里那个 index.mjs,不是镜像那个", async () => {
		const { versionsRoot, imagePath } = scaffold("0.9.0");
		const loadPayload = vi.fn(async () => ({ startStandaloneServer: async () => ({}) }));

		const result = await bootSelectedPayload(deps({ versionsRoot, imagePath, loadPayload }));

		expect(result).toMatchObject({ version: "0.9.0", isImageVersion: false });
		expect(loadPayload).toHaveBeenCalledWith(join(versionsRoot, "0.9.0", "index.mjs"));
	});

	it("起来了就销账 —— 少了这一步,偶发的一次起不来会把好版本判死", async () => {
		const { versionsRoot, imagePath } = scaffold("0.9.0");

		await bootSelectedPayload(deps({ versionsRoot, imagePath }));

		const state = JSON.parse(readFileSync(join(versionsRoot, "boot-state.json"), "utf8"));
		expect(state.attempts["0.9.0"]).toBeUndefined();
	});

	it("没有更新的载荷 → 走镜像自带那份", async () => {
		const { versionsRoot, imagePath } = scaffold();
		const loadPayload = vi.fn(async () => ({ startStandaloneServer: async () => ({}) }));

		const result = await bootSelectedPayload(deps({ versionsRoot, imagePath, loadPayload }));

		expect(result).toMatchObject({ version: "0.8.0", isImageVersion: true });
		expect(loadPayload).toHaveBeenCalledWith(join(imagePath, "index.mjs"));
	});

	it("载荷加载时炸了 → 回落镜像那份,别把用户关在门外", async () => {
		const { versionsRoot, imagePath } = scaffold("0.9.0");
		const loadPayload = vi.fn(async (entry: string) => {
			if (entry.includes("0.9.0")) throw new Error("载荷是坏的");
			return { startStandaloneServer: async () => ({}) };
		});

		const result = await bootSelectedPayload(deps({ versionsRoot, imagePath, loadPayload }));

		expect(result).toMatchObject({ version: "0.8.0", isImageVersion: true });
	});

	it("回落之后不给坏载荷销账 —— 它得继续累加直到被判死", async () => {
		const { versionsRoot, imagePath } = scaffold("0.9.0");
		const loadPayload = async (entry: string) => {
			if (entry.includes("0.9.0")) throw new Error("载荷是坏的");
			return { startStandaloneServer: async () => ({}) };
		};

		await bootSelectedPayload(deps({ versionsRoot, imagePath, loadPayload }));

		// 销了账的话,每次启动都是「选中 → 记 1 → 炸 → 销账」,计数永远回到零,
		// 那个坏版本会被无限重试下去 —— 自愈等于没有。
		const state = JSON.parse(readFileSync(join(versionsRoot, "boot-state.json"), "utf8"));
		expect(state.attempts["0.9.0"]).toBe(1);
	});

	it("载荷没导出 startStandaloneServer → 当它起不来,回落", async () => {
		// 镜像里这段代码是冻住的,它得能启动**未来**的载荷。哪天有人把这个导出改名,
		// 老镜像上的用户就会拿到一个「更新完打不开」的实例。宁可回落。
		const { versionsRoot, imagePath } = scaffold("0.9.0");
		const loadPayload = async (entry: string) =>
			entry.includes("0.9.0") ? { somethingElse: 1 } : { startStandaloneServer: async () => ({}) };

		const result = await bootSelectedPayload(deps({ versionsRoot, imagePath, loadPayload }));

		expect(result).toMatchObject({ version: "0.8.0", isImageVersion: true });
	});

	it("镜像那份也起不来 → 抛出去,别静默退出 0", async () => {
		// 静默退 0 的容器会被编排系统当作「正常结束」,不重启、不报警,用户只看到
		// 服务没了而日志里什么都没有。
		const { versionsRoot, imagePath } = scaffold();
		const loadPayload = async () => {
			throw new Error("镜像也是坏的");
		};

		await expect(
			bootSelectedPayload(deps({ versionsRoot, imagePath, loadPayload })),
		).rejects.toThrow(/镜像也是坏的/);
	});

	it("把镜像的版本与位置经 env 交给载荷 —— 它得知道能退到哪一层地板", async () => {
		// 载荷只知道自己在哪。「退一步」要退到哪一版、镜像那份在哪个目录,只有这里
		// 知道。走 env 而不是加函数参数:那个导出是**冻在镜像里**的向前兼容契约,
		// 加参数等于要求所有未来载荷跟着改签名。
		const { versionsRoot, imagePath } = scaffold("0.9.0");
		const env: NodeJS.ProcessEnv = {};
		let seen: NodeJS.ProcessEnv | null = null;
		const loadPayload = async () => ({
			startStandaloneServer: async () => {
				seen = { ...env };
				return {};
			},
		});

		await bootSelectedPayload({ ...deps({ versionsRoot, imagePath, loadPayload }), env });

		// 必须在载荷**启动之前**就摆好 —— 它构建升级服务的时候就要读。
		expect(seen).toMatchObject({ BN_IMAGE_VERSION: "0.8.0", BN_IMAGE_PATH: imagePath });
	});

	it("载荷起不来的原因会被记进日志 —— 否则用户只看到『版本没变』", async () => {
		const { versionsRoot, imagePath } = scaffold("0.9.0");
		const logged: string[] = [];
		const loadPayload = async (entry: string) => {
			if (entry.includes("0.9.0")) throw new Error("缺个文件");
			return { startStandaloneServer: async () => ({}) };
		};

		await bootSelectedPayload({
			...deps({ versionsRoot, imagePath, loadPayload }),
			log: (m: string) => logged.push(m),
		});

		expect(logged.join("\n")).toContain("0.9.0");
		expect(logged.join("\n")).toContain("缺个文件");
	});
});
