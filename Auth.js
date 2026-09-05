import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// 許可するメールドメイン
const ALLOWED_DOMAIN = "sgh-tsukuba.org";

// 注意: これはUX上のゲート(見た目の制御)であり、真のアクセス制御ではありません。
// 実際のデータ保護は Firestore セキュリティルール側(README参照)で行われます。
// devtoolsでこのスクリプトを無効化されても、ルール側で弾かれるため安全です。
export function requireAuth(app, { onReady } = {}) {
  const auth = getAuth(app);
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ hd: ALLOWED_DOMAIN });

  const gate = document.createElement("div");
  gate.className = "overlay";
  gate.id = "auth-gate";
  gate.innerHTML = `
    <h2>食販システム</h2>
    <p id="auth-msg">サインインしてください</p>
    <button class="btn" id="auth-signin-btn" style="width:auto;padding:14px 28px;">Googleでサインイン</button>
  `;
  document.body.appendChild(gate);

  document.getElementById("auth-signin-btn").onclick = () => {
    document.getElementById("auth-msg").textContent = "サインイン中...";
    signInWithPopup(auth, provider).catch((e) => {
      document.getElementById("auth-msg").textContent =
        "サインインに失敗しました: " + e.message;
    });
  };

  onAuthStateChanged(auth, (user) => {
    if (!user) {
      gate.style.display = "flex";
      return;
    }
    const email = user.email || "";
    if (!email.toLowerCase().endsWith("@" + ALLOWED_DOMAIN)) {
      document.getElementById("auth-msg").textContent =
        `このアカウント (${email}) は利用できません。@${ALLOWED_DOMAIN} のアカウントでサインインし直してください。`;
      document.getElementById("auth-signin-btn").textContent = "別のアカウントでサインイン";
      gate.style.display = "flex";
      signOut(auth);
      return;
    }
    gate.style.display = "none";
    if (onReady) onReady(user);
  });

  return auth;
}
