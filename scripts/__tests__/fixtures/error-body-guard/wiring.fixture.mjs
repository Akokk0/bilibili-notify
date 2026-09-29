import { expect, it } from "vite-plus/test";
import { fakeUpstream500 } from "./server/__tests__/made-by-test.mjs";
import {
	callThrough,
	copyOf,
	goodShape404,
	ok200,
	oldShape500,
	plainText404,
	staticJson404,
	streamBody500,
} from "./server/routes/legacy-shape.mjs";

// 由 scripts/__tests__/error-body-guard.test.mjs 起子进程跑。前四条的回应是「服务端代码」造的旧形状,
// 收尾查账要把它们判失败;其余几条要么合规、要么是测试自己造的,不能被牵连。

it("旧形状的 500", () => {
	expect(oldShape500().status).toBe(500);
});

it("Response.json 静态方法造的旧形状", () => {
	expect(staticJson404().status).toBe(404);
});

it("纯文本的 404", () => {
	expect(plainText404().status).toBe(404);
});

it("体是流的 500", () => {
	expect(streamBody500().status).toBe(500);
});

it("合规的错误体", () => {
	expect(goodShape404().status).toBe(404);
});

it("2xx 不管", () => {
	expect(ok200().status).toBe(200);
});

it("测试文件自己造的假回应", () => {
	expect(new Response('{"error":"fake"}', { status: 500 }).status).toBe(500);
});

it("服务端代码调了测试给的 mock", () => {
	expect(callThrough(() => new Response("mock says no", { status: 502 })).status).toBe(502);
});

it("服务端目录里 __tests__ 下造的", () => {
	expect(fakeUpstream500().status).toBe(500);
});

it("复制一份旧回应不重复记账", () => {
	const original = new Response('{"error":"made by the test"}', { status: 500 });
	expect(copyOf(original).status).toBe(500);
});

it("之后的测试不受牵连", () => {
	expect(1 + 1).toBe(2);
});
