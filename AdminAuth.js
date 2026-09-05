// devtoolsで平文パスワードを見られないようにするためのSHA-256照合。
// ブラウザ標準の Web Crypto API (crypto.subtle) を使用。node不要、GitHub Pages(https)で動作します。
// 注意: これもUX上のゲートです。真の保護はFirestore Security Rules側で行ってください
// (adminのみが書ける/読めるコレクションがあるなら、rules側でも制御を検討してください)。

const ADMIN_PASSWORD_HASH =
  "c5b3f7e19a43b15c41bc0cb6a8b39506829c7f47aa5c936e80677f6addebcf28"; // "Fes31" のSHA-256

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
