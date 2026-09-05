const express = require("express");
const path    = require("path");
const db      = require("./db");
const { PRODUCTS } = require("./products");
const { getCurrentWindow, formatWindowRange } = require("./windows");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// ─── API для мини-апки ───────────────────────────────────────────────

// Получить данные текущего пользователя и его продукты
// Telegram передаёт initData при открытии мини-апки
app.post("/api/user", (req, res) => {
  const { tg_id, tg_username, tg_name } = req.body;

  if (!tg_id) return res.status(400).json({ error: "Нет tg_id" });

  // Регистрируем или обновляем пользователя
  const user = db.upsertUser({ tg_id, tg_username, tg_name });

  // Получаем его продукты
  const products = db.getUserProducts(user.id);

  // Текущее окно
  const win = getCurrentWindow();

  res.json({
    user,
    products,
    window: {
      number: win.number,
      range:  formatWindowRange(win.number),
      end:    win.end.toISOString(),
    },
  });
});

// Обновить статус продукта
app.post("/api/product/status", (req, res) => {
  const { tg_id, product_id, status } = req.body;

  const user = db.getUserByTgId(tg_id);
  if (!user) return res.status(404).json({ error: "Пользователь не найден" });

  db.updateProductStatus({ user_id: user.id, product_id, status });

  res.json({ ok: true });
});

// Запросить выплату
app.post("/api/payout/request", (req, res) => {
  const { tg_id, product_id } = req.body;

  const user = db.getUserByTgId(tg_id);
  if (!user) return res.status(404).json({ error: "Пользователь не найден" });

  const win = getCurrentWindow();

  db.createPayoutRequest({
    user_id:    user.id,
    product_id,
    window_num: win.number,
  });

  db.updateProductStatus({
    user_id:    user.id,
    product_id,
    status:     "payout_requested",
  });

  res.json({
    ok:     true,
    window: formatWindowRange(win.number),
  });
});

// ─── Админ API ───────────────────────────────────────────────────────

// Проверка: является ли пользователь админом
app.get("/api/admin/check/:tg_id", (req, res) => {
  const isAdmin = parseInt(req.params.tg_id) === parseInt(process.env.ADMIN_ID);
  res.json({ isAdmin });
});

// Все пользователи и их продукты (для админа)
app.get("/api/admin/users/:tg_id", (req, res) => {
  if (parseInt(req.params.tg_id) !== parseInt(process.env.ADMIN_ID)) {
    return res.status(403).json({ error: "Нет доступа" });
  }

  const users = db.getAllUsers().map(u => ({
    ...u,
    products: db.getUserProducts(u.id),
  }));

  res.json({ users });
});

// Заявки на выплату за текущее окно (для админа)
app.get("/api/admin/payouts/:tg_id", (req, res) => {
  if (parseInt(req.params.tg_id) !== parseInt(process.env.ADMIN_ID)) {
    return res.status(403).json({ error: "Нет доступа" });
  }

  const win     = getCurrentWindow();
  const payouts = db.getPayoutsByWindow(win.number);

  res.json({
    window:  { number: win.number, range: formatWindowRange(win.number) },
    payouts,
  });
});

// Отметить выплату как выплаченную (для админа)
app.post("/api/admin/pay", (req, res) => {
  const { tg_id, request_id } = req.body;

  if (parseInt(tg_id) !== parseInt(process.env.ADMIN_ID)) {
    return res.status(403).json({ error: "Нет доступа" });
  }

  db.markPaid({ request_id });
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`🌐 Сервер запущен на порту ${PORT}`);
});

module.exports = app;
