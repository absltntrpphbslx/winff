const Database = require("better-sqlite3");
const path = require("path");
const { PRODUCTS } = require("./products");

const db = new Database(path.join(__dirname, "../data.db"));
db.pragma("journal_mode = WAL");

// ─── Таблицы ─────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id         INTEGER UNIQUE NOT NULL,
    tg_username   TEXT,
    tg_name       TEXT,
    is_onboarded  INTEGER DEFAULT 0,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_products (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    product_id  INTEGER NOT NULL,
    status      TEXT DEFAULT 'none',
    updated_at  TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, product_id)
  );

  CREATE TABLE IF NOT EXISTS cd_reviews (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    product_id  INTEGER NOT NULL,
    screenshot  TEXT NOT NULL,
    window_num  INTEGER NOT NULL,
    status      TEXT DEFAULT 'pending',
    created_at  TEXT DEFAULT (datetime('now')),
    reviewed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS payout_requests (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    product_id  INTEGER NOT NULL,
    window_num  INTEGER NOT NULL,
    status      TEXT DEFAULT 'pending',
    created_at  TEXT DEFAULT (datetime('now')),
    paid_at     TEXT
  );
`);

// Миграция: добавляем is_onboarded если база старая
try { db.exec(`ALTER TABLE users ADD COLUMN is_onboarded INTEGER DEFAULT 0`); } catch {}

// ─── Пользователи ────────────────────────────────────────────────────

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

function getUserByTgId(tg_id) {
  return db.prepare("SELECT * FROM users WHERE tg_id = ?").get(tg_id);
}

function getAllUsers() {
  return db.prepare("SELECT * FROM users ORDER BY created_at").all();
}

// Онбординг: отметить какие продукты уже есть + пометить пользователя
function onboardUser({ user_id, owned_product_ids }) {
  const setOwned = db.prepare(`
    INSERT INTO user_products (user_id, product_id, status)
    VALUES (@user_id, @product_id, 'owned')
    ON CONFLICT(user_id, product_id) DO UPDATE SET status = 'owned'
  `);
  const finish = db.prepare(`UPDATE users SET is_onboarded = 1 WHERE id = ?`);

  db.transaction(() => {
    for (const product_id of owned_product_ids) {
      setOwned.run({ user_id, product_id });
    }
    finish.run(user_id);
  })();
}

// ─── Продукты ────────────────────────────────────────────────────────

function getUserProducts(user_id) {
  const rows = db.prepare(`SELECT * FROM user_products WHERE user_id = ?`).all(user_id);
  return PRODUCTS.map(p => {
    const row = rows.find(r => r.product_id === p.id);
    return { ...p, status: row?.status || "none", updated_at: row?.updated_at || null };
  });
}

function updateProductStatus({ user_id, product_id, status }) {
  db.prepare(`
    INSERT INTO user_products (user_id, product_id, status, updated_at)
    VALUES (@user_id, @product_id, @status, datetime('now'))
    ON CONFLICT(user_id, product_id) DO UPDATE SET
      status = excluded.status, updated_at = excluded.updated_at
  `).run({ user_id, product_id, status });
}

// ─── ЦД-проверки ─────────────────────────────────────────────────────

function createCdReview({ user_id, product_id, screenshot, window_num }) {
  return db.prepare(`
    INSERT INTO cd_reviews (user_id, product_id, screenshot, window_num)
    VALUES (@user_id, @product_id, @screenshot, @window_num)
  `).run({ user_id, product_id, screenshot, window_num });
}

function getPendingCdReviews() {
  return db.prepare(`
    SELECT r.*, u.tg_username, u.tg_name
    FROM cd_reviews r JOIN users u ON u.id = r.user_id
    WHERE r.status = 'pending' ORDER BY r.created_at
  `).all();
}

function reviewCd({ review_id, status }) {
  db.prepare(`
    UPDATE cd_reviews SET status = @status, reviewed_at = datetime('now') WHERE id = @review_id
  `).run({ review_id, status });
  return db.prepare("SELECT * FROM cd_reviews WHERE id = ?").get(review_id);
}

// ─── Выплаты ─────────────────────────────────────────────────────────

function createPayoutRequest({ user_id, product_id, window_num }) {
  const existing = db.prepare(`
    SELECT * FROM payout_requests WHERE user_id=@user_id AND product_id=@product_id AND window_num=@window_num
  `).get({ user_id, product_id, window_num });
  if (existing) return existing;
  return db.prepare(`
    INSERT INTO payout_requests (user_id, product_id, window_num) VALUES (@user_id, @product_id, @window_num)
  `).run({ user_id, product_id, window_num });
}

function getPayoutsByWindow(window_num) {
  return db.prepare(`
    SELECT pr.*, u.tg_username, u.tg_name
    FROM payout_requests pr JOIN users u ON u.id = pr.user_id
    WHERE pr.window_num = @window_num ORDER BY u.tg_name
  `).all({ window_num });
}

function markPaid({ request_id }) {
  db.prepare(`UPDATE payout_requests SET status='paid', paid_at=datetime('now') WHERE id=@request_id`).run({ request_id });
}

module.exports = {
  upsertUser, getUserByTgId, getAllUsers, onboardUser,
  getUserProducts, updateProductStatus,
  createCdReview, getPendingCdReviews, reviewCd,
  createPayoutRequest, getPayoutsByWindow, markPaid,
};
