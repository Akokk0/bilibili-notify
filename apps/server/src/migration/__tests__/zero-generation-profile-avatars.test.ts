/**
 * 0.x 的拓展订阅头像 `avatars/<订阅 id>.<png|jpeg|webp>` 进图库,资料缓存跟着改写(ADR-0022 决策 9 下
 * 10-04「⑳ 开片」的 🔗,⑳c)。
 *
 * 不再整目录搬:资料缓存(0.x 的 `state/sub-runtime.json`,迁移里复制进新代)里拓展订阅的 `avatar` 是同源相对地址
 * `/api/subs/<id>/avatar?v=…`,迁移顺着订阅 id 找到 `avatars/` 里那一个文件,读字节、按嗅探认格式,是图库收的图就
 * **复制**(不硬链接:图库靠刷新修改时间做宽限期,硬链接会改到第 0 代那份)进新代 `images/<sha256>.<ext>`,`avatar`
 * 换成引用。B 站订阅的 `avatar` 是 B 站 CDN 的远端网址,挪到 `avatarUrl`。空串、对不上的(文件不在、嗅探不过、超 8MB、
 * 软链、订阅 id 不是干净的文件名)都是两格都缺。没有任何资料引用的头像文件(孤儿)不搬。
 * 改写写的是新文件(原子换名),第 0 代一个字节不动。
 *
 * 怎么认一条资料是拓展的还是 B 站的:**看 `avatar` 值的形状** —— 开头是 `/` 的同源相对地址只有拓展订阅写得出来,
 * `http://` / `https://` / `//` 是 B 站的 CDN 图链。不去读订阅文件认身份:资料缓存按订阅 id 存,订阅文件读不懂时
 * (配置仓开机会拒收它)这一步照样做得了。
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { JPEG_BYTES, PNG_BYTES, WEBP_BYTES } from "../../__tests__/support/avatar-fixtures.js";
import { silentLogger } from "../../__tests__/support/silent-logger.js";
import { IMAGE_MAX_BYTES } from "../../images/image-store.js";
import { createSubRuntimeStore, SUB_RUNTIME_FILE } from "../../runtime/sub-runtime-store.js";
import { migrateProfileAvatars } from "../profile-avatars.js";
import { useZeroSandbox } from "./support.js";

const sandbox = useZeroSandbox("bn-zero-profile-avatars-");

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const refOf = (bytes: Uint8Array, ext: string) => `${sha256(bytes)}.${ext}`;
/** 0.x 的 `?v=`:内容 sha256 的前 12 位。 */
const digestOf = (bytes: Uint8Array) => sha256(bytes).slice(0, 12);

const EXT_A = "a0000000-0000-4000-8000-00000000000a";
const EXT_B = "a0000000-0000-4000-8000-00000000000b";
const BILI = "a0000000-0000-4000-8000-0000000000b1";
const BILI_URL = "https://i0.hdslb.com/bfs/face/abc.jpg";

/** 0.x 里拓展订阅资料的头像地址(面板从这里取)。 */
const addressOf = (id: string, bytes: Uint8Array) => `/api/subs/${id}/avatar?v=${digestOf(bytes)}`;

async function placeAvatar(file: string, bytes: Uint8Array | string): Promise<void> {
	const path = join(sandbox.zero, "avatars", file);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, bytes);
}

const profile = (avatar: unknown, extra: Record<string, unknown> = {}) => ({
	name: "某人",
	avatar,
	sign: "",
	lastRefreshedAt: "2026-09-01T00:00:00.000Z",
	...extra,
});

/** 摆 0.x 的资料缓存:订阅 id → 记录。 */
async function placeRuntime(records: Record<string, unknown>): Promise<void> {
	await sandbox.placeZero("state/sub-runtime.json", records);
}

const imagesDir = () => join(sandbox.target, "images");
const readImagesDir = async () => (await readdir(imagesDir()).catch(() => [])).sort();
const runtimePath = () => join(sandbox.target, ...SUB_RUNTIME_FILE);
const readRuntime = async () =>
	JSON.parse(await readFile(runtimePath(), "utf8")) as Record<
		string,
		{ cachedProfile?: Record<string, unknown> } & Record<string, unknown>
	>;

describe("拓展订阅的头像", () => {
	it("复制进图库 images/<sha256>.<ext>(不是硬链接),资料里的 avatar 换成引用,搬的记进 transfers", async () => {
		await placeAvatar(`${EXT_A}.png`, PNG_BYTES);
		await placeRuntime({
			[EXT_A]: {
				cachedProfile: profile(addressOf(EXT_A, PNG_BYTES), { fans: 7 }),
				fansBaseline: { value: 5, ts: "2026-09-01T00:00:00.000Z" },
				roomId: "123",
				followed: true,
			},
		});

		const report = await sandbox.migrate();

		const ref = refOf(PNG_BYTES, "png");
		expect(await readImagesDir()).toEqual([ref]);
		expect(new Uint8Array(await readFile(join(imagesDir(), ref)))).toEqual(
			new Uint8Array(PNG_BYTES),
		);
		// 复制:另一个 inode,新代以后刷新修改时间不会改到第 0 代那份。
		expect((await stat(join(imagesDir(), ref))).ino).not.toBe(
			(await stat(join(sandbox.zero, "avatars", `${EXT_A}.png`))).ino,
		);
		const record = (await readRuntime())[EXT_A];
		expect(record?.cachedProfile).toEqual(
			profile(ref, { fans: 7 }), // avatar 在原位换成引用,别的格一个不动
		);
		expect(record?.cachedProfile).not.toHaveProperty("avatarUrl");
		// 记录里别的东西不碰。
		expect(record).toMatchObject({
			fansBaseline: { value: 5, ts: "2026-09-01T00:00:00.000Z" },
			roomId: "123",
			followed: true,
		});
		expect(report.transfers).toContainEqual({
			from: `avatars/${EXT_A}.png`,
			to: `images/${ref}`,
			method: "copy",
		});
		expect(report.rewritten).toContain("runtime/sub-runtime.json");
		// 头像目录不再整个搬进新代。
		expect(await readdir(join(sandbox.target, "avatars")).catch(() => [])).toEqual([]);
	});

	it("扩展名按嗅探定,不看旧文件名:jpeg 叫 jpg,webp 照旧", async () => {
		await placeAvatar(`${EXT_A}.jpeg`, JPEG_BYTES);
		await placeAvatar(`${EXT_B}.webp`, WEBP_BYTES);
		await placeRuntime({
			[EXT_A]: { cachedProfile: profile(addressOf(EXT_A, JPEG_BYTES)) },
			[EXT_B]: { cachedProfile: profile(addressOf(EXT_B, WEBP_BYTES)) },
		});

		await sandbox.migrate();

		const runtime = await readRuntime();
		expect(runtime[EXT_A]?.cachedProfile?.avatar).toBe(refOf(JPEG_BYTES, "jpg"));
		expect(runtime[EXT_B]?.cachedProfile?.avatar).toBe(refOf(WEBP_BYTES, "webp"));
	});

	it("内容一样的两个订阅在图库里只有一份,两条 transfers 各记自己的旧路径", async () => {
		await placeAvatar(`${EXT_A}.png`, PNG_BYTES);
		await placeAvatar(`${EXT_B}.png`, PNG_BYTES);
		await placeRuntime({
			[EXT_A]: { cachedProfile: profile(addressOf(EXT_A, PNG_BYTES)) },
			[EXT_B]: { cachedProfile: profile(addressOf(EXT_B, PNG_BYTES)) },
		});

		const report = await sandbox.migrate();

		const ref = refOf(PNG_BYTES, "png");
		expect(await readImagesDir()).toEqual([ref]);
		expect(report.transfers.filter((t) => t.to === `images/${ref}`).map((t) => t.from)).toEqual([
			`avatars/${EXT_A}.png`,
			`avatars/${EXT_B}.png`,
		]);
	});

	it("同一个订阅换过类型、两个文件并存:认地址里 ?v= 对得上的那张;都对不上取最新写的", async () => {
		// 0.x 换类型时先写新的、再删旧的,中间崩了两个就并存。
		await placeAvatar(`${EXT_A}.png`, PNG_BYTES);
		await placeAvatar(`${EXT_A}.webp`, WEBP_BYTES);
		await placeAvatar(`${EXT_B}.png`, PNG_BYTES);
		await placeAvatar(`${EXT_B}.webp`, WEBP_BYTES);
		// 两个订阅都是 webp 更新:EXT_A 靠摘要认下 png,EXT_B 摘要对不上、取最新写的 webp。
		const past = new Date("2026-09-01T00:00:00.000Z");
		const later = new Date("2026-09-02T00:00:00.000Z");
		for (const id of [EXT_A, EXT_B]) {
			await utimes(join(sandbox.zero, "avatars", `${id}.png`), past, past);
			await utimes(join(sandbox.zero, "avatars", `${id}.webp`), later, later);
		}
		await placeRuntime({
			// EXT_A:地址里的摘要是 png 的 —— 哪怕 webp 更新也认 png。
			[EXT_A]: { cachedProfile: profile(addressOf(EXT_A, PNG_BYTES)) },
			[EXT_B]: { cachedProfile: profile(`/api/subs/${EXT_B}/avatar?v=000000000000`) },
		});

		const report = await sandbox.migrate();

		const runtime = await readRuntime();
		expect(runtime[EXT_A]?.cachedProfile?.avatar).toBe(refOf(PNG_BYTES, "png"));
		expect(runtime[EXT_B]?.cachedProfile?.avatar).toBe(refOf(WEBP_BYTES, "webp"));
		// 没被认下的那两个文件算没有资料引用的(孤儿)。
		expect(report.skipped).toContainEqual({
			path: "avatars",
			reason: "2 个头像文件没有任何资料引用,没带过来",
		});
	});
});

describe("B 站订阅的头像", () => {
	it("远端网址挪到 avatarUrl,不碰图库;相对协议的 // 也是网址", async () => {
		await placeRuntime({
			[BILI]: { cachedProfile: profile(BILI_URL, { fans: 9 }) },
			b2: { cachedProfile: profile("//i1.hdslb.com/bfs/face/x.jpg") },
		});

		const report = await sandbox.migrate();

		const runtime = await readRuntime();
		expect(runtime[BILI]?.cachedProfile).toEqual({
			name: "某人",
			avatarUrl: BILI_URL,
			sign: "",
			lastRefreshedAt: "2026-09-01T00:00:00.000Z",
			fans: 9,
		});
		expect(runtime[BILI]?.cachedProfile).not.toHaveProperty("avatar");
		expect(runtime.b2?.cachedProfile).toMatchObject({ avatarUrl: "//i1.hdslb.com/bfs/face/x.jpg" });
		expect(await readImagesDir()).toEqual([]);
		expect(report.transfers.some((t) => t.to.startsWith("images/"))).toBe(false);
		expect(report.rewritten).toContain("runtime/sub-runtime.json");
	});
});

describe("没有头像", () => {
	it("空串 → 两格都缺;没有 avatar 这一格的资料原样", async () => {
		await placeRuntime({
			[EXT_A]: { cachedProfile: profile("") },
			[BILI]: {
				cachedProfile: { name: "无头像", sign: "", lastRefreshedAt: "t" },
				fansBaseline: { value: 1, ts: "t" },
			},
			// 只有粉丝基线、没有资料的记录不碰。
			bare: { roomId: "1" },
		});

		await sandbox.migrate();

		const runtime = await readRuntime();
		expect(runtime[EXT_A]?.cachedProfile).toEqual({
			name: "某人",
			sign: "",
			lastRefreshedAt: "2026-09-01T00:00:00.000Z",
		});
		expect(runtime[BILI]?.cachedProfile).toEqual({
			name: "无头像",
			sign: "",
			lastRefreshedAt: "t",
		});
		expect(runtime.bare).toEqual({ roomId: "1" });
	});

	it("什么都不用改的资料缓存不重写(不进 rewritten,还是从第 0 代原样复制过来的那一份)", async () => {
		await placeRuntime({
			[BILI]: { cachedProfile: { name: "无头像", sign: "", lastRefreshedAt: "t" } },
		});

		const report = await sandbox.migrate();

		expect(report.rewritten).not.toContain("runtime/sub-runtime.json");
		expect(await readFile(runtimePath())).toEqual(
			await readFile(join(sandbox.zero, "state", "sub-runtime.json")),
		);
	});

	it("连资料缓存文件都没有、头像目录里却有文件 → 不炸,头像都是孤儿", async () => {
		await placeAvatar(`${EXT_A}.png`, PNG_BYTES);

		const report = await sandbox.migrate();

		expect(await readImagesDir()).toEqual([]);
		expect(report.skipped).toContainEqual({
			path: "avatars",
			reason: "1 个头像文件没有任何资料引用,没带过来",
		});
	});

	it("资料缓存读不成 JSON / 不是对象 → 原样留着(开机时资料缓存仓自己当空的)", async () => {
		await sandbox.placeZeroText("state/sub-runtime.json", "{ not json");

		const report = await sandbox.migrate();

		expect(await readFile(runtimePath(), "utf8")).toBe("{ not json");
		expect(report.rewritten).not.toContain("runtime/sub-runtime.json");
	});
});

describe("带不过来的头像", () => {
	it("没有任何资料引用的头像文件(孤儿)不搬,按数量记一句;临时残留不算孤儿", async () => {
		await placeAvatar(`${EXT_A}.png`, PNG_BYTES);
		await placeAvatar(`${EXT_B}.jpeg`, JPEG_BYTES);
		await placeAvatar(`${BILI}.webp`, WEBP_BYTES);
		await placeAvatar(`${EXT_B}.png.bn-tmp.1.abc`, "half");
		await placeRuntime({ [EXT_A]: { cachedProfile: profile(addressOf(EXT_A, PNG_BYTES)) } });

		const report = await sandbox.migrate();

		expect(await readImagesDir()).toEqual([refOf(PNG_BYTES, "png")]);
		expect(report.skipped).toContainEqual({
			path: "avatars",
			reason: "2 个头像文件没有任何资料引用,没带过来",
		});
	});

	it("被引用却对不上的(文件不在、不是图库收的图、超 8MB、软链、订阅 id 不是干净的文件名)两格都缺,别的原样", async () => {
		const missing = "a0000000-0000-4000-8000-0000000000c1";
		const notImage = "a0000000-0000-4000-8000-0000000000c2";
		const huge = "a0000000-0000-4000-8000-0000000000c3";
		const linked = "a0000000-0000-4000-8000-0000000000c4";
		await placeAvatar(`${EXT_A}.png`, PNG_BYTES);
		await placeAvatar(`${notImage}.png`, "<svg/>");
		const big = new Uint8Array(IMAGE_MAX_BYTES + 1);
		big.set(PNG_BYTES);
		await placeAvatar(`${huge}.png`, big);
		// 软链:不跟,哪怕指向的是一张好图。
		await writeFile(join(sandbox.zero, "outside.png"), PNG_BYTES);
		await mkdir(join(sandbox.zero, "avatars"), { recursive: true });
		await symlink(
			join(sandbox.zero, "outside.png"),
			join(sandbox.zero, "avatars", `${linked}.png`),
		);
		// 路径穿越:订阅 id 是不可信输入(资料缓存里的键),指到头像目录外的一张好图,也不读。
		await writeFile(join(sandbox.zero, "secret.png"), JPEG_BYTES);
		const traversal = "../secret";
		await placeRuntime({
			[EXT_A]: { cachedProfile: profile(addressOf(EXT_A, PNG_BYTES)) },
			[missing]: { cachedProfile: profile(`/api/subs/${missing}/avatar?v=abc`) },
			[notImage]: { cachedProfile: profile(`/api/subs/${notImage}/avatar?v=abc`) },
			[huge]: { cachedProfile: profile(`/api/subs/${huge}/avatar?v=abc`) },
			[linked]: { cachedProfile: profile(`/api/subs/${linked}/avatar?v=abc`) },
			[traversal]: { cachedProfile: profile(`/api/subs/${traversal}/avatar?v=abc`) },
		});

		const report = await sandbox.migrate();

		const ref = refOf(PNG_BYTES, "png");
		expect(await readImagesDir()).toEqual([ref]);
		const runtime = await readRuntime();
		expect(runtime[EXT_A]?.cachedProfile?.avatar).toBe(ref);
		for (const id of [missing, notImage, huge, linked, traversal]) {
			const gone = runtime[id]?.cachedProfile;
			expect(gone, id).toMatchObject({ name: "某人" });
			expect(gone, id).not.toHaveProperty("avatar");
			expect(gone, id).not.toHaveProperty("avatarUrl");
		}
		expect(report.skipped).toContainEqual({
			path: "avatars",
			reason:
				"5 个拓展订阅的头像对不上(文件不在、不是图库收的图、超过 8MB 或路径不对),资料里不再带头像,等拓展下一次报资料再来",
		});
	});

	it("连 avatars 目录都没有、资料却引用着头像 → 都拿掉,不炸,也不建空的 images/", async () => {
		await placeRuntime({ [EXT_A]: { cachedProfile: profile(addressOf(EXT_A, PNG_BYTES)) } });

		await sandbox.migrate();

		expect((await readRuntime())[EXT_A]?.cachedProfile).not.toHaveProperty("avatar");
		expect(await readImagesDir()).toEqual([]);
	});
});

describe("迁出来的新代", () => {
	it("资料缓存仓读得到新代里的引用,listImageRefs 交得出来", async () => {
		await placeAvatar(`${EXT_A}.png`, PNG_BYTES);
		await placeRuntime({
			[EXT_A]: { cachedProfile: profile(addressOf(EXT_A, PNG_BYTES)) },
			[BILI]: { cachedProfile: profile(BILI_URL) },
		});
		await sandbox.migrate();

		const store = createSubRuntimeStore({ dataRoot: sandbox.target, logger: silentLogger });

		expect(await store.listImageRefs()).toEqual([refOf(PNG_BYTES, "png")]);
		expect(store.get(BILI)?.cachedProfile?.avatarUrl).toBe(BILI_URL);
	});

	it("对新代再迁一次什么都不改:已经是图库引用的原样留着,不去第 0 代找", async () => {
		await placeAvatar(`${EXT_A}.png`, PNG_BYTES);
		await placeRuntime({
			[EXT_A]: { cachedProfile: profile(addressOf(EXT_A, PNG_BYTES)) },
			[BILI]: { cachedProfile: profile(BILI_URL) },
		});
		await sandbox.migrate();
		const before = await readFile(runtimePath(), "utf8");

		const again = await migrateProfileAvatars({
			zeroDir: join(sandbox.zero, "avatars"),
			imagesDir: imagesDir(),
			runtimeFile: runtimePath(),
		});

		expect(again.rewritten).toEqual([]);
		expect(again.dropped).toBe(0);
		expect(await readFile(runtimePath(), "utf8")).toBe(before);
	});
});
