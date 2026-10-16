import { ok, type Source } from "@bilibili-notify/internal";

/** 测试里凑一个 `Source` / `SourceView` 字面量时给 `searchCreators` 用的桩:谁也搜不到。 */
export const noCandidates: Source["searchCreators"] = async () => ok({ candidates: [] });
