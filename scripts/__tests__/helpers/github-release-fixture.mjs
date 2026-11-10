import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";

/** GitHub REST系统边界夹具；真实CLI子进程只连本机，不模拟自己的发布模块。 */
export async function githubReleaseFixture() {
	const state = {
		requests: [],
		releases: new Map(),
		assets: new Map(),
		nextId: 1,
		head: "",
		failure: undefined,
	};
	let endpoint;
	const server = createServer(async (req, res) => {
		try {
			const url = new URL(req.url, endpoint);
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			const bytes = Buffer.concat(chunks);
			const json =
				bytes.length && req.headers["content-type"]?.includes("application/json")
					? JSON.parse(bytes.toString())
					: undefined;
			const request = {
				method: req.method,
				path: url.pathname,
				name: url.searchParams.get("name"),
				json,
			};
			state.requests.push(request);
			const send = (status, body) => {
				res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
			};
			if (req.headers.authorization !== "Bearer local-fixture-token")
				return send(401, { message: "Missing fixture token" });
			if (state.failure?.(request)) {
				state.failure = undefined;
				return send(503, { message: "Injected failure" });
			}
			const path = url.pathname.replace(/^\/repos\/owner\/tools/, "");
			if (req.method === "GET" && path.startsWith("/git/ref/tags/"))
				return send(200, { object: { type: "commit", sha: state.head } });
			if (req.method === "GET" && path.startsWith("/releases/tags/")) {
				const tag = decodeURIComponent(path.slice("/releases/tags/".length));
				const release = [...state.releases.values()].find(
					(item) => item.tag_name === tag && !item.draft,
				);
				return send(release ? 200 : 404, release ?? { message: "Not found" });
			}
			if (req.method === "GET" && path === "/releases") {
				const page = Number(url.searchParams.get("page") ?? 1);
				return send(200, [...state.releases.values()].slice((page - 1) * 100, page * 100));
			}
			if (req.method === "POST" && path === "/releases") {
				if ([...state.releases.values()].some((item) => item.tag_name === json.tag_name))
					return send(422, { message: "Release exists" });
				const id = state.nextId++;
				const release = {
					...json,
					id,
					draft: json.draft ?? false,
					immutable: false,
					assets: [],
					upload_url: `${endpoint}/repos/owner/tools/releases/${id}/assets{?name,label}`,
				};
				state.releases.set(id, release);
				return send(201, release);
			}
			const releasePath = /^\/releases\/(\d+)$/.exec(path);
			if (releasePath) {
				const release = state.releases.get(Number(releasePath[1]));
				if (!release) return send(404, { message: "Not found" });
				if (req.method === "GET") return send(200, release);
				if (req.method === "PATCH") {
					Object.assign(release, json);
					if (!release.draft && release.tag_name.startsWith("v")) release.immutable = true;
					return send(200, release);
				}
			}
			const upload = /^\/releases\/(\d+)\/assets$/.exec(path);
			if (upload) {
				const release = state.releases.get(Number(upload[1]));
				if (!release) return send(404, { message: "Not found" });
				if (req.method === "GET") return send(200, release.assets);
				if (req.method === "POST") {
					if (release.immutable) return send(422, { message: "Immutable release" });
					const name = url.searchParams.get("name");
					if (release.assets.some((item) => item.name === name))
						return send(422, { message: "Asset exists" });
					const asset = {
						id: state.nextId++,
						name,
						size: bytes.length,
						digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
						state: "uploaded",
					};
					release.assets.push(asset);
					state.assets.set(asset.id, { bytes, releaseId: release.id, asset });
					return send(201, asset);
				}
			}
			const assetPath = /^\/releases\/assets\/(\d+)$/.exec(path);
			if (assetPath) {
				const id = Number(assetPath[1]);
				const stored = state.assets.get(id);
				if (!stored) return send(404, { message: "Not found" });
				const release = state.releases.get(stored.releaseId);
				if (req.method === "GET") {
					res.writeHead(200, { "content-type": "application/octet-stream" }).end(stored.bytes);
					return;
				}
				if (release.immutable) return send(422, { message: "Immutable release" });
				if (req.method === "PATCH") {
					if (release.assets.some((item) => item.id !== id && item.name === json.name))
						return send(422, { message: "Asset exists" });
					Object.assign(stored.asset, json);
					return send(200, stored.asset);
				}
				if (req.method === "DELETE") {
					release.assets = release.assets.filter((item) => item.id !== id);
					state.assets.delete(id);
					res.writeHead(204).end();
					return;
				}
			}
			send(404, { message: `Unsupported fixture route: ${req.method} ${path}` });
		} catch (error) {
			res
				.writeHead(500, { "content-type": "application/json" })
				.end(JSON.stringify({ message: String(error) }));
		}
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	endpoint = `http://127.0.0.1:${server.address().port}`;
	return {
		endpoint,
		state,
		seedIndex(index) {
			const id = state.nextId++;
			const release = {
				id,
				tag_name: "bn-marketplace",
				draft: false,
				immutable: false,
				assets: [],
				upload_url: `${endpoint}/repos/owner/tools/releases/${id}/assets{?name,label}`,
			};
			const bytes = Buffer.from(JSON.stringify(index));
			const asset = { id: state.nextId++, name: "marketplace.json", size: bytes.length };
			release.assets.push(asset);
			state.assets.set(asset.id, { bytes, releaseId: release.id, asset });
			state.releases.set(id, release);
		},
		reset() {
			state.requests.length = 0;
			state.releases.clear();
			state.assets.clear();
			state.nextId = 1;
			state.failure = undefined;
		},
		async close() {
			server.closeAllConnections();
			await new Promise((done) => server.close(done));
		},
		async readIndex() {
			const release = [...state.releases.values()].find(
				(item) => item.tag_name === "bn-marketplace" && !item.draft,
			);
			const asset = release?.assets.find((item) => item.name === "marketplace.json");
			if (!asset) throw new Error("No public marketplace index");
			const response = await fetch(`${endpoint}/repos/owner/tools/releases/assets/${asset.id}`, {
				headers: {
					Authorization: "Bearer local-fixture-token",
					Accept: "application/octet-stream",
				},
			});
			return response.json();
		},
	};
}
