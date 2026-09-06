import { initializeApp, getApps, getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, doc, setDoc, addDoc, deleteDoc, collection, onSnapshot,
  runTransaction, serverTimestamp, query, orderBy, where, getDocs, getDoc, writeBatch, increment
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const DEFAULT_SETTINGS = { maxOrderNumber: 30, newOrderThresholdMin: 2, reminderDisplaySec: 30 };
export const PRICE_PER_MEAL = 300; // 1食あたりの価格(円)
export const DAY_RED_THRESHOLD = 545; // その日の累計食数がこれ以上になったら赤文字にする閾値

// 通信が固まった場合に一定時間で諦めてエラーを返すためのラッパー
// (オフライン/電波不良でPromiseが永遠に解決しない事態を防ぐ)
export function withTimeout(promise, ms = 8000, message = "通信がタイムアウトしました。電波状況を確認してもう一度お試しください。") {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

export function getApp_() {
  return getApps().length ? getApp() : initializeApp(firebaseConfig);
}

export function getDb() {
  return getFirestore(getApp_());
}

// ---- 設定 ----
export function watchSettings(db, cb) {
  return onSnapshot(doc(db, "meta", "settings"), (snap) => {
    cb(snap.exists() ? { ...DEFAULT_SETTINGS, ...snap.data() } : DEFAULT_SETTINGS);
  });
}
export async function saveSettings(db, settings) {
  await setDoc(doc(db, "meta", "settings"), settings, { merge: true });
}

// ---- 進行中の注文(輸送/受け渡し用) ----
export function watchActiveOrders(db, cb) {
  return onSnapshot(collection(db, "activeOrders"), (snap) => {
    const list = [];
    snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
    list.sort((a, b) => (a.queueNumber || 0) - (b.queueNumber || 0));
    cb(list);
  });
}

// ---- 催促 ----
export function watchReminder(db, cb) {
  return onSnapshot(doc(db, "meta", "reminder"), (snap) => {
    cb(snap.exists() ? snap.data() : null);
  });
}
export async function sendReminder(db) {
  await setDoc(doc(db, "meta", "reminder"), { triggeredAt: serverTimestamp() });
}

// ---- 開催日(何日目か)の管理 ----
// meta/session の day フィールドで管理。1から始まり、「次の日へ進める」操作でのみ増える。
export async function getCurrentDayOnce(db) {
  const snap = await getDoc(doc(db, "meta", "session"));
  return snap.exists() ? (snap.data().day || 1) : 1;
}

// リアルタイムで現在の日を監視(受付ページなどで使用)
export function watchCurrentDay(db, cb) {
  return onSnapshot(doc(db, "meta", "session"), (snap) => {
    cb(snap.exists() ? (snap.data().day || 1) : 1);
  });
}

// 指定した日の累計食数(受付ページの「本日◯食目」表示用)。
// dayStats/{day} ドキュメントの itemCount フィールドを1回読むだけ(= read 1件)。
// この値は createOrder/cancelOrder の中で increment() によって加算/減算されている。
export async function getDayItemCount(db, day) {
  const snap = await getDoc(doc(db, "dayStats", String(day)));
  return snap.exists() ? (snap.data().itemCount || 0) : 0;
}

// 注文番号(queueState)とその日の履歴番号(counters)だけをリセットし、
// dayを+1する。activeOrders/orderHistoryのデータそのものは一切消さない。
// (→ adminでは日ごとにタグ(day)で絞り込んで確認できる)
export async function startNewDay(db) {
  return await runTransaction(db, async (tx) => {
    const sessionRef = doc(db, "meta", "session");
    const sessionSnap = await tx.get(sessionRef);
    const currentDay = sessionSnap.exists() ? (sessionSnap.data().day || 1) : 1;
    const nextDay = currentDay + 1;

    tx.set(sessionRef, { day: nextDay }, { merge: true });
    tx.set(doc(db, "meta", "queueState"), { slots: [], lastAssigned: 0 });
    tx.set(doc(db, "meta", "counters"), { historyCounter: 0 });

    return nextDay;
  });
}

// ---- 注文作成(トランザクションで空き番号を安全に払い出す) ----
// 「最小の空き番号」ではなく、前回払い出した番号の次から maxOrderNumber まで循環的に探す。
// (同じ番号札を続けて使い回さないようにするため)
export async function createOrder(db, { normal, spicy }, maxOrderNumber) {
  return await runTransaction(db, async (tx) => {
    const queueStateRef = doc(db, "meta", "queueState");
    const counterRef = doc(db, "meta", "counters");
    const sessionRef = doc(db, "meta", "session");
    // 読み取りは先にまとめて行う(Firestoreトランザクションの制約)
    const queueStateSnap = await tx.get(queueStateRef);
    const counterSnap = await tx.get(counterRef);
    const sessionSnap = await tx.get(sessionRef);

    const qsData = queueStateSnap.exists() ? queueStateSnap.data() : {};
    const slots = qsData.slots || [];
    const lastAssigned = qsData.lastAssigned || 0;
    const currentDay = sessionSnap.exists() ? (sessionSnap.data().day || 1) : 1;

    let assigned = -1;
    for (let step = 1; step <= maxOrderNumber; step++) {
      const candidate = ((lastAssigned + step - 1) % maxOrderNumber) + 1; // 1..maxOrderNumberを循環
      if (!slots[candidate - 1]) { assigned = candidate; break; }
    }
    if (assigned === -1) {
      throw new Error("空いている注文番号がありません。設定(⑤)で最大注文番号を増やすか、既存の注文を捌いてください。");
    }
    const newSlots = slots.slice();
    while (newSlots.length < maxOrderNumber) newSlots.push(false);
    newSlots[assigned - 1] = true;

    const nextHistoryId = counterSnap.exists() ? (counterSnap.data().historyCounter || 0) + 1 : 1;

    const activeRef = doc(collection(db, "activeOrders"));
    const historyRef = doc(collection(db, "orderHistory"));

    tx.set(activeRef, {
      queueNumber: assigned, normal, spicy, createdAt: serverTimestamp(), day: currentDay,
      historyDocId: historyRef.id, // 削除(取消)時に履歴側も連動させるためのリンク
    });
    tx.set(historyRef, {
      historyId: nextHistoryId, queueNumber: assigned, normal, spicy, createdAt: serverTimestamp(),
      day: currentDay, canceled: false,
    });
    tx.set(queueStateRef, { slots: newSlots, lastAssigned: assigned }, { merge: true });
    tx.set(counterRef, { historyCounter: nextHistoryId }, { merge: true });
    // その日の累計食数カウンタに加算(全件数え直しを避けるため)
    tx.set(doc(db, "dayStats", String(currentDay)), { itemCount: increment(normal + spicy) }, { merge: true });

    return assigned;
  });
}

// ---- 受け渡し完了(番号を解放) ----
// 戻り値: true=完了処理を実行した / false=既に他の端末で処理済みだった(何もしていない)
export async function completeOrder(db, orderId, queueNumber) {
  return await runTransaction(db, async (tx) => {
    const queueStateRef = doc(db, "meta", "queueState");
    const activeRef = doc(db, "activeOrders", orderId);
    // 先に対象注文がまだ存在するか確認。既に完了/取消済みなら何もしない。
    // (ここを確認しないと、別端末が既に処理済みの番号を、後から届いたリクエストが
    //  誤って解放してしまい、既に再利用された新しい注文の番号まで壊す恐れがある)
    const activeSnap = await tx.get(activeRef);
    if (!activeSnap.exists()) return false;

    const queueStateSnap = await tx.get(queueStateRef);
    const slots = queueStateSnap.exists() ? (queueStateSnap.data().slots || []) : [];
    if (slots[queueNumber - 1] !== undefined) slots[queueNumber - 1] = false;
    tx.delete(activeRef);
    tx.set(queueStateRef, { slots }, { merge: true });
    return true;
  });
}

// ---- 注文取消(番号を解放し、履歴側もcanceled扱いにする。売上から除外される) ----
// 戻り値: true=取消処理を実行した / false=既に他の端末で処理済みだった(何もしていない)
export async function cancelOrder(db, orderId, queueNumber, historyDocId) {
  return await runTransaction(db, async (tx) => {
    const queueStateRef = doc(db, "meta", "queueState");
    const activeRef = doc(db, "activeOrders", orderId);
    const historyRef = historyDocId ? doc(db, "orderHistory", historyDocId) : null;

    // 先に対象注文がまだ存在するか確認(completeOrderと同じ理由)
    const activeSnap = await tx.get(activeRef);
    if (!activeSnap.exists()) return false;

    const queueStateSnap = await tx.get(queueStateRef);
    const historySnap = historyRef ? await tx.get(historyRef) : null;

    const slots = queueStateSnap.exists() ? (queueStateSnap.data().slots || []) : [];
    if (slots[queueNumber - 1] !== undefined) slots[queueNumber - 1] = false;

    tx.delete(activeRef);
    tx.set(queueStateRef, { slots }, { merge: true });
    if (historyRef && historySnap && historySnap.exists()) {
      tx.set(historyRef, { canceled: true, canceledAt: serverTimestamp() }, { merge: true });
    }
    // 取り消した分だけ、その注文が属する日の累計食数カウンタを減算する
    const activeData = activeSnap.data();
    const orderDay = activeData.day || 1;
    const orderItems = (activeData.normal || 0) + (activeData.spicy || 0);
    tx.set(doc(db, "dayStats", String(orderDay)), { itemCount: increment(-orderItems) }, { merge: true });
    return true;
  });
}

// ---- 履歴(admin用、historyId昇順) ----
export async function getHistoryOnce(db) {
  const snap = await getDocs(query(collection(db, "orderHistory"), orderBy("historyId", "asc")));
  const list = [];
  snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
  return list;
}

// 指定した1日分の履歴だけを取得(全件取得を避けるため。admin通常表示ではこちらを使う)
export async function getDayHistoryOnce(db, day) {
  const snap = await getDocs(query(collection(db, "orderHistory"), where("day", "==", day)));
  const list = [];
  snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
  list.sort((a, b) => (a.historyId || 0) - (b.historyId || 0));
  return list;
}

// ---- 進行中の注文の件数だけ取得(リセット前の警告表示用) ----
export async function getActiveOrdersCountOnce(db) {
  const snap = await getDocs(collection(db, "activeOrders"));
  return snap.size;
}

// ---- 指定した日のデータだけ削除(デバッグ用。CSVには出力しない) ----
// 削除対象の日が「現在受付中の日」だった場合は、注文番号カウンタもリセットする。
export async function deleteDayData(db, day) {
  const historySnap = await getDocs(query(collection(db, "orderHistory"), where("day", "==", day)));
  const activeSnap = await getDocs(query(collection(db, "activeOrders"), where("day", "==", day)));

  const batch = writeBatch(db);
  historySnap.forEach((d) => batch.delete(doc(db, "orderHistory", d.id)));
  activeSnap.forEach((d) => batch.delete(doc(db, "activeOrders", d.id)));
  batch.delete(doc(db, "dayStats", String(day)));

  const currentDay = await getCurrentDayOnce(db);
  if (day === currentDay) {
    batch.set(doc(db, "meta", "queueState"), { slots: [], lastAssigned: 0 });
    batch.set(doc(db, "meta", "counters"), { historyCounter: 0 });
  }

  await batch.commit();
  return { deletedHistory: historySnap.size, deletedActive: activeSnap.size };
}

// ---- リセット(CSV出力用データを返してから全消去) ----
export async function resetAll(db) {
  const history = await getHistoryOnce(db);
  const activeSnap = await getDocs(collection(db, "activeOrders"));
  const dayStatsSnap = await getDocs(collection(db, "dayStats"));
  const batch = writeBatch(db);
  history.forEach((h) => batch.delete(doc(db, "orderHistory", h.id)));
  activeSnap.forEach((d) => batch.delete(doc(db, "activeOrders", d.id)));
  dayStatsSnap.forEach((d) => batch.delete(doc(db, "dayStats", d.id)));
  batch.set(doc(db, "meta", "counters"), { historyCounter: 0 });
  batch.set(doc(db, "meta", "queueState"), { slots: [], lastAssigned: 0 });
  batch.set(doc(db, "meta", "session"), { day: 1 });
  await batch.commit();
  return history;
}
