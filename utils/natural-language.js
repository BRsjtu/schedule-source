const time = require('./time')

const CHINESE_DIGITS = {
  '零': 0,
  '〇': 0,
  '一': 1,
  '二': 2,
  '两': 2,
  '三': 3,
  '四': 4,
  '五': 5,
  '六': 6,
  '七': 7,
  '八': 8,
  '九': 9
}

function parseNumber(value) {
  const text = String(value || '').trim()
  if (/^\d+$/.test(text)) return Number(text)
  if (text === '十') return 10
  const tenIndex = text.indexOf('十')
  if (tenIndex >= 0) {
    const tens = tenIndex === 0 ? 1 : CHINESE_DIGITS[text[0]]
    const ones = tenIndex === text.length - 1 ? 0 : CHINESE_DIGITS[text[text.length - 1]]
    return Number.isFinite(tens) && Number.isFinite(ones) ? tens * 10 + ones : null
  }
  if (text.length === 1 && Object.prototype.hasOwnProperty.call(CHINESE_DIGITS, text)) {
    return CHINESE_DIGITS[text]
  }
  return null
}

function parseDuration(text) {
  const value = String(text || '')
  const hour = value.match(/(\d+(?:\.\d+)?)\s*(小时|钟头|h)/i)
  if (hour) return Math.round(Number(hour[1]) * 60)
  const minute = value.match(/(\d+)\s*(分钟|分|min)/i)
  return minute ? Number(minute[1]) : null
}

function parseDateKey(text, today = time.todayKey()) {
  const value = String(text || '')
  const fullDate = value.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)?/)
  if (fullDate) return time.formatDateKey(new Date(Number(fullDate[1]), Number(fullDate[2]) - 1, Number(fullDate[3])))
  const nextYear = value.match(/明年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)?/)
  if (nextYear) {
    return time.formatDateKey(new Date(Number(today.slice(0, 4)) + 1, Number(nextYear[1]) - 1, Number(nextYear[2])))
  }
  if (/大后天/.test(value)) return time.addDays(today, 3)
  if (/后天/.test(value)) return time.addDays(today, 2)
  if (/明天|明早|明晚/.test(value)) return time.addDays(today, 1)
  if (/昨天/.test(value)) return time.addDays(today, -1)
  if (/\bday after tomorrow\b/i.test(value)) return time.addDays(today, 2)
  if (/\btomorrow\b/i.test(value)) return time.addDays(today, 1)
  if (/\byesterday\b/i.test(value)) return time.addDays(today, -1)

  const monthDay = value.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)?/)
  if (monthDay) {
    return time.formatDateKey(new Date(Number(today.slice(0, 4)), Number(monthDay[1]) - 1, Number(monthDay[2])))
  }

  const weekdayMap = { '日': 0, '天': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6 }
  const week = value.match(/(下)?(?:周|星期|礼拜)([日天一二三四五六])/)
  if (week) {
    const parts = today.split('-').map(Number)
    const now = new Date(parts[0], parts[1] - 1, parts[2])
    let offset = weekdayMap[week[2]] - now.getDay()
    if (offset <= 0 || week[1]) offset += 7
    return time.addDays(today, offset)
  }
  return today
}

function parseClock(text) {
  const value = String(text || '')
  const english = value.match(/\b(0?[1-9]|1[0-2])(?:\s*:\s*([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)\b/i)
  if (english) {
    const hour = Number(english[1]) % 12 + (/^p/i.test(english[3]) ? 12 : 0)
    return time.formatMinutesAsClock(hour * 60 + Number(english[2] || 0))
  }
  const colon = value.match(/(凌晨|早上|上午|中午|下午|傍晚|晚上|今夜|明夜|今晚|明晚|夜里|夜晚)?\s*([01]?\d|2[0-3])\s*[:：]\s*([0-5]?\d)/)
  if (colon) {
    let hour = Number(colon[2])
    const period = colon[1] || ''
    if (/(下午|傍晚|晚上|今夜|明夜|今晚|明晚|夜里|夜晚)/.test(period) && hour < 12) hour += 12
    if (period === '中午' && hour < 11) hour += 12
    return time.formatMinutesAsClock(hour * 60 + Number(colon[3]))
  }

  const clock = value.match(/(凌晨|早上|上午|中午|下午|傍晚|晚上|今夜|明夜|今晚|明晚|夜里|夜晚)?\s*([0-2]?\d|[零〇一二两三四五六七八九十]{1,3})\s*(?:点|时)(?:(半)|\s*([0-5]?\d|[零〇一二两三四五六七八九十]{1,3})\s*分?)?/)
  if (!clock) return ''
  let hour = parseNumber(clock[2])
  const minute = clock[3] ? 30 : (parseNumber(clock[4]) || 0)
  if (!Number.isFinite(hour) || hour > 24 || minute > 59) return ''
  const period = clock[1] || ''
  if (/(下午|傍晚|晚上|今夜|明夜|今晚|明晚|夜里|夜晚)/.test(period) && hour < 12) hour += 12
  if (period === '中午' && hour < 11) hour += 12
  if (hour === 24) hour = 0
  return time.formatMinutesAsClock(hour * 60 + minute)
}

function preferredSlot(text, clock) {
  const value = String(text || '')
  if (clock) return time.slotOfMinute(time.parseClockToMinutes(clock, 0))
  if (/(凌晨|早上|上午)/.test(value)) return 'morning'
  if (/(中午|下午|傍晚)/.test(value)) return 'afternoon'
  if (/(晚上|今夜|明夜|今晚|明晚|夜里|夜晚)/.test(value)) return 'evening'
  return 'any'
}

function extractClocks(text) {
  const value = String(text || '')
  const parts = value.split(/[、，,；;]/).map((item) => item.trim()).filter(Boolean)
  const clocks = parts.map((item) => parseClock(item)).filter(Boolean)
  if (clocks.length) return clocks
  const clock = parseClock(value)
  return clock ? [clock] : []
}

function taskTitle(text) {
  return String(text || '')
    .replace(/(?:\d{4}\s*年\s*|明年\s*)?\d{1,2}\s*月\s*\d{1,2}\s*(?:日|号)?|大后天|后天|明天|今天|昨天|今夜|明夜|今晚|明晚|明早/g, ' ')
    .replace(/(?:凌晨|早上|上午|中午|下午|傍晚|晚上|今夜|明夜|今晚|明晚|夜里|夜晚)?\s*(?:[0-2]?\d|[零〇一二两三四五六七八九十]{1,3})\s*(?:[:：]\s*[0-5]?\d|点(?:半|\s*(?:[0-5]?\d|[零〇一二两三四五六七八九十]{1,3})?\s*分?)?|时)/g, ' ')
    .replace(/^(?:(?:请|帮我|记得|给我|帮忙|把|安排|添加|创建)\s*)+/g, ' ')
    .replace(/^(?:安排|添加|创建)\s*/g, ' ')
    .replace(/(?:加|放|写|安排|添加|创建)?到(?:我的)?(?:日程|计划)(?:里|中)?$|(?:的)?(?:日程|计划)$/g, ' ')
    .replace(/^[\s，,。.:：；;]+|[\s，,。.:：；;]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 40)
}

function shouldCreateFallback(text) {
  const value = String(text || '').trim()
  if (!value) return false
  if (/^(?:你好|嗨|在吗|谢谢|谢了|test)$/i.test(value)) return false
  if (/^(?:帮我)?(?:创建|添加)(?:一个|个)?日程[\s，,。.!！?？]*$/.test(value)) return false
  if (/(安排|创建|记录|提醒|添加|放到|帮我找)/.test(value) && !/[?？]$/.test(value)) return true
  if (/(什么时候|哪个时间|哪天|如何|怎么|为什么|有空|空闲|吗|[?？])/.test(value)) return false
  return true
}

module.exports = {
  extractClocks,
  parseClock,
  parseDateKey,
  parseDuration,
  preferredSlot,
  shouldCreateFallback,
  taskTitle
}
