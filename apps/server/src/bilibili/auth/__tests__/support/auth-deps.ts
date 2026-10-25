import { fail, type ServiceContext } from "@bilibili-notify/internal";
import { vi } from "vite-plus/test";
import { ignoredProblems } from "../../../../__tests__/support/ignored-problems.js";
import { inertSettingsOf } from "../../../../__tests__/support/inert-settings.js";
import { inertTransitImages } from "../../../../__tests__/support/integration-io.js";
import type { ImageWriter } from "../../../../images/image-store.js";
import type { IntegrationStore } from "../../../../integration-store/store.js";
import { type BiliContextHandle, createBiliContext } from "../../../context.js";
import { type AuthSystem, createAuthSystem } from "../../index.js";

/**
 * 账号头像写口的测试替身:什么都存不进,这些测试不走抓头像那条线。
 */
export const inertAccountImages = {
	put: vi.fn(async () => fail("unavailable", "测试里没有图库")),
	keep: vi.fn(async () => false),
} as unknown as ImageWriter;

export interface AuthSystemWorld {
	/** 集成存储宿主:登录的 cookie 与令牌住在 `bilibili` 这个键下。 */
	integrationStore: Pick<IntegrationStore, "open">;
	/** 登录系统与上下文共用的宿主上下文(生产里是 B 站那一格,日志器与定时器都从它来)。 */
	serviceCtx: ServiceContext;
	transitImages?: Parameters<typeof createBiliContext>[0]["transitImages"];
}

export interface OpenedAuthSystem extends AuthSystem {
	readonly context: BiliContextHandle;
	/** 与从前 `AuthSystem.dispose` 同一个次序:先 `stop()`(停登录、作废在途续期),再收上下文(最后一次存盘、关存储把手)。 */
	dispose(): Promise<void>;
}

/**
 * 开 B 站的上下文并造好登录系统,**不起它**(`compose.ts` + `bilibili/source.ts` 在生产里做的前两步)。
 * 上下文的收尾归测试自己(`dispose()`)。
 */
export async function openAuthSystem(world: AuthSystemWorld): Promise<OpenedAuthSystem> {
	const context = await createBiliContext({
		stores: world.integrationStore,
		serviceCtx: world.serviceCtx,
		problems: ignoredProblems,
		transitImages: world.transitImages ?? inertTransitImages,
		settingsOf: inertSettingsOf,
	});
	const system = createAuthSystem({
		serviceCtx: world.serviceCtx,
		context: context.ctx,
		accountImages: inertAccountImages,
	});
	return {
		...system,
		context,
		async dispose() {
			system.stop();
			await context.dispose();
		},
	};
}

/** 开上下文、造登录系统、起它;起抛了就收上下文再抛(与 `compose.ts` 在登记失败时先收上下文再抛一致)。 */
export async function startAuthSystem(world: AuthSystemWorld): Promise<OpenedAuthSystem> {
	const opened = await openAuthSystem(world);
	try {
		await opened.start();
	} catch (err) {
		await opened.dispose();
		throw err;
	}
	return opened;
}
