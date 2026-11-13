import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";

/** 只在loopback提供npm registry协议，不模拟仓库自己的发行模块。 */
export async function npmRegistryFixture() {
	const state = { requests: [], versions: {}, tags: {}, packages: {}, staged: [] };
	const packageState = (name) => {
		if (name === "@bilibili-notify/bn") return state;
		state.packages[name] ??= { versions: {}, tags: {} };
		return state.packages[name];
	};
	const server = createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		const body = Buffer.concat(chunks).toString();
		const url = new URL(request.url, "http://fixture");
		const path = decodeURIComponent(url.pathname);
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
		if (path === "/-/stage" || path.startsWith("/-/stage/")) {
			if (request.headers.authorization !== "Bearer local-fixture-token")
				return send(401, { error: "Missing fixture token" });
			if (request.method === "GET" && path === "/-/stage") {
				const items = state.staged
					.filter((item) => item.packageName === url.searchParams.get("package"))
					.map(({ tarball, ...item }) => item);
				return send(200, { items, total: items.length });
			}
			if (request.method === "GET" && path.endsWith("/tarball")) {
				const item = state.staged.find((entry) => path === `/-/stage/${entry.id}/tarball`);
				if (!item) return send(404, { error: "Unknown stage" });
				return response
					.writeHead(200, { "content-type": "application/octet-stream" })
					.end(item.tarball);
			}
		}
		if (request.method === "POST" && path.startsWith("/-/stage/package/")) {
			const packument = JSON.parse(body);
			const [tag, version] = Object.entries(packument["dist-tags"])[0];
			const id = randomUUID();
			state.staged.push({
				id,
				packageName: packument.name,
				version,
				tag,
				access: packument.access,
				tarball: Buffer.from(Object.values(packument._attachments)[0].data, "base64"),
			});
			return send(201, { stageId: id });
		}
		const tag = /^\/-\/package\/(.+)\/dist-tags(?:\/([^/]+))?$/.exec(path);
		const name = tag?.[1] ?? path.slice(1);
		const pkg = packageState(name);
		if (request.method === "GET" && !tag) {
			const versions = state.visibleVersions?.(pkg.versions) ?? pkg.versions;
			return send(Object.keys(versions).length ? 200 : 404, {
				name,
				versions,
				"dist-tags": pkg.tags,
			});
		}
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
		approveStage(name) {
			const item = state.staged.find((entry) => entry.packageName === name);
			if (!item) throw new Error(`No pending stage for ${name}`);
			const target = packageState(name);
			target.versions[item.version] = {
				dist: { integrity: `sha512-${createHash("sha512").update(item.tarball).digest("base64")}` },
			};
			target.tags[item.tag] = item.version;
			state.staged = state.staged.filter((entry) => entry !== item);
		},
		reset() {
			state.requests.length = 0;
			state.versions = {};
			state.tags = {};
			state.packages = {};
			state.staged = [];
			state.failure = undefined;
			state.failAfterPublish = false;
			state.visibleVersions = undefined;
		},
		async close() {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}
