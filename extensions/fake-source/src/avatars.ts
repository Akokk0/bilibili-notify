/**
 * 假头像:四张 64×64 纯色 png,各一百来字节。
 *
 * 必须是**真的 png**:`ctx.storeImage` 按内容嗅探,认不出位图就回 `invalid`(图库只收位图,不收 SVG,
 * ADR-0019 决策 49)。一次性生成好贴在这里 —— 拓展包旁边没有 node_modules,也没必要为几张色块在运行时
 * 现编码。这里存的是 data URL 原文,出口 {@link FAKE_AVATARS} 是解出来的字节,交给 `storeImage` 存成图库引用。
 */
const AVATAR_URLS: readonly string[] = [
	// teal #14b8a6
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAUElEQVR42u3PQQkAAAgEsAth/6cZjGcE38JgBZaafi0CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApcFwfUhWhBJI9UAAAAASUVORK5CYII=",
	// amber #f59e0b
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PMQ0AAAgDsP34f3HJjwRukiY10EzXaxEQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQuCxmweF4NID8QAAAAABJRU5ErkJggg==",
	// rose #f43f5e
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAUElEQVR42u3PQQkAAAgEsGtmE/sHMIARfAuDFVim+rUICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICFwWAGEReKYdWCsAAAAASUVORK5CYII=",
	// indigo #6366f1
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAATklEQVR42u3PQQkAAAgEsOsq2N8GRvAtDFZgqZ7XIiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwWV7OoZaC+o1lAAAAAElFTkSuQmCC",
];

/**
 * 「报资料」轮着换的另四张(同样 64×64 纯色 png)—— 与上面那四张**不重样**:订阅是拿解析门候选的头像
 * 建的,报资料若也从那四张里挑,第一下可能恰好是同一张,宿主摘要一样不覆盖,主人看着像「头像没换」。
 */
const PROFILE_AVATAR_URLS: readonly string[] = [
	// sky #0ea5e9
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAUElEQVR42u3PQQkAAAgEsEtg/wKGs4URfAuDFViq57UICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICFwW59LBeEtKdBAAAAAASUVORK5CYII=",
	// lime #84cc16
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PQQkAAAgEsEthYuMZygi+hcEKLD31WgQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQELguzbmFLSFzrtwAAAABJRU5ErkJggg==",
	// violet #8b5cf6
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PQQkAAAgEsAtqI/v6NoJvYbACS9e8FgEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGBywKms9G0d9zivQAAAABJRU5ErkJggg==",
	// orange #f97316
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAT0lEQVR42u3PQQkAAAgEsEthUdP7M4JvYbACy3S9FgEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGBywJ9TCFpNWCOBAAAAABJRU5ErkJggg==",
];

/** data URL → 字节。 */
const bytesOf = (url: string) =>
	new Uint8Array(Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));

/** 四张假头像的字节 —— 解析门候选头像、作品图与封面从这里轮着取。 */
export const FAKE_AVATARS: readonly Uint8Array[] = AVATAR_URLS.map(bytesOf);

/** 报资料的四张头像的字节。 */
export const FAKE_PROFILE_AVATARS: readonly Uint8Array[] = PROFILE_AVATAR_URLS.map(bytesOf);
