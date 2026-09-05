const Database = require("better-sqlite3");
const path = require("path");
const { PRODUCTS } = require("./products");

// База хранится в папке проекта
const db = new Database(path.join(__dirname, "../data.db"));

// Ускоряем запросы
db.pragma("journal_mode = WAL");

// ─── Создание таблиц ────────────────────────────────────────────────

db.exec(`
  -- Пользователи
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id       INTEGER UNIQUE NOT NULL,
    tg_username TEXT,
    tg_name     TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  -- Статусы продуктов по каждому пользователю
  CREATE TABLE IF NOT EXISTS user_products (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,         -- ссылка на users.id
    product_id   INTEGER NOT NULL,         -- ссылка на products.js (id)
    status       TEXT    DEFAULT 'none',   -- текущий статус
    screenshot   TEXT,                     -- file_id скрина в Telegram
    updated_at   TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, product_id)
  );

  -- Заявки на проверку ЦД (требуют апрув от админа)
  CREATE TABLE IF NOT EXISTS cd_reviews (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,
    product_id   INTEGER NOT NULL,
    screenshot   TEXT NOT NULL,            -- file_id скрина
    window_num   INTEGER NOT NULL,         -- в каком окне подана
    status       TEXT DEFAULT 'pending',   -- pending | approved | rejected
    created_at   TEXT DEFAULT (datetime('now')),
    reviewed_at  TEXT
  );

  -- Заявки на выплату
  CREATE TABLE IF NOT EXISTS payout_requests (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL,
    product_id   INTEGER NOT NULL,
    window_num   INTEGER NOT NULL,         -- в каком окне запросил
    status       TEXT DEFAULT 'pending',   -- pending | paid
    created_at   TEXT DEFAULT (datetime('now')),
    paid_at      TEXT
  );
`);

// ─── Функции для работы с пользователями ────────────────────────────

// Найти или создать пользователя
function upsertUser({ tg_id, tg_username, tg_name }) {
  db.prepare(`
    INSERT INTO users (tg_id, tg_username, tg_name)
    VALUES (@tg_id, @tg_username, @tg_name)
    ON CONFLICT(tg_id) DO UPDATE SET
      tg_username = excluded.tg_username,
      tg_name     = excluded.tg_name
  `).run({ tg_id, tg_username, tg_name });

  return db.prepare("SELECT * FROM users WHERE tg_id = ?").get(tg_id);
}

// Получить пользователя по tg_id
function getUserByTgId(tg_id) {
  return db.prepare("SELECT * FROM users WHERE tg_id = ?").get(tg_id);
}

// Получить всех пользователей
function getAllUsers() {
  return db.prepare("SELECT * FROM users ORDER BY created_at").all();
}

// ─── Функции для продуктов ───────────────────────────────────────────

// Получить все статусы продуктов пользователя
function getUserProducts(user_id) {
  const rows = db.prepare(`
    SELECT * FROM user_products WHERE user_id = ?
  `).all(user_id);

  // Объединяем с полным списком продуктов
  return PRODUCTS.map(p => {
    const row = rows.find(r => r.product_id === p.id);
    return {
      ...p,
      status:     row?.status     || "none",
      screenshot: row?.screenshot || null,
      updated_at: row?.updated_at || null,
    };
  });
}

// Обновить статус продукта
function updateProductStatus({ user_id, product_id, status, screenshot = null }) {
  db.prepare(`
    INSERT INTO user_products (user_id, product_id, status, screenshot, updated_at)
    VALUES (@user_id, @product_id, @status, @screenshot, datetime('now'))
    ON CONFLICT(user_id, product_id) DO UPDATE SET
      status     = excluded.status,
      screenshot = COALESCE(excluded.screenshot, screenshot),
      updated_at = excluded.updated_at
  `).run({ user_id, product_id, status, screenshot });
}

// ─── Функции для ЦД-проверок ─────────────────────────────────────────

// Создать заявку на проверку ЦД
function createCdReview({ user_id, product_id, screenshot, window_num }) {
  return db.prepare(`
    INSERT INTO cd_reviews (user_id, product_id, screenshot, window_num)
    VALUES (@user_id, @product_id, @screenshot, @window_num)
  `).run({ user_id, product_id, screenshot, window_num });
}

// Получить все ожидающие проверки ЦД (для админа)
function getPendingCdReviews() {
  return db.prepare(`
    SELECT r.*, u.tg_username, u.tg_name
    FROM cd_reviews r
    JOIN users u ON u.id = r.user_id
    WHERE r.status = 'pending'
    ORDER BY r.created_at
  `).all();
}

// Подтвердить или отклонить ЦД
function reviewCd({ review_id, status }) {
  db.prepare(`
    UPDATE cd_reviews
    SET status = @status, reviewed_at = datetime('now')
    WHERE id = @review_id
  `).run({ review_id, status });

  return db.prepare("SELECT * FROM cd_reviews WHERE id = ?").get(review_id);
}

// ─── Функции для выплат ──────────────────────────────────────────────

// Создать заявку на выплату
function createPayoutRequest({ user_id, product_id, window_num }) {
  // Проверяем, нет ли уже заявки на этот продукт в этом окне
  const existing = db.prepare(`
    SELECT * FROM payout_requests
    WHERE user_id = @user_id AND product_id = @product_id AND window_num = @window_num
  `).get({ user_id, product_id, window_num });

  if (existing) return existing;

  db.prepare(`
    INSERT INTO payout_requests (user_id, product_id, window_num)
    VALUES (@user_id, @product_id, @window_num)
  `).run({ user_id, product_id, window_num });
}

// Получить все заявки на выплату за окно (для админа)
function getPayoutsByWindow(window_num) {
  return db.prepare(`
    SELECT pr.*, u.tg_username, u.tg_name
    FROM payout_requests pr
    JOIN users u ON u.id = pr.user_id
    WHERE pr.window_num = @window_num
    ORDER BY u.tg_name
  `).all({ window_num });
}

// Отметить выплату как выплаченную
function markPaid({ request_id }) {
  db.prepare(`
    UPDATE payout_requests
    SET status = 'paid', paid_at = datetime('now')
    WHERE id = @request_id
  `).run({ request_id });
}

module.exports = {
  upsertUser, getUserByTgId, getAllUsers,
  getUserProducts, updateProductStatus,
  createCdReview, getPendingCdReviews, reviewCd,
  createPayoutRequest, getPayoutsByWindow, markPaid,
};
