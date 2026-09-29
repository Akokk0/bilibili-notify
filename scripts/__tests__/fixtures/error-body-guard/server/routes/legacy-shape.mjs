// 「服务端代码」:接线夹具里被守卫认作服务端源码的一个文件。每个函数造一种回应。

export function oldShape500() {
	return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
}

export function staticJson404() {
	return Response.json({ error: "not_found" }, { status: 404 });
}

export function plainText404() {
	return new Response("not found", { status: 404 });
}

export function streamBody500() {
	return new Response(new ReadableStream(), { status: 500 });
}

export function goodShape404() {
	return new Response(JSON.stringify({ code: "not_found", message: "没有这个接口" }), {
		status: 404,
	});
}

export function ok200() {
	return new Response(JSON.stringify({ ok: true }), { status: 200 });
}

/** 服务端代码调用方给的回调(测试里的 mock),回应是回调造的。 */
export function callThrough(makeResponse) {
	return makeResponse();
}

/** 复制一份已有的回应(Hono 的 `c.res = …` 就这么做):体是流、状态码沿用原件。 */
export function copyOf(original) {
	return new Response(original.body, original);
}
