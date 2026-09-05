// Полный список продуктов по категориям
const PRODUCTS = [
  // Дебетовые карты
  { id: 1, name: "Альфа",   category: "Дебетовая" },
  { id: 2, name: "Т-Банк",  category: "Дебетовая" },
  { id: 3, name: "VTB",     category: "Дебетовая" },

  // ИП
  { id: 4, name: "Т-Банк",  category: "ИП на НПД" },

  // Кредитные карты
  { id: 5, name: "Альфа",   category: "Кредитная" },
  { id: 6, name: "VTB",     category: "Кредитная" },
  { id: 7, name: "Halva",   category: "Кредитная" },
  { id: 8, name: "Т-Банк",  category: "Кредитная" },

  // Р/с счета
  { id: 9,  name: "PSB",    category: "Р/с" },
  { id: 10, name: "Альфа",  category: "Р/с" },
  { id: 11, name: "VTB",    category: "Р/с" },
];

// Возможные статусы для каждого продукта (в порядке прогресса)
const STATUSES = [
  { key: "none",              label: "Не начат",         emoji: "⚪" },
  { key: "applied",           label: "Оформил заявку",   emoji: "📝" },
  { key: "received",          label: "Получил карту",    emoji: "💳" },
  { key: "cd_done",           label: "ЦД выполнено",     emoji: "✅" },
  { key: "cd_pending",        label: "ЦД на проверке",   emoji: "🕐" },
  { key: "cd_rejected",       label: "ЦД отклонено",     emoji: "❌" },
  { key: "payout_requested",  label: "Запросил выплату", emoji: "💰" },
  { key: "paid",              label: "Выплачено",        emoji: "🎉" },
];

module.exports = { PRODUCTS, STATUSES };
