import { describe, expect, it } from "vite-plus/test";
import { MIME_TO_EXT, UPLOAD_EXT_TO_MIME } from "../image-mime.js";

describe("UPLOAD_EXT_TO_MIME", () => {
	it("恰好是站内上传收的那几种:png / jpg / jpeg / webp,没有 gif 与 svg", () => {
		expect(Object.keys(UPLOAD_EXT_TO_MIME).sort()).toEqual(["jpeg", "jpg", "png", "webp"]);
		expect(UPLOAD_EXT_TO_MIME.jpg).toBe("image/jpeg");
		expect(UPLOAD_EXT_TO_MIME.jpeg).toBe("image/jpeg");
	});

	it("每个后缀的 mime 都是上传那侧收的 mime —— 存得进去的一定读得出来", () => {
		for (const mime of Object.values(UPLOAD_EXT_TO_MIME)) {
			expect(Object.hasOwn(MIME_TO_EXT, mime), mime).toBe(true);
		}
	});
});
