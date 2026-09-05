// Точка отсчёта — 1 сентября 2026
const ANCHOR = new Date("2026-09-01T00:00:00Z");

// Длина окна в днях
const WINDOW_SIZE = 5;

/**
 * Считает номер окна для заданной даты
 * Окна идут непрерывно от якорной даты, не сбрасываясь по месяцам
 */
function getWindowNumber(date = new Date()) {
  const msPerDay = 1000 * 60 * 60 * 24;
  const daysFromAnchor = Math.floor((date - ANCHOR) / msPerDay);
  
  // Если дата раньше якоря — ещё нет окон
  if (daysFromAnchor < 0) return null;

  return Math.floor(daysFromAnchor / WINDOW_SIZE) + 1;
}

/**
 * Возвращает даты начала и конца окна по его номеру
 */
function getWindowDates(windowNumber) {
  const msPerDay = 1000 * 60 * 60 * 24;
  const start = new Date(ANCHOR.getTime() + (windowNumber - 1) * WINDOW_SIZE * msPerDay);
  const end   = new Date(ANCHOR.getTime() +  windowNumber      * WINDOW_SIZE * msPerDay - 1);
  return { start, end };
}

/**
 * Возвращает информацию о текущем окне
 */
function getCurrentWindow() {
  const now = new Date();
  const number = getWindowNumber(now);
  const { start, end } = getWindowDates(number);
  return { number, start, end };
}

/**
 * Возвращает дату конца текущего окна в читаемом формате
 * Например: "10 сентября 2026"
 */
function getCurrentWindowEndFormatted() {
  const { end } = getCurrentWindow();
  return end.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Форматирует диапазон дат окна
 * Например: "6 – 10 сен"
 */
function formatWindowRange(windowNumber) {
  const { start, end } = getWindowDates(windowNumber);
  const opts = { day: "numeric", month: "short", timeZone: "UTC" };
  const startStr = start.toLocaleDateString("ru-RU", opts);
  const endStr   = end.toLocaleDateString("ru-RU", opts);
  return `${startStr} – ${endStr}`;
}

/**
 * Проверяет — последний ли сегодня день текущего окна
 * (для крона: в этот день в 18:00 отправляем итог выплат)
 */
function isLastDayOfWindow(date = new Date()) {
  const msPerDay = 1000 * 60 * 60 * 24;
  const daysFromAnchor = Math.floor((date - ANCHOR) / msPerDay);
  if (daysFromAnchor < 0) return false;
  // Последний день 5-дневного цикла — когда остаток от деления = 4
  return (daysFromAnchor % WINDOW_SIZE) === (WINDOW_SIZE - 1);
}

module.exports = {
  getWindowNumber,
  getWindowDates,
  getCurrentWindow,
  getCurrentWindowEndFormatted,
  formatWindowRange,
  isLastDayOfWindow,
};
