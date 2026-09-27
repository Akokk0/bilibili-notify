import { afterAll, afterEach } from "vite-plus/test";
import { assertNoBlockedConnections, networkGuard } from "./network-guard.mjs";

// 根 vite.config 的 test.setupFiles:每个测试文件跑之前先装上「测试拦外网」,每条测试收尾查一次账
// (beforeAll 与模块顶层发起的,记在第一条测试头上);afterAll 兜住最后一条测试之后才发起的 ——
// 文件自己的 afterAll、迟到的后台任务。
const guard = networkGuard();
afterEach(() => assertNoBlockedConnections(guard.drain()));
afterAll(() => assertNoBlockedConnections(guard.drain()));
