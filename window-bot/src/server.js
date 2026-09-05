const express = require("express");
const multer  = require("multer");
const path    = require("path");
const db      = require("./db");
const { PRODUCTS } = require("./products");
const { getCurrentWindow, formatWindowRange } = require("./windows");

const app    = express();
const PORT   = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// ─── Утилита: отправить фото админу через Telegram API ───────────────
async function sendPhotoToAdmin(buffer, filename, caption, replyMarkup = null) {
  const formData = new FormData();
  formData.set("chat_id", process.env.ADMIN_ID);
  formData.set("caption", caption);
  formData.set("parse_mode", "HTML");
  formData.set("photo", new Blob([buffer], { type: "image/jpeg" }), filename || "screenshot.jpg");
  if (replyMarkup) formData.set("reply_markup", JSON.stringify(replyMarkup));

  const res = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendPhoto`, {
    method: "POST", body: formData,
  });
  return res.json();
}

// Утилита: отправить текст админу
async function sendTextToAdmin(text) {
  await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: process.env.ADMIN_ID, text, parse_mode: "HTML" }),
  });
}

// Утилита: отправить текст в группу (если GROUP_ID задан)
async function sendTextToGroup(text) {
  if (!process.env.GROUP_ID) return;
  const body = {
    chat_id:    process.env.GROUP_ID,
    text,
    parse_mode: "HTML",
  };
  if (process.env.GROUP_THREAD_ID) body.message_thread_id = parseInt(process.env.GROUP_THREAD_ID);

  await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Утилита: отправить фото в группу
async function sendPhotoToGroup(buffer, filename, caption) {
  if (!process.env.GROUP_ID) return;
  const formData = new FormData();
  formData.set("chat_id", process.env.GROUP_ID);
  formData.set("caption", caption);
  formData.set("parse_mode", "HTML");
  formData.set("photo", new Blob([buffer], { type: "image/jpeg" }), filename || "screenshot.jpg");
  if (process.env.GROUP_THREAD_ID) formData.set("message_thread_id", process.env.GROUP_THREAD_ID);
  await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendPhoto`, { method: "POST", body: formData });
}

// ─── Загрузка данных пользователя ────────────────────────────────────
app.post("/api/user", (req, res) => {
  const { tg_id, tg_username, tg_name } = req.body;
  if (!tg_id) return res.status(400).json({ error: "Нет tg_id" });

  const user     = db.upsertUser({ tg_id, tg_username, tg_name });
  const products = db.getUserProducts(user.id);
  const win      = getCurrentWindow();

  res.json({
    user,
    products,
    window: { number: win.number, range: formatWindowRange(win.number), end: win.end.toISOString() },
  });
});

// ─── Онбординг: сохранить какие продукты уже есть ────────────────────
app.post("/api/onboard", (req, res) => {
  const { tg_id, owned_product_ids } = req.body;
  const user = db.getUserByTgId(tg_id);
  if (!user) return res.status(404).json({ error: "Пользователь не найден" });

  db.onboardUser({ user_id: user.id, owned_product_ids: owned_product_ids || [] });
  res.json({ ok: true });
});

// ─── Обновить статус без фото (заявка, карта) ────────────────────────
app.post("/api/status", (req, res) => {
  const { tg_id, product_id, status } = req.body;
  const user = db.getUserByTgId(tg_id);
  if (!user) return res.status(404).json({ error: "Пользователь не найден" });

  const product = PRODUCTS.find(p => p.id === parseInt(product_id));
  db.updateProductStatus({ user_id: user.id, product_id: parseInt(product_id), status });

  // Уведомляем админа и группу
  const labels = { applied: "📝 Оформил заявку", received: "💳 Получил карту", declined: "❌ Отказ банка" };
  if (labels[status] && product) {
    const text = `${labels[status]}\n👤 <b>${user.tg_name}</b> (@${user.tg_username || "—"})\n📦 ${product.category} ${product.name}`;
    sendTextToAdmin(text);
    sendTextToGroup(text);
  }

  res.json({ ok: true });
});

// ─── Загрузить скрин заявки или карты (без апрува, только уведомление) ─
app.post("/api/upload-step", upload.single("file"), async (req, res) => {
  const { tg_id, product_id, status } = req.body;
  const user = db.getUserByTgId(parseInt(tg_id));
  if (!user) return res.status(404).json({ error: "Пользователь не найден" });

  const product = PRODUCTS.find(p => p.id === parseInt(product_id));
  db.updateProductStatus({ user_id: user.id, product_id: parseInt(product_id), status });

  const labels = { applied: "📝 Заявка оформлена", received: "💳 Карта получена" };
  const caption = `${labels[status] || status}\n👤 ${user.tg_name} (@${user.tg_username || "—"})\n📦 ${product?.category} ${product?.name}`;

  // Фото — только админу
  await sendPhotoToAdmin(req.file.buffer, req.file.originalname, caption);
  // В группу — текст (фото с thread_id иногда не пропускает Telegram)
  await sendTextToGroup(caption);

  res.json({ ok: true });
});

// ─── Загрузить скрин ЦД (требует фото + апрув от админа) ─────────────
app.post("/api/upload-cd", upload.single("file"), async (req, res) => {
  const { tg_id, product_id } = req.body;
  const user = db.getUserByTgId(parseInt(tg_id));
  if (!user) return res.status(404).json({ error: "Пользователь не найден" });

  const product = PRODUCTS.find(p => p.id === parseInt(product_id));
  const win     = getCurrentWindow();

  // Ставим статус "на проверке"
  db.updateProductStatus({ user_id: user.id, product_id: parseInt(product_id), status: "cd_pending" });

  // Создаём запись на проверку
  const review   = db.createCdReview({
    user_id:    user.id,
    product_id: parseInt(product_id),
    screenshot: "uploaded",
    window_num: win.number,
  });
  const reviewId = review.lastInsertRowid;

  // Кнопки апрув/отклонить для админа
  const keyboard = {
    inline_keyboard: [[
      { text: "✅ Подтвердить", callback_data: `cd_approve:${reviewId}` },
      { text: "❌ Отклонить",   callback_data: `cd_reject:${reviewId}` },
    ]],
  };

  const caption =
    `🔍 <b>Проверка ЦД</b>\n\n` +
    `👤 ${user.tg_name} (@${user.tg_username || "—"})\n` +
    `📦 ${product?.category} ${product?.name}\n` +
    `📅 Окно #${win.number} (${formatWindowRange(win.number)})`;

  await sendPhotoToAdmin(req.file.buffer, req.file.originalname, caption, keyboard);
  // В группу — текст что ЦД на проверке
  await sendTextToGroup(
    `🕐 <b>ЦД на проверке</b>\n👤 ${user.tg_name} (@${user.tg_username || "—"})\n📦 ${product?.category} ${product?.name}`
  );

  res.json({ ok: true });
});

// ─── Запросить выплату ───────────────────────────────────────────────
app.post("/api/payout", (req, res) => {
  const { tg_id, product_id } = req.body;
  const user = db.getUserByTgId(tg_id);
  if (!user) return res.status(404).json({ error: "Пользователь не найден" });

  const product = PRODUCTS.find(p => p.id === parseInt(product_id));
  const win     = getCurrentWindow();

  db.createPayoutRequest({ user_id: user.id, product_id: parseInt(product_id), window_num: win.number });
  db.updateProductStatus({ user_id: user.id, product_id: parseInt(product_id), status: "payout_requested" });

  const payoutText = `💰 <b>Запрос выплаты</b>\n👤 ${user.tg_name} (@${user.tg_username || "—"})\n📦 ${product?.category} ${product?.name}\n📅 Окно #${win.number}`;
  sendTextToAdmin(payoutText);
  sendTextToGroup(payoutText);

  res.json({ ok: true, window: formatWindowRange(win.number) });
});

// ─── Админ: проверка доступа ─────────────────────────────────────────
app.get("/api/admin/check/:tg_id", (req, res) => {
  res.json({ isAdmin: parseInt(req.params.tg_id) === parseInt(process.env.ADMIN_ID) });
});

app.get("/api/admin/users/:tg_id", (req, res) => {
  if (parseInt(req.params.tg_id) !== parseInt(process.env.ADMIN_ID))
    return res.status(403).json({ error: "Нет доступа" });
  const users = db.getAllUsers().map(u => ({ ...u, products: db.getUserProducts(u.id) }));
  res.json({ users });
});

app.get("/api/admin/payouts/:tg_id", (req, res) => {
  if (parseInt(req.params.tg_id) !== parseInt(process.env.ADMIN_ID))
    return res.status(403).json({ error: "Нет доступа" });
  const win     = getCurrentWindow();
  const payouts = db.getPayoutsByWindow(win.number);
  res.json({ window: { number: win.number, range: formatWindowRange(win.number) }, payouts });
});

app.post("/api/admin/pay", (req, res) => {
  if (parseInt(req.body.tg_id) !== parseInt(process.env.ADMIN_ID))
    return res.status(403).json({ error: "Нет доступа" });
  db.markPaid({ request_id: req.body.request_id });
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`🌐 Сервер на порту ${PORT}`));
module.exports = app;
