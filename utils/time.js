const i18n = require('./i18n')

const DAY_MS = 24 * 60 * 60 * 1000
let timeContextProvider = null

// Server installs an async-local provider; the Mini Program uses device time.
function setTimeContextProvider(provider) {
  timeContextProvider = provider
}

function captureTimeContext() {
  const now = new Date()
  let timeZone = ''
  try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || '' } catch (error) { /* offset works without Intl */ }
  return { timeZone, timezoneOffsetMinutes: now.getTimezoneOffset(), capturedAt: now.getTime() }
}

function currentParts(value = Date.now()) {
  const date = new Date(value)
  const context = timeContextProvider && timeContextProvider()
  if (context && context.timeZone) {
    const fields = new Intl.DateTimeFormat('en-GB', {
      timeZone: context.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(date)
    const parts = {}
    fields.forEach((field) => { if (field.type !== 'literal') parts[field.type] = Number(field.value) })
    return parts
  }
  if (context && Number.isFinite(context.timezoneOffsetMinutes)) {
    const local = new Date(date.getTime() - context.timezoneOffsetMinutes * 60000)
    return { year: local.getUTCFullYear(), month: local.getUTCMonth() + 1, day: local.getUTCDate(), hour: local.getUTCHours(), minute: local.getUTCMinutes(), second: local.getUTCSeconds() }
  }
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), hour: date.getHours(), minute: date.getMinutes(), second: date.getSeconds() }
}

function dateKeyAt(value = Date.now()) {
  const parts = currentParts(value)
  return parts.year + '-' + pad(parts.month) + '-' + pad(parts.day)
}

function calendarDayNumber(dateKey) {
  const parts = String(dateKey).split('-').map(Number)
  return Date.UTC(parts[0], parts[1] - 1, parts[2]) / DAY_MS
}

function minuteSinceDate(dateKey, now = Date.now()) {
  const parts = currentParts(now)
  return (calendarDayNumber(dateKeyAt(now)) - calendarDayNumber(dateKey)) * 1440 + parts.hour * 60 + parts.minute + parts.second / 60
}

const MONTH_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
]

function pad(value) {
  return String(value).padStart(2, '0')
}

function toDate(value) {
  if (value instanceof Date) {
    return value
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    var parts = value.split('-').map(Number)
    return new Date(parts[0], parts[1] - 1, parts[2])
  }
  return value ? new Date(value) : new Date()
}

function formatDateKey(value) {
  var date = toDate(value)
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
}

function todayKey() {
  return dateKeyAt()
}

function addDays(dateKey, offset) {
  var date = new Date(toDate(dateKey).getTime())
  date.setDate(date.getDate() + offset)
  return formatDateKey(date)
}

function parseClockToMinutes(value, fallbackMinutes) {
  var text = String(value || '').trim()
  var match = text.match(/^(\d{1,2})[:：](\d{1,2})$/)
  if (!match) {
    return fallbackMinutes
  }
  var hours = Math.max(0, Math.min(Number(match[1]), 23))
  var minutes = Math.max(0, Math.min(Number(match[2]), 59))
  return hours * 60 + minutes
}

function formatMinutesAsClock(value) {
  var total = Math.max(0, Math.min(Math.round(Number(value) || 0), 24 * 60 - 1))
  return pad(Math.floor(total / 60)) + ':' + pad(total % 60)
}

function formatMinuteOfDay(value) {
  var total = Math.max(0, Math.round(Number(value) || 0))
  var minuteOfDay = total % (24 * 60)
  return pad(Math.floor(minuteOfDay / 60)) + ':' + pad(minuteOfDay % 60)
}

function formatScheduleMinute(value) {
  var total = Math.max(0, Math.round(Number(value) || 0))
  var dayOffset = Math.floor(total / (24 * 60))
  var clock = formatMinuteOfDay(total)

  if (!dayOffset) return clock
  if (i18n.getLang() === 'en') {
    return dayOffset === 1 ? 'Next day ' + clock : '+' + dayOffset + ' days ' + clock
  }
  return dayOffset === 1 ? '次日' + clock : '+' + dayOffset + '天 ' + clock
}

function formatDuration(minutes, language) {
  var value = Math.max(0, Math.round(Number(minutes) || 0))
  var lang = typeof language === 'string' ? language : i18n.getLang()
  if (lang === 'en') {
    if (value < 60) return value + ' min'
    var h = Math.floor(value / 60)
    var r = value % 60
    return r ? h + 'h ' + r + 'min' : h + 'h'
  }
  if (value < 60) return value + '分钟'
  var hours = Math.floor(value / 60)
  var rest = value % 60
  return rest ? hours + '小时' + rest + '分钟' : hours + '小时'
}

function formatTimestamp(timestamp) {
  var date = toDate(timestamp)
  return (date.getMonth() + 1) + '-' + date.getDate() + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

function slotOfMinute(minute) {
  if (minute < 12 * 60) return 'morning'
  if (minute < 18 * 60) return 'afternoon'
  return 'evening'
}

function slotText(slot, language) {
  var lang = typeof language === 'string' ? language : i18n.getLang()
  if (lang === 'en') {
    var enMap = { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening', any: 'Any' }
    return enMap[slot] || 'Any'
  }
  var zhMap = { morning: '上午', afternoon: '下午', evening: '晚上', any: '任意' }
  return zhMap[slot] || '任意'
}

function relativeDateText(dateKey) {
  var today = todayKey()
  var lang = i18n.getLang()
  if (dateKey === today) return lang === 'en' ? 'Today' : '今天'
  if (dateKey === addDays(today, 1)) return lang === 'en' ? 'Tomorrow' : '明天'
  if (dateKey === addDays(today, -1)) return lang === 'en' ? 'Yesterday' : '昨天'
  var date = toDate(dateKey)
  if (lang === 'en') {
    return MONTH_SHORT[date.getMonth()] + ' ' + date.getDate()
  }
  return (date.getMonth() + 1) + '月' + date.getDate() + '日'
}

module.exports = {
  captureTimeContext,
  currentParts,
  dateKeyAt,
  calendarDayNumber,
  minuteSinceDate,
  setTimeContextProvider,
  addDays: addDays,
  formatDateKey: formatDateKey,
  formatDuration: formatDuration,
  formatMinuteOfDay: formatMinuteOfDay,
  formatMinutesAsClock: formatMinutesAsClock,
  formatScheduleMinute: formatScheduleMinute,
  formatTimestamp: formatTimestamp,
  parseClockToMinutes: parseClockToMinutes,
  relativeDateText: relativeDateText,
  slotOfMinute: slotOfMinute,
  slotText: slotText,
  todayKey: todayKey
}
