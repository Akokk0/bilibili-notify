import { afterAll, expect, it } from "vite-plus/test";
import { oldShape500 } from "./server/routes/legacy-shape.mjs";

// 由 scripts/__tests__/error-body-guard.test.mjs 起子进程跑。收尾钩子里服务端代码造了旧形状:
// 已经没有下一条测试的 afterEach 了,要靠 setup 里的 afterAll 查账把整个文件判失败。

afterAll(() => {
	oldShape500();
});

it("用例本身没造", () => {
	expect(1 + 1).toBe(2);
});
