import QRCode from "qrcode";

/**
 * 扫码登录假状态用的二维码:一张**真能扫**的码,扫出来是一句「这是 devtools 的假货」。
 *
 * 走 `qrcode` 包 —— 它本来就是 server 的依赖(扫码建 bot 与真登录流程都用它),真登录的
 * 二维码也是同一个包的 PNG 产物,面板那头的 <img> 走的是完全相同的路。此前手工拼过一份
 * PNG(CRC32 + zlib + chunk 布局七十来行),理由是「不值得为它进一个依赖」—— 依赖早就在了。
 */
const FAKE_QR_TEXT = "bilibili-notify devtools 的假二维码:扫了也登不上,只是占个位。";

export function fakeQrDataUrl(): Promise<string> {
	return QRCode.toDataURL(FAKE_QR_TEXT, { errorCorrectionLevel: "M", margin: 1, width: 174 });
}
