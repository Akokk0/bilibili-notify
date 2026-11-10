import { z } from "zod";
import { digestOf } from "../../../scripts/reproducible-zip.mjs";

const AssetSchema = z.object({
	id: z.number().int().positive(),
	name: z.string(),
	size: z.number().int().nonnegative(),
});
const ReleaseSchema = z.object({
	id: z.number().int().positive(),
	tag_name: z.string(),
	draft: z.boolean(),
	immutable: z.boolean().default(false),
	upload_url: z.string(),
	assets: z.array(AssetSchema),
});
export type GithubRelease = z.infer<typeof ReleaseSchema>;
type GithubAsset = z.infer<typeof AssetSchema>;

/** 只封装本工具实际使用的Release协议；不接受配置中的任意令牌接收地址。 */
export class GithubApi {
	private readonly base: URL;
	private readonly repoPath: string;
	constructor(
		repository: string,
		private readonly token: string,
		apiBase = "https://api.github.com",
	) {
		this.base = new URL(apiBase);
		const local =
			this.base.protocol === "http:" &&
			["127.0.0.1", "localhost", "[::1]"].includes(this.base.hostname);
		if (
			(!local && this.base.origin !== "https://api.github.com") ||
			this.base.pathname !== "/" ||
			this.base.search ||
			this.base.hash ||
			this.base.username ||
			this.base.password
		)
			throw new Error("API base must be api.github.com or a loopback HTTP fixture.");
		this.repoPath = `/repos/${repository}`;
	}
	private headers(accept = "application/vnd.github+json") {
		return {
			Authorization: `Bearer ${this.token}`,
			Accept: accept,
			"X-GitHub-Api-Version": "2022-11-28",
		};
	}
	private async response(method: string, path: string, data?: unknown, allowMissing = false) {
		const response = await fetch(new URL(`${this.repoPath}${path}`, this.base), {
			method,
			headers: {
				...this.headers(),
				...(data === undefined ? {} : { "Content-Type": "application/json" }),
			},
			body: data === undefined ? undefined : JSON.stringify(data),
			signal: AbortSignal.timeout(30_000),
			redirect: "error",
		});
		if (allowMissing && response.status === 404) return undefined;
		if (!response.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}`);
		return response;
	}
	private async json(method: string, path: string, data?: unknown) {
		return (await this.response(method, path, data))?.json() as Promise<unknown>;
	}
	async assertTag(tag: string, head: string): Promise<void> {
		const objectSchema = z.object({
			object: z.object({
				type: z.enum(["commit", "tag"]),
				sha: z.string().regex(/^[0-9a-f]{40}$/),
			}),
		});
		let object = objectSchema.parse(
			await this.json("GET", `/git/ref/tags/${encodeURIComponent(tag)}`),
		).object;
		for (let depth = 0; object.type === "tag" && depth < 8; depth++)
			object = objectSchema.parse(await this.json("GET", `/git/tags/${object.sha}`)).object;
		if (object.type !== "commit" || object.sha !== head)
			throw new Error("The GitHub tag does not point to the checked-out commit.");
	}
	async findRelease(tag: string): Promise<GithubRelease | undefined> {
		const response = await this.response(
			"GET",
			`/releases/tags/${encodeURIComponent(tag)}`,
			undefined,
			true,
		);
		if (response) return ReleaseSchema.parse(await response.json());
		// 按tag的读取不保证返回草稿；上传中断后的重跑须能找到原草稿。
		for (let page = 1; ; page++) {
			const releases = z
				.array(ReleaseSchema)
				.parse(await this.json("GET", `/releases?per_page=100&page=${page}`));
			const found = releases.find((release) => release.tag_name === tag);
			if (found || releases.length < 100) return found;
		}
	}
	async createRelease(
		tag: string,
		head: string,
		draft: boolean,
		prerelease: boolean,
	): Promise<GithubRelease> {
		return ReleaseSchema.parse(
			await this.json("POST", "/releases", {
				tag_name: tag,
				target_commitish: head,
				name: tag,
				draft,
				prerelease,
				make_latest: "false",
			}),
		);
	}
	async publish(release: GithubRelease): Promise<GithubRelease> {
		return ReleaseSchema.parse(
			await this.json("PATCH", `/releases/${release.id}`, { draft: false }),
		);
	}
	async readAsset(asset: GithubAsset): Promise<Uint8Array> {
		const response = await fetch(
			new URL(`${this.repoPath}/releases/assets/${asset.id}`, this.base),
			{ headers: this.headers("application/octet-stream"), signal: AbortSignal.timeout(30_000) },
		);
		if (!response.ok) throw new Error(`GitHub asset ${asset.name}: HTTP ${response.status}`);
		return new Uint8Array(await response.arrayBuffer());
	}
	private async upload(
		release: GithubRelease,
		name: string,
		bytes: Uint8Array,
	): Promise<GithubAsset> {
		const url = new URL(release.upload_url.replace(/\{.*$/, ""));
		const expectedOrigin =
			this.base.origin === "https://api.github.com"
				? "https://uploads.github.com"
				: this.base.origin;
		if (
			url.origin !== expectedOrigin ||
			url.pathname !== `${this.repoPath}/releases/${release.id}/assets` ||
			url.username ||
			url.password
		)
			throw new Error("Unexpected GitHub upload URL.");
		url.searchParams.set("name", name);
		const response = await fetch(url, {
			method: "POST",
			headers: { ...this.headers(), "Content-Type": "application/octet-stream" },
			body: Uint8Array.from(bytes).buffer,
			signal: AbortSignal.timeout(30_000),
			redirect: "error",
		});
		if (!response.ok) throw new Error(`GitHub upload ${name}: HTTP ${response.status}`);
		return AssetSchema.parse(await response.json());
	}
	async ensureAsset(release: GithubRelease, name: string, bytes: Uint8Array): Promise<GithubAsset> {
		const found = release.assets.find((asset) => asset.name === name);
		if (found) {
			const expected = digestOf(bytes);
			const actual = digestOf(await this.readAsset(found));
			if (actual.sha256 !== expected.sha256 || actual.size !== expected.size)
				throw new Error(
					`Existing asset ${name} differs; use a new version. Assets are never overwritten.`,
				);
			return found;
		}
		if (!release.draft || release.immutable)
			throw new Error(`Published release is missing ${name}; use a new version.`);
		const uploaded = await this.upload(release, name, bytes);
		release.assets.push(uploaded);
		return uploaded;
	}
	private async rename(asset: GithubAsset, name: string) {
		return AssetSchema.parse(await this.json("PATCH", `/releases/assets/${asset.id}`, { name }));
	}
	private async remove(asset: GithubAsset) {
		await this.response("DELETE", `/releases/assets/${asset.id}`);
	}
	async writeIndex(release: GithubRelease, bytes: Uint8Array): Promise<void> {
		if (release.immutable) throw new Error("The rolling marketplace release must remain mutable.");
		const candidateName = `marketplace.${digestOf(bytes).sha256}.json`;
		const candidate =
			release.assets.find((asset) => asset.name === candidateName) ??
			(await this.upload(release, candidateName, bytes));
		const current = release.assets.find((asset) => asset.name === "marketplace.json");
		const previous = release.assets.find((asset) => asset.name === "marketplace.previous.json");
		if (current && previous) await this.remove(previous);
		const backup = current ? await this.rename(current, "marketplace.previous.json") : previous;
		try {
			await this.rename(candidate, "marketplace.json");
		} catch (error) {
			if (backup) await this.rename(backup, "marketplace.json");
			throw error;
		}
		if (backup) await this.remove(backup);
		if (release.draft) await this.publish(release);
	}
}
