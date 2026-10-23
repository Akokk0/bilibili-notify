import { fail, ok, type Source } from "@bilibili-notify/internal";

/** 测试里凑一个 `Source` / `SourceView` 字面量时给 `searchCreators` 用的桩:谁也搜不到。 */
export const noCandidates: Source["searchCreators"] = async () => ok({ candidates: [] });

/** 测试里凑一个 `Source` / `SourceView` 字面量时给 `fetchProfile` 用的桩:固定查不到。 */
export const noProfile: Source["fetchProfile"] = async () => fail("not_found", "没有资料");
