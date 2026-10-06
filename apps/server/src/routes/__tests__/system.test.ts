/**
 * `/api/system` —— 重启一下;开机之后要告诉主人的事(⑧);主人要求开新代(全新开始 / 从旧代重新迁移)。
 *
 * 这一层的实质逻辑只有两条,而两条都是「用户会以为功能坏了」的地方:
 * ① **先回话再关自己**(照 `/api/system/update/apply`):顺序反了,浏览器只看得到一个网络错误,
 *    然后他会去按第二次、第三次 —— 每一次都真的重启了一遍。
 * ② **拉不起来的环境上,POST 也得拦**:按钮藏起来 ≠ 没人发这个请求(旧标签页、curl),
 *    而这一发的后果是把 BN 关了、没人拉。拦下来回 `unsupported`(这台机器不支持重启)。
 *
 * 开新代是「写下标记 + 重启」,两条照样适用;另加:拒绝时标记一个字都不写(不然下次不知道哪一回开机就开了一代),
 * 要求从第 0 代迁而第 0 代已经不在了,当场说清。
 */

import type {
	ClearableStorageCategory,
	GenerationDeleteResponse,
	GenerationInfo,
	GenerationSourceKind,
	GenerationsResponse,
	ImageSweepResponse,
	RestartAbility,
	RestartResponse,
	StorageClearResponse,
	StorageUsageResponse,
	SystemNotice,
	SystemNoticesResponse,
} from "@bilibili-notify/contract";
import { describe, expect, it, vi } from "vite-plus/test";
import type { GenerationRemoval } from "../../runtime/generation-usage.js";
import { type CreateSystemRouteInput, createSystemRoute } from "../system.js";

const STARTED = "2026-09-10T00:00:00.000Z";

function boot(
	ability: RestartAbility,
	restart = vi.fn(async () => {}),
	over: Partial<CreateSystemRouteInput> = {},
) {
	const requestGeneration = vi.fn(async (_source: GenerationSourceKind) => {});
	const input: CreateSystemRouteInput = {
		ability,
		startedAt: STARTED,
		version: "0.10.1",
		restart,
		notices: { list: async () => [], acknowledge: async () => false },
		requestGeneration,
		zeroGenerationExists: async () => true,
		generations: { list: async () => [], remove: async () => ({ kind: "not_found" }) },
		storage: {
			list: async () => ({ rows: [] }),
			clear: async () => ({ freedBytes: 0 }),
			sweepImages: async () => ({ removedCount: 0, removedBytes: 0, referenced: 0, inGrace: 0 }),
		},
		...over,
	};
	return { app: createSystemRoute(input), restart, requestGeneration: input.requestGeneration };
}

const json = (body: unknown): RequestInit => ({
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify(body),
});

const settle = () => new Promise((r) => setTimeout(r, 5));

describe("POST /api/system/restart", () => {
	it("先回话,再关自己", async () => {
		const { app, restart } = boot({ can: true, how: "desktop" });

		const res = await app.request("/restart", { method: "POST" });

		expect(res.status).toBe(200);
		const body = (await res.json()) as RestartResponse;
		expect(body).toEqual({ restarting: true, startedAt: STARTED, version: "0.10.1" });
		// 🔴 回话交出去的那一刻还**没**开始关 —— 反了的话这条响应根本写不出去。
		expect(restart).not.toHaveBeenCalled();
		await new Promise((r) => setTimeout(r, 5));
		expect(restart).toHaveBeenCalledOnce();
	});

	it("拉不起来的环境 → 400 unsupported,一下都不关", async () => {
		const { app, restart } = boot({ can: false, reason: "source-run" });

		const res = await app.request("/restart", { method: "POST" });

		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "unsupported" });
		await new Promise((r) => setTimeout(r, 5));
		expect(restart).not.toHaveBeenCalled();
	});

	it("拒绝时说清楚是哪一种拉不起来 —— 那句话是面板唯一的线索", async () => {
		const { app } = boot({ can: false, reason: "unsupervised" });
		const body = (await (await app.request("/restart", { method: "POST" })).json()) as {
			code: string;
			message: string;
		};
		expect(body.code).toBe("unsupported");
		expect(body.message).toContain("没人");
	});

	/**
	 * 优雅停机是 rethrow 的,而这一步之前 unhandledRejection 的 handler 已经摘掉了 ——
	 * 没人接的话 Node 走默认:退出码 1,编排系统当成崩溃去退避重启。
	 */
	it("restart 抛了 → 不变成 unhandled rejection", async () => {
		const restart = vi.fn(async () => {
			throw new Error("dispose exploded");
		});
		const { app } = boot({ can: true, how: "container" }, restart);

		expect((await app.request("/restart", { method: "POST" })).status).toBe(200);
		await new Promise((r) => setTimeout(r, 5));
		expect(restart).toHaveBeenCalledOnce();
	});
});

const migrated: SystemNotice = {
	id: "n1",
	createdAt: "2026-10-02T00:00:00.000Z",
	kind: "migrated",
	cardSkinsDropped: true,
};
const rolledBack: SystemNotice = {
	id: "n2",
	createdAt: "2026-10-02T00:00:01.000Z",
	kind: "rolled-back",
	version: "1.0.1",
};

describe("GET /api/system/notices", () => {
	it("交出主人还没看过的那些", async () => {
		const { app } = boot({ can: true, how: "desktop" }, undefined, {
			notices: { list: async () => [migrated, rolledBack], acknowledge: async () => false },
		});

		const res = await app.request("/notices");

		expect(res.status).toBe(200);
		expect((await res.json()) as SystemNoticesResponse).toEqual({
			notices: [migrated, rolledBack],
		});
	});
});

describe("POST /api/system/notices/:id/acknowledge", () => {
	it("标已读,交回剩下的那些", async () => {
		let left = [migrated, rolledBack];
		const acknowledge = vi.fn(async (id: string) => {
			left = left.filter((n) => n.id !== id);
			return true;
		});
		const { app } = boot({ can: true, how: "desktop" }, undefined, {
			notices: { list: async () => left, acknowledge },
		});

		const res = await app.request("/notices/n1/acknowledge", { method: "POST" });

		expect(res.status).toBe(200);
		expect(acknowledge).toHaveBeenCalledWith("n1");
		expect((await res.json()) as SystemNoticesResponse).toEqual({ notices: [rolledBack] });
	});

	it("没有这一条 → 404 not_found", async () => {
		const { app } = boot({ can: true, how: "desktop" });

		const res = await app.request("/notices/nope/acknowledge", { method: "POST" });

		expect(res.status).toBe(404);
		expect(await res.json()).toMatchObject({ code: "not_found" });
	});
});

describe("POST /api/system/generations", () => {
	it("全新开始:先写下标记,回话,再关自己", async () => {
		const { app, restart, requestGeneration } = boot({ can: true, how: "container" });

		const res = await app.request("/generations", json({ source: "empty" }));

		expect(res.status).toBe(200);
		expect((await res.json()) as RestartResponse).toEqual({
			restarting: true,
			startedAt: STARTED,
			version: "0.10.1",
		});
		expect(requestGeneration).toHaveBeenCalledWith("empty");
		expect(restart).not.toHaveBeenCalled();
		await settle();
		expect(restart).toHaveBeenCalledOnce();
	});

	it("从旧代重新迁移,第 0 代还在 → 照样写标记、重启", async () => {
		const { app, restart, requestGeneration } = boot({ can: true, how: "desktop" });

		expect((await app.request("/generations", json({ source: "zero" }))).status).toBe(200);

		expect(requestGeneration).toHaveBeenCalledWith("zero");
		await settle();
		expect(restart).toHaveBeenCalledOnce();
	});

	it("拉不起来的环境 → 400 unsupported,标记不写、一下都不关", async () => {
		const { app, restart, requestGeneration } = boot({ can: false, reason: "unsupervised" });

		const res = await app.request("/generations", json({ source: "empty" }));

		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "unsupported" });
		await settle();
		expect(requestGeneration).not.toHaveBeenCalled();
		expect(restart).not.toHaveBeenCalled();
	});

	it("要求从第 0 代迁、第 0 代已经不在了 → 404 not_found,说清楚;标记不写、不关", async () => {
		const { app, restart, requestGeneration } = boot({ can: true, how: "desktop" }, undefined, {
			zeroGenerationExists: async () => false,
		});

		const res = await app.request("/generations", json({ source: "zero" }));

		expect(res.status).toBe(404);
		const body = (await res.json()) as { code: string; message: string };
		expect(body.code).toBe("not_found");
		expect(body.message).toContain("第 0 代");
		await settle();
		expect(requestGeneration).not.toHaveBeenCalled();
		expect(restart).not.toHaveBeenCalled();
	});

	it.each([[{}], [{ source: "full" }], [{ source: "empty", extra: 1 }]])(
		"请求体不合规矩(%j)→ 400 invalid,标记不写、不关",
		async (body) => {
			const { app, restart, requestGeneration } = boot({ can: true, how: "desktop" });

			const res = await app.request("/generations", json(body));

			expect(res.status).toBe(400);
			expect(await res.json()).toMatchObject({ code: "invalid" });
			await settle();
			expect(requestGeneration).not.toHaveBeenCalled();
			expect(restart).not.toHaveBeenCalled();
		},
	);

	it("标记没写成 → 不关(不然重启回来什么都没变,主人还以为点过了)", async () => {
		const { app, restart } = boot({ can: true, how: "desktop" }, undefined, {
			requestGeneration: async () => {
				throw new Error("disk full");
			},
		});

		const res = await app.request("/generations", json({ source: "empty" }));

		expect(res.status).toBe(500);
		await settle();
		expect(restart).not.toHaveBeenCalled();
	});
});

describe("/api/system/generations(㉙c 旧版本数据)", () => {
	const info: GenerationInfo = {
		seq: 0,
		current: false,
		partial: false,
		formatVersion: null,
		createdBy: "0.x",
		lastActiveAt: null,
		deletable: true,
		lockReason: null,
		deletableAt: null,
		sizeBytes: 10,
		reclaimableBytes: 4,
	};

	function withGenerations(result: GenerationRemoval = { kind: "removed", freedBytes: 4 }) {
		const remove = vi.fn(async (_seq: number) => result);
		const { app } = boot({ can: true, how: "desktop" }, undefined, {
			generations: { list: async () => [info], remove },
		});
		return { app, remove };
	}

	it("GET:原样回列表", async () => {
		const { app } = withGenerations();
		const res = await app.request("/generations");
		expect(res.status).toBe(200);
		expect((await res.json()) as GenerationsResponse).toEqual({ generations: [info] });
	});

	it("DELETE:成功回腾出的字节;第 0 代的 :seq 是 0,传给注入的函数的是数字", async () => {
		const { app, remove } = withGenerations();
		const res = await app.request("/generations/0", { method: "DELETE" });
		expect(res.status).toBe(200);
		expect((await res.json()) as GenerationDeleteResponse).toEqual({ freedBytes: 4 });
		expect(remove).toHaveBeenCalledWith(0);
	});

	it("DELETE 被锁:409 conflict,message 说人话,错误体不带原因码(upstreamCode 是上游的码)", async () => {
		const { app } = withGenerations({ kind: "locked", reason: "protected-source" });
		const res = await app.request("/generations/0", { method: "DELETE" });
		expect(res.status).toBe(409);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toMatchObject({ code: "conflict", message: expect.stringContaining("30 天") });
		expect(body).not.toHaveProperty("upstreamCode");
	});

	it("DELETE 没有这一代:404 not_found(同别的 DELETE,不做幂等)", async () => {
		const { app } = withGenerations({ kind: "not_found" });
		const res = await app.request("/generations/9", { method: "DELETE" });
		expect(res.status).toBe(404);
		expect(await res.json()).toMatchObject({ code: "not_found" });
	});

	it.each([
		"abc",
		"1.5",
		"-1",
		"+1",
		"007",
		"1e3",
		"99999999999999999999",
		"..%2F1",
		"1%2F..%2F2",
		"1.partial",
	])("DELETE :seq=%s 非规范纯数字 → 400 invalid,根本不调删除", async (seq) => {
		const { app, remove } = withGenerations();
		const res = await app.request(`/generations/${seq}`, { method: "DELETE" });
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "invalid" });
		expect(remove).not.toHaveBeenCalled();
	});

	it("带真路径分隔符的 /generations/1/2 根本匹配不到删除口", async () => {
		const { app, remove } = withGenerations();
		const res = await app.request("/generations/1/2", { method: "DELETE" });
		expect(res.status).toBe(404);
		expect(remove).not.toHaveBeenCalled();
	});
});

describe("存储占用(㉙d)", () => {
	function withStorage(over: Partial<CreateSystemRouteInput["storage"]> = {}) {
		const clear = vi.fn(
			async (_category: ClearableStorageCategory): Promise<StorageClearResponse> => ({
				freedBytes: 123,
			}),
		);
		const list = vi.fn(
			async (): Promise<StorageUsageResponse> => ({
				rows: [{ category: "stats", sizeBytes: 9, clearable: true }],
			}),
		);
		const sweepImages = vi.fn(
			async (): Promise<ImageSweepResponse> => ({
				removedCount: 2,
				removedBytes: 50,
				referenced: 3,
				inGrace: 4,
			}),
		);
		const { app } = boot({ can: true, how: "desktop" }, undefined, {
			storage: { list, clear, sweepImages, ...over },
		});
		return { app, clear, list, sweepImages };
	}

	it("GET /storage:原样回用量表", async () => {
		const { app, list } = withStorage();
		const res = await app.request("/storage");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			rows: [{ category: "stats", sizeBytes: 9, clearable: true }],
		});
		expect(list).toHaveBeenCalledOnce();
	});

	it.each(["stats", "historyText", "historyImages", "ai"] as const)(
		"DELETE /storage/%s:清,回 { freedBytes }",
		async (category) => {
			const { app, clear } = withStorage();
			const res = await app.request(`/storage/${category}`, { method: "DELETE" });
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ freedBytes: 123 });
			expect(clear).toHaveBeenCalledExactlyOnceWith(category);
		},
	);

	it.each([
		["generations", "逐代删"],
		["logs", "只读"],
		["otherImages", "只读"],
		["nope", "没有这一类"],
		["Stats", "没有这一类"],
		["stats%2F..", "没有这一类"],
	])("DELETE /storage/%s → 400 invalid,不调清理", async (category, hint) => {
		const { app, clear } = withStorage();
		const res = await app.request(`/storage/${category}`, { method: "DELETE" });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { code: string; message: string };
		expect(body.code).toBe("invalid");
		expect(body.message).toContain(hint);
		expect(clear).not.toHaveBeenCalled();
	});

	it("清理抛错 → 不吞,交给全局出错处理(路由自己不回 200)", async () => {
		const { app } = withStorage({
			clear: async () => {
				throw new Error("disk gone");
			},
		});
		await expect(app.request("/storage/ai", { method: "DELETE" })).resolves.toMatchObject({
			status: 500,
		});
	});

	it("POST /storage/images/sweep:回清扫结果", async () => {
		const { app, sweepImages } = withStorage();
		const res = await app.request("/storage/images/sweep", { method: "POST" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			removedCount: 2,
			removedBytes: 50,
			referenced: 3,
			inGrace: 4,
		});
		expect(sweepImages).toHaveBeenCalledOnce();
	});

	it("清扫只认 POST(GET 不会触发一次清扫)", async () => {
		const { app, sweepImages } = withStorage();
		const res = await app.request("/storage/images/sweep");
		expect(res.status).toBe(404);
		expect(sweepImages).not.toHaveBeenCalled();
	});
});
