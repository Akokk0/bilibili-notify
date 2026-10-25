import type { ServiceContext, SourceAuth } from "@bilibili-notify/internal";
import { type Mock, vi } from "vite-plus/test";
import type { ImageWriter } from "../../../images/image-store.js";
import type { Api } from "../../api/index.js";
import type { AuthSystem } from "../../auth/index.js";
import type { BiliContext } from "../../context.js";

/**
 * 来源单测用的假登录系统:来源的单测关心的是来源自己(引擎怎么起停、设置怎么读、问题怎么报),登录那一套(真的状态机、
 * 罐子、存储)在 `auth/__tests__` 与 `__tests__/compose.test.ts` 钉着。假的 `api` / `auth` 由用例给,`start` / `stop` /
 * `setHealthCheckMs` 都是 spy,好看来源有没有按次序调。
 *
 * 用法:测试文件里 `vi.mock("../auth/index.js", () => ({ createAuthSystem: (o) => o.context.login }))`
 * (工厂得写在文件里才会被提升),`context` 用 {@link fakeLoginDeps} 给的那一个 —— 它带着这里造的假系统。
 */
export interface FakeLoginSystem extends AuthSystem {
	api: Api;
	auth: Required<SourceAuth>;
	start: Mock<() => Promise<void>>;
	stop: Mock<() => void>;
	healthCheckNow: Mock<() => Promise<boolean>>;
	handleAuthLost: Mock<() => Promise<void>>;
	reportAccountInfo: Mock<() => Promise<void>>;
	setHealthCheckMs: Mock<(ms: number) => void>;
}

export function fakeLoginSystem(parts: {
	api: Api;
	auth: SourceAuth;
	setHealthCheckMs?: Mock<(ms: number) => void>;
}): FakeLoginSystem {
	return {
		api: parts.api,
		auth: parts.auth as Required<SourceAuth>,
		start: vi.fn(async () => {}),
		stop: vi.fn(),
		healthCheckNow: vi.fn(async () => true),
		handleAuthLost: vi.fn(async () => {}),
		reportAccountInfo: vi.fn(async () => {}),
		setHealthCheckMs: parts.setHealthCheckMs ?? vi.fn(),
	};
}

/** `BiliSourceDeps` 里与登录那一套有关的三格:`context` 带着假系统(被测文件里的 mock 工厂从它取),其余是不被读的占位。 */
export function fakeLoginDeps(login: FakeLoginSystem, logger: ServiceContext["logger"]) {
	return {
		context: { login } as unknown as BiliContext,
		serviceCtx: { logger } as unknown as ServiceContext,
		accountImages: {} as unknown as ImageWriter,
	};
}
