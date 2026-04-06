export interface EncryptedFile {
	iv: string;
	data: string;
}

export interface StoredCookies {
	cookiesJson: EncryptedFile;
	refreshToken?: EncryptedFile;
}
