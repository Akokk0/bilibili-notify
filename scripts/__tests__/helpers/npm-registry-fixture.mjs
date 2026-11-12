import { once } from "node:events";
import { createServer } from "node:http";

/** 只在loopback提供npm registry协议，不模拟仓库自己的发行模块。 */
export async function npmRegistryFixture() {
	const state = { requests: [], versions: {}, tags: {}, packages: {} };
	const packageState = (name) => {
		if (name === "@bilibili-notify/bn") return state;
		state.packages[name] ??= { versions: {}, tags: {} };
		return state.packages[name];
	};
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
		const send = (status, json) =>
			response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
		const tag = /^\/-\/package\/(.+)\/dist-tags(?:\/([^/]+))?$/.exec(path);
		const name = tag?.[1] ?? path.slice(1);
		const pkg = packageState(name);
		if (request.method === "GET" && !tag)
			return send(Object.keys(pkg.versions).length ? 200 : 404, {
				name,
				versions: pkg.versions,
				"dist-tags": pkg.tags,
			});
		if (request.method === "GET" && tag) return send(200, pkg.tags);
		if (request.headers.authorization !== "Bearer local-fixture-token")
			return send(401, { error: "Missing fixture token" });
		if (request.method === "PUT" && !tag) {
			const json = JSON.parse(body);
			for (const version of Object.keys(json.versions)) {
				if (pkg.versions[version]) return send(409, { error: "Version already exists" });
			}
			Object.assign(pkg.versions, json.versions);
			Object.assign(pkg.tags, json["dist-tags"]);
			if (state.failAfterPublish) {
				state.failAfterPublish = false;
				return send(503, { error: "Response lost after publishing" });
			}
			return send(201, { ok: true });
		}
		if (request.method === "PUT" && tag?.[2]) {
			pkg.tags[tag[2]] = JSON.parse(body);
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
		package: packageState,
		reset() {
			state.requests.length = 0;
			state.versions = {};
			state.tags = {};
			state.packages = {};
			state.failure = undefined;
			state.failAfterPublish = false;
		},
		async close() {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}
