// ============================================================
// crypto.js — AES-256-GCM encryption for credentials
// ============================================================

const crypto = require("crypto");

const ALGORITHM  = "aes-256-gcm";
const IV_LENGTH  = 16;
const TAG_LENGTH = 16;

// ENCRYPTION_KEY must be exactly 32 bytes (256 bits) in hex (64 hex chars)
// Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
function getKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error("ENCRYPTION_KEY must be set as a 64-character hex string in .env");
  }
  return Buffer.from(hex, "hex");
}

/**
 * Encrypt plaintext string.
 * Returns: iv:authTag:ciphertext (all hex)
 */
function encrypt(plaintext) {
  const key = getKey();
  const iv  = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("hex"), tag.toString("hex"), encrypted.toString("hex")].join(":");
}

/**
 * Decrypt string produced by encrypt().
 */
function decrypt(encoded) {
  const key = getKey();
  const [ivHex, tagHex, ciphertextHex] = encoded.split(":");
  const iv         = Buffer.from(ivHex, "hex");
  const tag        = Buffer.from(tagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");
  const decipher   = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

module.exports = { encrypt, decrypt };
