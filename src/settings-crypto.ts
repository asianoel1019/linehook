import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/** 加密後的設定信封（單一 JSON 物件，可直接存檔 / 傳輸）。 */
export interface EncryptedEnvelope {
  v: 1;
  enc: "aes-256-gcm";
  kdf: "scrypt";
  salt: string;
  iv: string;
  tag: string;
  data: string;
}

const KEY_LEN = 32;
const IV_LEN = 12;
const SALT_LEN = 16;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 } as const;

function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, KEY_LEN, SCRYPT_OPTS);
}

/** 將任意可序列化物件以密碼加密成信封。 */
export function encryptSettings(payload: unknown, password: string): EncryptedEnvelope {
  if (!password) throw new Error("匯出密碼不可為空");
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(password, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    enc: "aes-256-gcm",
    kdf: "scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: data.toString("base64"),
  };
}

/** 判斷是否為本系統的加密信封。 */
export function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  if (!value || typeof value !== "object") return false;
  const e = value as Partial<EncryptedEnvelope>;
  return e.enc === "aes-256-gcm" && typeof e.salt === "string" && typeof e.iv === "string"
    && typeof e.tag === "string" && typeof e.data === "string";
}

/** 以密碼解密信封，回傳原始物件；密碼錯誤或資料竄改會丟錯。 */
export function decryptSettings(envelope: EncryptedEnvelope, password: string): unknown {
  const salt = Buffer.from(envelope.salt, "base64");
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  const data = Buffer.from(envelope.data, "base64");
  const key = deriveKey(password, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as unknown;
}
