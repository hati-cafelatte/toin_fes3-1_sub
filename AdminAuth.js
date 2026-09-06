const ADMIN_PASSWORD_HASH =
  "c5b3f7e19a43b15c41bc0cb6a8b39506829c7f47aa5c936e80677f6addebcf28";

export async function sha256Hex(text) {
  const enc = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function checkAdminPassword(inputPassword) {
  const hash = await sha256Hex(inputPassword);
  return hash === ADMIN_PASSWORD_HASH;
}
