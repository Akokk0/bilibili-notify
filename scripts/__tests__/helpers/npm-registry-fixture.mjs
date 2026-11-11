import { once } from "node:events";
import { createServer } from "node:http";

/** 只在loopback提供npm registry协议，不模拟仓库自己的发行模块。 */
export async function npmRegistryFixture() {
	const state = { requests: [], versions: {}, tags: {} };
	const server = createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		const body = Buffer.concat(chunks).toString();
		const path = decodeURIComponent(new URL(request.url, "http://fixture").pathname);
		const entry = { method: request.method, path, body };
		state.requests.push(entry);
		if (state.failure?.(entry)) {
			state.failure = undefined;
			response
				.writeHead(503, { "content-type": "application/json" })
				.end(JSON.stringify({ error: "Injected registry failure" }));
			return;
		}
		if (request.method === "GET" && path === "/@bilibili-notify/bn") {
			response
				.writeHead(Object.keys(state.versions).length ? 200 : 404, {
					"content-type": "application/json",
				})
				.end(
					JSON.stringify({
						name: "@bilibili-notify/bn",
						versions: state.versions,
						"dist-tags": state.tags,
					}),
				);
			return;
		}
		const tagPrefix = "/-/package/@bilibili-notify/bn/dist-tags";
		const send = (status, json) =>
			response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
		if (request.method === "GET" && path === tagPrefix) return send(200, state.tags);
		if (request.headers.authorization !== "Bearer local-fixture-token")
			return send(401, { error: "Missing fixture token" });
		if (request.method === "PUT" && path === "/@bilibili-notify/bn") {
			const json = JSON.parse(body);
			for (const version of Object.keys(json.versions)) {
				if (state.versions[version]) return send(409, { error: "Version already exists" });
			}
			Object.assign(state.versions, json.versions);
			Object.assign(state.tags, json["dist-tags"]);
			if (state.failAfterPublish) {
				state.failAfterPublish = false;
				return send(503, { error: "Response lost after publishing" });
			}
			return send(201, { ok: true });
		}
		if (request.method === "PUT" && path.startsWith(`${tagPrefix}/`)) {
			state.tags[path.slice(tagPrefix.length + 1)] = JSON.parse(body);
			return send(201, { ok: true });
		}
		response
			.writeHead(501, { "content-type": "application/json" })
			.end(JSON.stringify({ error: `Unexpected registry request: ${request.method} ${path}` }));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return {
		endpoint: `http://127.0.0.1:${server.address().port}/`,
		state,
		reset() {
			state.requests.length = 0;
			state.versions = {};
			state.tags = {};
			state.failure = undefined;
			state.failAfterPublish = false;
		},
		async close() {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}
