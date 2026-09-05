require("dotenv").config();
const { Bot, InlineKeyboard } = require("grammy");
const db = require("./db");
const { PRODUCTS, STATUSES } = require("./products");
const { getCurrentWindow, formatWindowRange } = require("./windows");

const bot = new Bot(process.env.BOT_TOKEN);
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const MINI_APP_URL = process.env.MINI_APP_URL;

// ─── /start ──────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  const user = ctx.from;

  // Сохраняем пользователя в базу
  const dbUser = db.upsertUser({
    tg_id:       user.id,
    tg_username: user.username || null,
    tg_name:     user.first_name,
  });

  const win = getCurrentWindow();

  // Кнопка для открытия мини-апки
  const keyboard = new InlineKeyboard()
    .webApp("📊 Открыть кабинет", MINI_APP_URL);

  await ctx.reply(
    `Привет, ${user.first_name}! 👋\n\n` +
    `Здесь ты отслеживаешь свои продукты и запрашиваешь выплаты.\n\n` +
    `📅 Текущее окно #${win.number} — ${formatWindowRange(win.number)}`,
    { reply_markup: keyboard }
  );
});

// ─── Обработка скринов от пользователей ─────────────────────────────
// Пользователь отправляет фото с подписью вида "cd:5" (product_id)

bot.on("message:photo", async (ctx) => {
  const caption = ctx.message.caption || "";
  const match = caption.match(/^(applied|received|cd):(\d+)$/);

  if (!match) return; // Просто фото без нашей подписи — игнорируем

  const action     = match[1];
  const product_id = parseInt(match[2]);
  const product    = PRODUCTS.find(p => p.id === product_id);

  if (!product) return;

  const dbUser = db.getUserByTgId(ctx.from.id);
  if (!dbUser) return;

  const fileId = ctx.message.photo.at(-1).file_id; // Берём самое большое фото
  const win    = getCurrentWindow();

  if (action === "applied") {
    // Оформил заявку — просто обновляем статус
    db.updateProductStatus({
      user_id:    dbUser.id,
      product_id,
      status:     "applied",
      screenshot: fileId,
    });
    await ctx.reply(`📝 Принято! Заявка на ${product.category} ${product.name} зафиксирована.`);

    // Уведомляем админа
    await bot.api.sendPhoto(ADMIN_ID, fileId, {
      caption: `📝 <b>${ctx.from.first_name}</b> (@${ctx.from.username})\nОформил заявку: <b>${product.category} ${product.name}</b>`,
      parse_mode: "HTML",
    });

  } else if (action === "received") {
    // Получил карту — просто обновляем статус
    db.updateProductStatus({
      user_id:    dbUser.id,
      product_id,
      status:     "received",
      screenshot: fileId,
    });
    await ctx.reply(`💳 Принято! Получение ${product.category} ${product.name} зафиксировано.`);

    // Уведомляем админа
    await bot.api.sendPhoto(ADMIN_ID, fileId, {
      caption: `💳 <b>${ctx.from.first_name}</b> (@${ctx.from.username})\nПолучил карту: <b>${product.category} ${product.name}</b>`,
      parse_mode: "HTML",
    });

  } else if (action === "cd") {
    // ЦД выполнено — нужен апрув от админа
    db.updateProductStatus({
      user_id:    dbUser.id,
      product_id,
      status:     "cd_pending",
      screenshot: fileId,
    });

    const review = db.createCdReview({
      user_id:    dbUser.id,
      product_id,
      screenshot: fileId,
      window_num: win.number,
    });

    await ctx.reply(`🕐 Скрин получен! ЦД по ${product.category} ${product.name} на проверке у админа.`);

    // Отправляем скрин админу с кнопками апрув/отклонить
    const adminKeyboard = new InlineKeyboard()
      .text("✅ Подтвердить", `cd_approve:${review.lastInsertRowid}`)
      .text("❌ Отклонить",   `cd_reject:${review.lastInsertRowid}`);

    await bot.api.sendPhoto(ADMIN_ID, fileId, {
      caption:
        `🔍 <b>Проверка ЦД</b>\n\n` +
        `👤 ${ctx.from.first_name} (@${ctx.from.username})\n` +
        `📦 ${product.category} ${product.name}\n` +
        `📅 Окно #${win.number} (${formatWindowRange(win.number)})`,
      parse_mode:   "HTML",
      reply_markup: adminKeyboard,
    });
  }
});

// ─── Апрув/отклонение ЦД от админа ──────────────────────────────────

bot.callbackQuery(/^cd_(approve|reject):(\d+)$/, async (ctx) => {
  // Только админ может нажимать эти кнопки
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCallbackQuery("Нет доступа");
    return;
  }

  const action    = ctx.match[1]; // approve | reject
  const review_id = parseInt(ctx.match[2]);

  const review = db.reviewCd({
    review_id,
    status: action === "approve" ? "approved" : "rejected",
  });

  const product = PRODUCTS.find(p => p.id === review.product_id);
  const dbUser  = db.getUserByTgId(null); // получим через user_id
  
  // Обновляем статус продукта у пользователя
  const newStatus = action === "approve" ? "cd_done" : "cd_rejected";
  db.updateProductStatus({
    user_id:    review.user_id,
    product_id: review.product_id,
    status:     newStatus,
  });

  // Уведомляем пользователя
  const users = db.getAllUsers();
  const user  = users.find(u => u.id === review.user_id);

  if (user) {
    const win = getCurrentWindow();

    if (action === "approve") {
      await bot.api.sendMessage(user.tg_id,
        `✅ <b>ЦД подтверждено!</b>\n\n` +
        `Продукт: ${product.category} ${product.name}\n\n` +
        `Теперь можешь запросить выплату в кабинете до конца окна #${win.number}.`,
        { parse_mode: "HTML" }
      );
    } else {
      await bot.api.sendMessage(user.tg_id,
        `❌ <b>ЦД отклонено</b>\n\n` +
        `Продукт: ${product.category} ${product.name}\n\n` +
        `Свяжись с @suetaartur для уточнений.`,
        { parse_mode: "HTML" }
      );
    }
  }

  await ctx.editMessageCaption({
    caption: ctx.callbackQuery.message.caption +
      `\n\n${action === "approve" ? "✅ Подтверждено" : "❌ Отклонено"}`,
    parse_mode: "HTML",
  });

  await ctx.answerCallbackQuery(action === "approve" ? "Подтверждено!" : "Отклонено");
});

// ─── Команды для админа ──────────────────────────────────────────────

bot.command("window", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;

  const win      = getCurrentWindow();
  const payouts  = db.getPayoutsByWindow(win.number);
  const pending  = db.getPendingCdReviews();

  let text = `📅 <b>Окно #${win.number}</b> (${formatWindowRange(win.number)})\n\n`;

  if (payouts.length === 0) {
    text += "💰 Заявок на выплату пока нет\n";
  } else {
    text += `💰 <b>Заявки на выплату (${payouts.length}):</b>\n`;
    for (const p of payouts) {
      const product = PRODUCTS.find(pr => pr.id === p.product_id);
      text += `• ${p.tg_name} (@${p.tg_username}) — ${product?.category} ${product?.name} [${p.status}]\n`;
    }
  }

  if (pending.length > 0) {
    text += `\n🕐 <b>Ожидают проверки ЦД: ${pending.length}</b>`;
  }

  await ctx.reply(text, { parse_mode: "HTML" });
});

// ─── Запуск ──────────────────────────────────────────────────────────

// Запускаем и Express-сервер для мини-апки
require("./server");

bot.start({
  onStart: () => console.log("✅ Бот запущен!"),
});
