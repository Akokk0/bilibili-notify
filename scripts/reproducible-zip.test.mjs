import { createHash } from "node:crypto";
import { strToU8 } from "fflate";
import { describe, expect, it } from "vite-plus/test";
import {
	digestOf,
	EXTENSION_ZIP_EPOCH,
	PAYLOAD_ZIP_EPOCH,
	reproducibleZip,
} from "./reproducible-zip.mjs";

/**
 * 这两条不是「测函数返回什么」,而是**把已经发出去的那些包的字节钉住**:两个 epoch 各自
 * 的值早就烧进了线上包的 sha256 里,换掉任何一个(或者把两个统一成一个),重跑那条老 tag
 * 打出来的字节就和当初发出去的不一样 —— 而流水线全绿。所以这里写死摘要:动了就红。
 */
describe("可复现的 zip", () => {
	const files = { "a.txt": strToU8("bilibili-notify") };

	it("拓展包那条链的 epoch 不许动", () => {
		expect(digestOf(reproducibleZip(files, EXTENSION_ZIP_EPOCH))).toEqual({
			sha256: "ad14c35bd74f6996d65fe59069c1123223451eb0c8f7de770851a17e38e91dba",
			size: 122,
		});
	});

	it("升级载荷那条链的 epoch 不许动,而且与拓展包那份**不是**同一个", () => {
		expect(digestOf(reproducibleZip(files, PAYLOAD_ZIP_EPOCH))).toEqual({
			sha256: "5e24801f4f39cae726193726a94a383e27b87a90b354fd92cb7259b4605cfaf3",
			size: 122,
		});
	});
});

/**
 * fflate 写 DOS 时间用的是 `getHours()` 这一族**本地时区**取值 —— 同一个 epoch 在 UTC 的
 * CI 机上和东八区的开发机上打出来的字节不一样,而「可复现」承诺的正是相反的事。上面钉的
 * 摘要以 CI(UTC)打出来的为准,因为发出去的包都是它打的;这里再换两个时区各打一次。
 */
describe("换时区打出来的字节不变", () => {
	const files = { "a.txt": strToU8("bilibili-notify") };
	const inZone = (tz, fn) => {
		const before = process.env.TZ;
		process.env.TZ = tz;
		try {
			return fn();
		} finally {
			if (before === undefined) delete process.env.TZ;
			else process.env.TZ = before;
		}
	};

	it.each(["UTC", "Asia/Shanghai", "America/Los_Angeles"])("%s", (tz) => {
		const [ext, payload] = inZone(tz, () => [
			digestOf(reproducibleZip(files, EXTENSION_ZIP_EPOCH)).sha256,
			digestOf(reproducibleZip(files, PAYLOAD_ZIP_EPOCH)).sha256,
		]);
		expect(ext).toBe("ad14c35bd74f6996d65fe59069c1123223451eb0c8f7de770851a17e38e91dba");
		// 1980-01-01T00:00Z 在西半球的本地日期还是 1979 —— DOS 时间从 1980 起算,那一档
		// 直接写出负的年份;这条在洛杉矶那一格红过。
		expect(payload).toBe("5e24801f4f39cae726193726a94a383e27b87a90b354fd92cb7259b4605cfaf3");
	});
});

describe("digestOf", () => {
	it("就是这份字节的 sha256 与长度 —— 清单 / 索引直接拿去用", () => {
		const bytes = new Uint8Array([1, 2, 3, 4, 5]);
		expect(digestOf(bytes)).toEqual({
			sha256: createHash("sha256").update(bytes).digest("hex"),
			size: 5,
		});
	});
});
