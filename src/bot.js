require("dotenv").config();
const { Bot, InlineKeyboard } = require("grammy");
const cron = require("node-cron");
const db   = require("./db");
const { PRODUCTS } = require("./products");
const { getCurrentWindow, formatWindowRange, isLastDayOfWindow } = require("./windows");

const bot      = new Bot(process.env.BOT_TOKEN);
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const GROUP_ID = process.env.GROUP_ID ? parseInt(process.env.GROUP_ID) : null;

// ─── /start ──────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  const user = ctx.from;
  db.upsertUser({ tg_id: user.id, tg_username: user.username || null, tg_name: user.first_name });

  const win = getCurrentWindow();
  const keyboard = new InlineKeyboard().webApp("📊 Открыть кабинет", process.env.MINI_APP_URL);

  await ctx.reply(
    `Привет, ${user.first_name}! 👋\n\n` +
    `Здесь отслеживаешь продукты и запрашиваешь выплаты.\n\n` +
    `📅 Текущее окно #${win.number} — ${formatWindowRange(win.number)}`,
    { reply_markup: keyboard }
  );
});

// ─── Панель выплат (сборка) ──────────────────────────────────────────

function buildPayoutPanel(win) {
  const payouts = db.getPayoutsByWindow(win.number).filter(p => p.status === "pending");
  if (!payouts.length) return null;

  let text = `💰 <b>Выплаты — Окно #${win.number}</b> (${formatWindowRange(win.number)})\n\n`;
  const keyboard = { inline_keyboard: [] };

  for (const p of payouts) {
    const product = PRODUCTS.find(pr => pr.id === p.product_id);
    const who     = `${p.tg_name}${p.tg_username ? ` @${p.tg_username}` : ""}`;
    text += `👤 ${who}\n   📦 ${product?.category} ${product?.name}\n\n`;
    keyboard.inline_keyboard.push([{
      text:          `✅ Выплатил ${p.tg_name} — ${product?.name}`,
      callback_data: `pay_req:${p.id}`,
    }]);
  }

  text += `Итого: <b>${payouts.length}</b> выплат`;
  return { text, keyboard };
}

// ─── /payouts — актуальная панель выплат для админа ─────────────────

bot.command("payouts", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;

  const win   = getCurrentWindow();
  const panel = buildPayoutPanel(win);

  if (!panel) {
    await ctx.reply(`💰 Окно #${win.number} — заявок на выплату пока нет.`);
    return;
  }

  await ctx.reply(panel.text, { parse_mode: "HTML", reply_markup: panel.keyboard });
});

// ─── Кнопка "Выплатил" ───────────────────────────────────────────────

bot.callbackQuery(/^pay_req:(\d+)$/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCallbackQuery("Нет доступа");
    return;
  }

  const request_id = parseInt(ctx.match[1]);
  const request    = db.getPayoutRequestById(request_id);

  if (!request || request.status === "paid") {
    await ctx.answerCallbackQuery("Уже выплачено");
    return;
  }

  // Отмечаем как выплаченное
  db.markPaid({ request_id });
  db.updateProductStatus({ user_id: request.user_id, product_id: request.product_id, status: "paid" });

  // Уведомляем участника
  const product = PRODUCTS.find(p => p.id === request.product_id);
  await bot.api.sendMessage(request.tg_id,
    `🎉 <b>Выплата получена!</b>\n\nПродукт: ${product?.category} ${product?.name}`,
    { parse_mode: "HTML" }
  );

  await ctx.answerCallbackQuery("Выплата отмечена!");

  // Обновляем панель: убираем оплаченную кнопку
  const win   = getCurrentWindow();
  const panel = buildPayoutPanel(win);

  if (!panel) {
    await ctx.editMessageText(`✅ <b>Все выплаты за окно #${win.number} произведены!</b>`, { parse_mode: "HTML" });
  } else {
    await ctx.editMessageText(panel.text, { parse_mode: "HTML", reply_markup: panel.keyboard });
  }
});

// ─── Апрув/отклонение ЦД от админа ──────────────────────────────────

bot.callbackQuery(/^cd_(approve|reject):(\d+)$/, async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) { await ctx.answerCallbackQuery("Нет доступа"); return; }

  const action    = ctx.match[1];
  const review_id = parseInt(ctx.match[2]);
  const review    = db.reviewCd({ review_id, status: action === "approve" ? "approved" : "rejected" });
  const product   = PRODUCTS.find(p => p.id === review.product_id);
  const newStatus = action === "approve" ? "cd_done" : "cd_rejected";

  db.updateProductStatus({ user_id: review.user_id, product_id: review.product_id, status: newStatus });

  const users = db.getAllUsers();
  const user  = users.find(u => u.id === review.user_id);
  const win   = getCurrentWindow();

  if (user) {
    if (action === "approve") {
      await bot.api.sendMessage(user.tg_id,
        `✅ <b>ЦД подтверждено!</b>\n\nПродукт: ${product?.category} ${product?.name}\n\nМожешь запросить выплату до конца окна #${win.number}.`,
        { parse_mode: "HTML" }
      );
      // Уведомляем группу
      if (GROUP_ID) {
        await bot.api.sendMessage(GROUP_ID,
          `✅ <b>ЦД подтверждено</b>\n👤 ${user.tg_name}${user.tg_username ? ` @${user.tg_username}` : ""}\n📦 ${product?.category} ${product?.name}`,
          { parse_mode: "HTML" }
        );
      }
    } else {
      await bot.api.sendMessage(user.tg_id,
        `❌ <b>ЦД отклонено</b>\n\nПродукт: ${product?.category} ${product?.name}\n\nСвяжись с @suetaartur для уточнений.`,
        { parse_mode: "HTML" }
      );
    }
  }

  await ctx.editMessageCaption({
    caption:    (ctx.callbackQuery.message.caption || "") + `\n\n${action === "approve" ? "✅ Подтверждено" : "❌ Отклонено"}`,
    parse_mode: "HTML",
  });
  await ctx.answerCallbackQuery(action === "approve" ? "Подтверждено!" : "Отклонено");
});

// ─── /window — сводка текущего окна ─────────────────────────────────

bot.command("window", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const win     = getCurrentWindow();
  const payouts = db.getPayoutsByWindow(win.number);
  const pending = db.getPendingCdReviews();

  let text = `📅 <b>Окно #${win.number}</b> (${formatWindowRange(win.number)})\n\n`;

  if (!payouts.length) {
    text += "💰 Заявок на выплату пока нет\n";
  } else {
    text += `💰 <b>Заявки (${payouts.length}):</b>\n`;
    for (const p of payouts) {
      const product = PRODUCTS.find(pr => pr.id === p.product_id);
      text += `• ${p.tg_name} — ${product?.category} ${product?.name} [${p.status}]\n`;
    }
  }

  if (pending.length) text += `\n🕐 Ожидают проверки ЦД: ${pending.length}`;

  await ctx.reply(text, { parse_mode: "HTML" });
});

// ─── Крон: уведомление в 18:00 в последний день окна ────────────────
// Часовой пояс — Москва (UTC+3)

cron.schedule("0 18 * * *", async () => {
  if (!isLastDayOfWindow()) return; // не последний день — пропускаем

  const win   = getCurrentWindow();
  const panel = buildPayoutPanel(win);

  if (!panel) {
    // Никто не запросил выплату — всё равно сообщим
    const noPayoutsText = `⏰ <b>Конец окна #${win.number}</b> (${formatWindowRange(win.number)})\n\nЗаявок на выплату нет.`;
    await bot.api.sendMessage(ADMIN_ID, noPayoutsText, { parse_mode: "HTML" });
    return;
  }

  // Итоговое сообщение для группы (без кнопок)
  const groupText =
    `⏰ <b>Конец окна #${win.number}</b> (${formatWindowRange(win.number)})\n\n` +
    panel.text.split("Итого:")[0] +
    `Итого: <b>${db.getPayoutsByWindow(win.number).filter(p => p.status === "pending").length}</b> выплат`;

  if (GROUP_ID) {
    await bot.api.sendMessage(GROUP_ID, groupText, { parse_mode: "HTML" });
  }

  // Сообщение для админа — с кнопками "Выплатил"
  await bot.api.sendMessage(ADMIN_ID, panel.text, {
    parse_mode:   "HTML",
    reply_markup: panel.keyboard,
  });

}, { timezone: "Europe/Moscow" });

// ─── Запуск ──────────────────────────────────────────────────────────

require("./server");

bot.start({ onStart: () => console.log("✅ Бот запущен!") });
