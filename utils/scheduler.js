const i18n = require('./i18n')
const presentation = require('./memory-presentation')
const time = require('./time')

const PRIORITY_WEIGHT = {
  urgent: 4,
  high: 3,
  medium: 2,
  low: 1
}

const SLOT_RANGES = {
  morning: [9 * 60, 12 * 60],
  afternoon: [14 * 60, 18 * 60],
  evening: [19 * 60, 22 * 60]
}

const SLOT_ORDER = ['morning', 'afternoon', 'evening']

const DEFAULT_DURATION_RULES = [
  { pattern: /(周报|总结|复盘|文案|写作|方案|报告)/, minutes: 60, category: '写作整理' },
  { pattern: /(会议|沟通|对齐|讨论|面试)/, minutes: 45, category: '沟通会议' },
  { pattern: /(学习|复习|阅读|课程|刷题|论文)/, minutes: 90, category: '学习输入' },
  { pattern: /(运动|跑步|健身|训练)/, minutes: 45, category: '运动健康' },
  { pattern: /(邮件|消息|回复|整理桌面|收拾)/, minutes: 25, category: '轻量杂务' },
  { pattern: /(出差|赶路|通勤|机场|火车|高铁)/, minutes: 120, category: '出行安排' }
]

function normalizeText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '')
}

function normalizePriority(value) {
  const text = String(value || '').toLowerCase()
  if (/urgent|最高|紧急|必须/.test(text)) {
    return 'urgent'
  }
  if (/high|高|重要/.test(text)) {
    return 'high'
  }
  if (/low|低|不急|可选/.test(text)) {
    return 'low'
  }
  return 'medium'
}

function priorityText(priority) {
  const map = {
    urgent: '紧急',
    high: '高',
    medium: '中',
    low: '低'
  }
  return map[priority] || '中'
}

function categorizeTask(task) {
  const text = `${task.title || ''}${task.description || ''}`
  const matched = DEFAULT_DURATION_RULES.find((item) => item.pattern.test(text))
  return matched ? matched.category : normalizeText(task.title).slice(0, 8) || '一般任务'
}

function similarity(left, right) {
  const a = normalizeText(left)
  const b = normalizeText(right)
  if (!a || !b) {
    return 0
  }
  if (a === b) {
    return 1
  }
  if (a.includes(b) || b.includes(a)) {
    return 0.82
  }

  const chars = Array.from(new Set(a.split('')))
  const bSet = new Set(b.split(''))
  const overlap = chars.filter((char) => bSet.has(char)).length
  return overlap / Math.max(chars.length, bSet.size)
}

function defaultDuration(task) {
  const text = `${task.title || ''}${task.description || ''}`
  const matched = DEFAULT_DURATION_RULES.find((item) => item.pattern.test(text))
  return matched ? matched.minutes : 45
}

function recommendDuration(task, history, memory, language = i18n.getLang()) {
  const override = memory && memory.durationOverrides && memory.durationOverrides[categorizeTask(task)]
  if (override && Number(override.minutes) > 0) {
    return { minutes: Number(override.minutes), basisKey: 'basisOverride', basis: i18n.translate('basisOverride', language) }
  }
  const records = Array.isArray(history) ? history : []
  const matches = records
    .map((record) => ({
      record,
      score: similarity(`${task.title || ''}${task.description || ''}`, `${record.title || ''}${record.description || ''}`)
    }))
    .filter((item) => item.score >= 0.35 && Number(item.record.actualMinutes) > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)

  if (matches.length) {
    const weightedTotal = matches.reduce((sum, item) => sum + item.record.actualMinutes * item.score, 0)
    const scoreTotal = matches.reduce((sum, item) => sum + item.score, 0)
    return {
      minutes: Math.max(10, Math.round(weightedTotal / scoreTotal / 5) * 5),
      basisKey: 'basisHistory', basisParams: { count: matches.length }, basis: i18n.translate('basisHistory', language, { count: matches.length })
    }
  }

  const category = categorizeTask(task)
  const pattern = memory && memory.taskPatterns ? memory.taskPatterns[category] : null
  if (pattern && pattern.avgActualMinutes) {
    return {
      minutes: Math.max(10, Math.round(pattern.avgActualMinutes / 5) * 5),
      basisKey: 'basisPattern', basisParams: { category }, basis: i18n.translate('basisPattern', language, { category: presentation.categoryText(category, language) })
    }
  }

  return {
    minutes: defaultDuration(task),
    basisKey: 'basisDefault', basis: i18n.translate('basisDefault', language)
  }
}

function completionRateScore(slotStats) {
  const completed = Number(slotStats && slotStats.completed) || 0
  if (Number(slotStats && slotStats.attempts) > 0) {
    return completed / slotStats.attempts * 100
  }
  const avgActual = completed
    ? (Number(slotStats.totalActualMinutes || 0) / completed)
    : 60
  return completed * 8 - Math.max(0, avgActual - 60) * 0.08
}

function bestHistoricalSlot(memory) {
  const stats = memory && memory.slotStats ? memory.slotStats : {}
  return SLOT_ORDER
    .map((slot) => ({ slot, score: completionRateScore(stats[slot]) }))
    .sort((a, b) => b.score - a.score)[0].slot
}

function preferredSlotFromFacts(memory, task) {
  const facts = memory && Array.isArray(memory.secretaryFacts) ? memory.secretaryFacts : []
  const taskText = normalizeText(`${task.title || ''}${task.description || ''}`)
  const fact = facts.find((item) => {
    const value = normalizeText(`${item.key || ''}${item.value || ''}${item.evidence || ''}`)
    return item.kind === 'time_preference' && (
      value.includes('上午') ||
      value.includes('下午') ||
      value.includes('晚上') ||
      value.includes('morning') ||
      value.includes('afternoon') ||
      value.includes('evening')
    ) && (!taskText || similarity(taskText, value) >= 0.08)
  })

  if (!fact) {
    return ''
  }
  return normalizeSlot(`${fact.value || ''}${fact.evidence || ''}`)
}

function resolveEffectiveSlot(task, memory) {
  const requested = normalizeSlot(task.preferredSlot)
  if (requested !== 'any') {
    return requested
  }

  const factSlot = preferredSlotFromFacts(memory, task)
  if (factSlot && factSlot !== 'any') return factSlot

  const category = categorizeTask(task)
  const pattern = memory && memory.taskPatterns ? memory.taskPatterns[category] : null
  if (pattern && pattern.preferredSlot && pattern.preferredSlot !== 'any') {
    return pattern.preferredSlot
  }

  return bestHistoricalSlot(memory)
}

function normalizeSlot(value) {
  const text = String(value || '').toLowerCase()
  if (/morning|上午|早/.test(text)) {
    return 'morning'
  }
  if (/afternoon|下午|午后/.test(text)) {
    return 'afternoon'
  }
  if (/evening|晚上|夜|晚/.test(text)) {
    return 'evening'
  }
  return 'any'
}

function taskSortValue(task) {
  const priority = PRIORITY_WEIGHT[normalizePriority(task.priority)] || 2
  const estimate = Number(task.estimatedMinutes) || 45
  return priority * 1000 - estimate
}

function scheduleSortValue(task, memory) {
  const slot = resolveEffectiveSlot(task, memory)
  const slotIndex = SLOT_ORDER.indexOf(slot)
  return (slotIndex < 0 ? 9 : slotIndex) * 10000 - taskSortValue(task)
}

function selectTasksForMode(tasks, mode, memory, dateKey) {
  const candidates = tasks
    .filter((task) => (
      task.status !== 'completed' &&
      task.status !== 'deleted' &&
      (!dateKey || (task.dateKey || time.todayKey()) === dateKey)
    ))
    .sort((a, b) => scheduleSortValue(a, memory) - scheduleSortValue(b, memory))

  if (mode === 'relaxed') {
    return candidates.sort((a, b) => taskSortValue(b) - taskSortValue(a)).slice(0, 3)
  }

  return candidates
}

function getWorkBounds(memory) {
  const prefs = memory && memory.userPreferences ? memory.userPreferences : {}
  return {
    start: time.parseClockToMinutes(prefs.workdayStart, 9 * 60),
    end: time.parseClockToMinutes(prefs.workdayEnd, 22 * 60),
    breakMinutes: Math.max(0, Number.isFinite(Number(prefs.defaultBreakMinutes)) ? Number(prefs.defaultBreakMinutes) : 10)
  }
}

function nextSlotStart(slot, cursor) {
  const range = SLOT_RANGES[slot]
  if (!range) {
    return cursor
  }
  if (cursor <= range[0]) {
    return range[0]
  }
  if (cursor > range[1]) {
    return cursor
  }
  return cursor
}

function intervalsOverlap(leftStart, leftEnd, rightStart, rightEnd) {
  return leftStart < rightEnd && rightStart < leftEnd
}

function hasIntervalConflict(start, end, intervals) {
  return intervals.some((item) => intervalsOverlap(start, end, item.start, item.end))
}

function findGap(rangeStart, rangeEnd, duration, intervals, breakMinutes) {
  let cursor = rangeStart
  const sorted = intervals
    .filter((item) => item.end + breakMinutes > rangeStart && item.start - breakMinutes < rangeEnd)
    .sort((a, b) => a.start - b.start)

  for (const item of sorted) {
    if (cursor + duration + breakMinutes <= item.start) {
      return cursor
    }
    cursor = Math.max(cursor, item.end + breakMinutes)
  }

  return cursor + duration <= rangeEnd ? cursor : null
}

function buildScheduledTask(task, start, duration, preferredSlot, effectiveSlot, bounds, conflict) {
  const end = start + duration
  const dateKey = task.dateKey || time.todayKey()
  const startDayOffset = Math.floor(start / (24 * 60))
  const endDayOffset = Math.floor(end / (24 * 60))
  return {
    ...task,
    status: task.status === 'running' || task.status === 'paused' ? task.status : 'planned',
    dateKey,
    preferredSlot,
    effectiveSlot,
    scheduledStart: time.formatMinuteOfDay(start),
    scheduledEnd: time.formatMinuteOfDay(end),
    scheduledStartMinute: start,
    scheduledEndMinute: end,
    scheduledStartDayOffset: startDayOffset,
    scheduledEndDayOffset: endDayOffset,
    scheduledStartDateKey: time.addDays(dateKey, startDayOffset),
    scheduledEndDateKey: time.addDays(dateKey, endDayOffset),
    crossesMidnight: endDayOffset > startDayOffset,
    scheduleOverflow: end > bounds.end,
    scheduleConflict: Boolean(conflict),
    updatedAt: Date.now()
  }
}

function scheduleSelectedTasks(selectedTasks, memory, initialIntervals, options = {}) {
  const bounds = getWorkBounds(memory)
  const floor = Math.max(bounds.start, Number(options.notBeforeMinute) || 0)
  const intervals = Array.isArray(initialIntervals) ? initialIntervals.slice() : []
  const fixedTasks = []
  const flexibleTasks = []

  selectedTasks.forEach((task) => {
    if (options.replanning && ['running', 'paused'].includes(task.status)) {
      const start = task.scheduledStartMinute == null ? floor : Number(task.scheduledStartMinute)
      const end = Math.max(start + (Number(task.estimatedMinutes) || 45), task.status === 'running' ? floor + 1 : 0)
      intervals.push({ start, end, id: task.id })
      fixedTasks.push({ task, active: true })
      return
    }
    const explicitStart = time.parseClockToMinutes(task.startClock || task.dueClock, null)
    if (Number.isFinite(explicitStart)) {
      fixedTasks.push({ task, explicitStart })
    } else {
      flexibleTasks.push(task)
    }
  })

  const scheduled = []

  fixedTasks
    .sort((a, b) => (a.explicitStart || 0) - (b.explicitStart || 0))
    .forEach(({ task, explicitStart, active }) => {
      if (active) { scheduled.push(task); return }
      const duration = Math.max(10, Number(task.estimatedMinutes) || 45)
      const preferredSlot = normalizeSlot(task.preferredSlot)
      const effectiveSlot = resolveEffectiveSlot(task, memory)
      const conflict = hasIntervalConflict(explicitStart, explicitStart + duration, intervals) || (options.replanning && explicitStart < Number(options.notBeforeMinute || 0))
      const nextTask = buildScheduledTask(task, explicitStart, duration, preferredSlot, effectiveSlot, bounds, conflict)
      intervals.push({ start: nextTask.scheduledStartMinute, end: nextTask.scheduledEndMinute, id: task.id })
      scheduled.push(nextTask)
    })

  flexibleTasks.forEach((task) => {
    const duration = Math.max(10, Number(task.estimatedMinutes) || 45)
    const preferredSlot = normalizeSlot(task.preferredSlot)
    const effectiveSlot = resolveEffectiveSlot(task, memory)
    const range = SLOT_RANGES[effectiveSlot]
    const rangeStart = Math.max(floor, effectiveSlot === 'morning' ? bounds.start : range ? range[0] : bounds.start)
    const rangeEnd = Math.min(bounds.end, effectiveSlot === 'evening' ? bounds.end : range ? range[1] : bounds.end)
    let start = findGap(rangeStart, rangeEnd, duration, intervals, bounds.breakMinutes)

    if (start == null) {
      start = findGap(floor, bounds.end, duration, intervals, bounds.breakMinutes)
    }

    if (start == null) {
      const latestEnd = intervals.reduce((max, item) => Math.max(max, item.end), floor)
      start = Math.max(floor, latestEnd + bounds.breakMinutes)
    }

    const nextTask = buildScheduledTask(task, start, duration, preferredSlot, effectiveSlot, bounds, false)
    intervals.push({ start: nextTask.scheduledStartMinute, end: nextTask.scheduledEndMinute, id: task.id })
    scheduled.push(nextTask)
  })

  return scheduled.sort((a, b) => a.scheduledStartMinute - b.scheduledStartMinute)
}

function applySchedule(tasks, options = {}) {
  const mode = options.mode || 'flexible'
  const memory = withCompletionStats(options.memory || {}, tasks, options.history || [], options.now)
  const dateKey = options.dateKey || time.todayKey()
  const selected = selectTasksForMode(tasks, mode, memory, dateKey)
  const previousDateKey = time.addDays(dateKey, -1)
  const carryoverIntervals = tasks
    .filter((task) => (
      task.status !== 'completed'
      && task.status !== 'deleted'
      && (task.dateKey || time.todayKey()) === previousDateKey
      && Number(task.scheduledEndMinute) > 24 * 60
    ))
    .map((task) => ({
      start: 0,
      end: Number(task.scheduledEndMinute) - 24 * 60,
      id: task.id,
      carryover: true
    }))
  if (options.replanning) {
    const selectedIds = new Set(selected.map((task) => task.id))
    tasks.filter((task) => !selectedIds.has(task.id) && !['completed', 'deleted'].includes(task.status)
      && (task.dateKey || time.todayKey()) === dateKey && (task.dueClock || task.startClock || ['running', 'paused'].includes(task.status)))
      .forEach((task) => {
        const start = time.parseClockToMinutes(task.startClock || task.dueClock, task.scheduledStartMinute)
        if (start == null) return
        carryoverIntervals.push({ start, end: Math.max(start + (Number(task.estimatedMinutes) || 45), task.status === 'running' ? Number(options.notBeforeMinute) + 1 : 0), id: task.id })
      })
  }
  const scheduled = scheduleSelectedTasks(selected, memory, carryoverIntervals, options)
  const scheduledById = scheduled.reduce((map, task) => {
    map[task.id] = task
    return map
  }, {})

  const nextTasks = tasks.map((task) => scheduledById[task.id] || task)

  return {
    tasks: nextTasks,
    scheduled,
    advice: buildAdviceBubbles(scheduled, mode, memory, options.language),
    summary: buildPlanSummary(scheduled, mode, options.language)
  }
}

// Explicit replanning recomputes flexible slots once; it does not reflow the
// result using old start times. Creation and timer adjustments keep their own rules.
function replanTasks(tasks, options = {}) {
  const dateKey = options.dateKey || time.todayKey()
  const mode = options.mode || 'flexible'
  const memory = withCompletionStats(options.memory || {}, tasks, options.history || [], options.now)
  const floor = options.notBeforeMinute == null ? currentMinute(dateKey, options.now) : options.notBeforeMinute
  const plan = applySchedule(tasks, { ...options, memory, dateKey, notBeforeMinute: floor, replanning: true })
  const prefs = getWorkBounds(memory)
  const previous = new Map(tasks.map((task) => [task.id, task]))
  const changes = []
  const entries = plan.scheduled.map((task) => {
    const old = previous.get(task.id)
    const locked = Boolean(task.startClock || task.dueClock || ['running', 'paused'].includes(task.status))
    const category = categorizeTask(task)
    const reason = locked ? 'fixed'
      : normalizeSlot(task.preferredSlot) !== 'any' ? 'preference'
        : preferredSlotFromFacts(memory, task) ? 'memory'
          : memory.taskPatterns && memory.taskPatterns[category] && memory.taskPatterns[category].preferredSlot ? 'pattern'
            : SLOT_ORDER.some((slot) => Number((memory.slotStats[slot] || {}).attempts) > 0) ? 'rate' : 'priority'
    const entry = { id: task.id, title: task.title, reason, priority: normalizePriority(task.priority),
      slot: task.effectiveSlot || resolveEffectiveSlot(task, memory),
      beforeStart: old.scheduledStartMinute, beforeEnd: old.scheduledEndMinute,
      afterStart: task.scheduledStartMinute, afterEnd: task.scheduledEndMinute,
      outsidePreferred: !locked && (task.scheduledStartMinute < (task.effectiveSlot === 'morning' ? prefs.start : (SLOT_RANGES[task.effectiveSlot] || [0])[0]) || task.scheduledEndMinute > (task.effectiveSlot === 'evening' ? prefs.end : (SLOT_RANGES[task.effectiveSlot] || [0, Number.MAX_SAFE_INTEGER])[1])),
      rate: (memory.slotStats[task.effectiveSlot] || {}).attempts ? Math.round((memory.slotStats[task.effectiveSlot].completed || 0) / memory.slotStats[task.effectiveSlot].attempts * 100) : 0,
      conflict: Boolean(task.scheduleConflict), overflow: Boolean(task.scheduleOverflow), locked }
    if (entry.beforeStart !== entry.afterStart || entry.beforeEnd !== entry.afterEnd) changes.push(entry)
    return entry
  })
  const pending = tasks.filter((task) => !['completed', 'deleted'].includes(task.status) && (task.dateKey || time.todayKey()) === dateKey)
  const report = { dateKey, mode, createdAt: options.now == null ? Date.now() : options.now,
    changedCount: changes.length, plannedCount: entries.length, fixedCount: entries.filter((entry) => entry.locked).length,
    remainingCount: pending.length - entries.length, changes, entries,
    workdayStart: time.formatMinuteOfDay(prefs.start), workdayEnd: time.formatMinuteOfDay(prefs.end), breakMinutes: prefs.breakMinutes,
    conflictCount: entries.filter((entry) => entry.conflict).length, overflowCount: entries.filter((entry) => entry.overflow).length }
  return { ...plan, tasks: mode === 'suggestion' ? tasks : plan.tasks, report }
}

// Only elapsed, scheduled opportunities count towards a completion rate.
// Deduplicate history and current tasks so a completion counts once.
function withCompletionStats(memory, tasks, history = [], now = Date.now()) {
  const records = new Map()
  history.concat(tasks).forEach((task) => records.set(task.id, task))
  const stats = {}
  SLOT_ORDER.forEach((slot) => { stats[slot] = { attempts: 0, completed: 0, totalActualMinutes: 0 } })
  records.forEach((task) => {
    if (task.status === 'deleted' || task.scheduledStartMinute == null) return
    const slot = time.slotOfMinute(task.scheduledStartMinute)
    if (!stats[slot]) return
    const endMinute = Number(task.scheduledEndMinute || task.scheduledStartMinute)
    if (task.status !== 'completed' && time.minuteSinceDate(task.dateKey || time.todayKey(), now) < endMinute) return
    stats[slot].attempts += 1
    if (task.status === 'completed') {
      stats[slot].completed += 1
      stats[slot].totalActualMinutes += Number(task.actualMinutes) || 0
    }
  })
  const slotStats = { ...(memory.slotStats || {}) }
  SLOT_ORDER.forEach((slot) => { if (stats[slot].attempts) slotStats[slot] = stats[slot] })
  return { ...memory, slotStats }
}

function dayTimestamp(dateKey) {
  return time.calendarDayNumber(dateKey) * 24 * 60 * 60 * 1000
}

function currentMinute(dateKey, now = Date.now()) {
  return Math.max(0, Math.ceil(time.minuteSinceDate(dateKey, now)))
}

// Reflow is opt-in: initial task creation keeps its existing scheduling behavior.
// Fixed appointments remain fixed; flexible work avoids them and the past.
function reflowRemainingTasks(tasks, options = {}) {
  const dateKey = options.dateKey || time.todayKey()
  const memory = options.memory || {}
  const bounds = getWorkBounds(memory)
  const floor = options.notBeforeMinute == null ? currentMinute(dateKey, options.now) : options.notBeforeMinute
  const candidates = tasks.filter((task) => task.status !== 'completed' && task.status !== 'deleted' && (task.dateKey || time.todayKey()) === dateKey)
  const fixed = candidates.filter((task) => task.dueClock || task.startClock || task.status === 'running' || task.status === 'paused')
  const fixedIds = new Set(fixed.map((task) => task.id))
  const intervals = tasks.filter((task) => task.status !== 'deleted' && task.status !== 'completed' && (task.dateKey || time.todayKey()) !== dateKey)
    .map((task) => {
      const offset = (dayTimestamp(task.dateKey || time.todayKey()) - dayTimestamp(dateKey)) / 60000
      return { start: offset + Number(task.scheduledStartMinute), end: offset + Number(task.scheduledEndMinute) }
    }).filter((item) => Number.isFinite(item.start) && item.end > 0)
  const result = new Map()
  fixed.forEach((task) => {
    const start = time.parseClockToMinutes(task.startClock || task.dueClock, task.scheduledStartMinute == null ? floor : task.scheduledStartMinute)
    const duration = Math.max(5, Number(task.estimatedMinutes) || 45)
    const end = task.status === 'running' ? Math.max(start + duration, floor + 1) : start + duration
    const conflict = hasIntervalConflict(start, end, intervals) || (start < floor && task.status !== 'running' && task.status !== 'paused')
    result.set(task.id, { ...buildScheduledTask(task, start, duration, normalizeSlot(task.preferredSlot), resolveEffectiveSlot(task, memory), bounds, conflict), scheduleConflict: conflict })
    intervals.push({ start, end, id: task.id })
  })
  const order = options.orderIds || []
  const movable = candidates.filter((task) => !fixedIds.has(task.id)).sort((a, b) => {
    if (order.length) return order.indexOf(a.id) - order.indexOf(b.id)
    return (a.scheduledStartMinute == null ? 99999 : a.scheduledStartMinute) - (b.scheduledStartMinute == null ? 99999 : b.scheduledStartMinute)
  })
  let cursor = Math.max(bounds.start, floor)
  movable.forEach((task) => {
    const duration = Math.max(5, Number(task.estimatedMinutes) || 45)
    const effectiveSlot = resolveEffectiveSlot(task, memory)
    const oldStart = task.scheduledStartMinute
    const delta = oldStart != null && oldStart >= Number(options.shiftFromMinute || 0) ? Number(options.deltaMinutes || 0) : 0
    let desired = options.orderIds ? cursor : Math.max(cursor, oldStart == null ? ((SLOT_RANGES[effectiveSlot] || [bounds.start])[0]) : oldStart + delta)
    const start = findGap(desired, Number.MAX_SAFE_INTEGER, duration, intervals, bounds.breakMinutes)
    result.set(task.id, buildScheduledTask(task, start, duration, normalizeSlot(task.preferredSlot), effectiveSlot, bounds, false))
    intervals.push({ start, end: start + duration, id: task.id })
    cursor = start + duration + bounds.breakMinutes
  })
  return tasks.map((task) => result.get(task.id) || task)
}

function buildPlanSummary(scheduled, mode, language = i18n.getLang()) {
  if (!scheduled.length) return i18n.translate('scheduleEmpty', language)
  const total = scheduled.reduce((sum, task) => sum + (Number(task.estimatedMinutes) || 0), 0)
  return i18n.translate('scheduleSummary', language, { mode: presentation.modeText(mode, language), count: scheduled.length, duration: time.formatDuration(total, language) })
}

function buildAdviceBubbles(scheduled, mode, memory, language = i18n.getLang()) {
  if (!scheduled.length) return [i18n.translate('adviceEmpty', language)]
  const first = scheduled[0]
  const overflowCount = scheduled.filter(task => task.scheduleOverflow).length
  const bubbles = [i18n.translate('adviceStart', language, { title: first.title, clock: first.scheduledStart })]
  if (mode === 'relaxed') bubbles.push(i18n.translate('adviceRelaxed', language))
  if (overflowCount) bubbles.push(i18n.translate('adviceOverflow', language, { count: overflowCount }))
  else {
    const prefs = memory && memory.userPreferences || {}
    bubbles.push(i18n.translate('adviceBreak', language, { minutes: prefs.defaultBreakMinutes == null ? 10 : Number(prefs.defaultBreakMinutes) }))
  }
  return bubbles.slice(0, 3)
}

function completionFeedback(task) {
  const estimate = Number(task.estimatedMinutes) || 1
  const actual = Math.max(1, Number(task.actualMinutes) || estimate)
  const diff = actual - estimate
  const ratio = Math.abs(diff) / estimate
  let level = '准'
  if (ratio > 0.6) {
    level = diff > 0 ? '严重超' : '明显提前'
  } else if (ratio > 0.2) {
    level = diff > 0 ? '小超' : '提前'
  }

  return {
    level,
    diffMinutes: diff,
    ratio,
    text: diff === 0
      ? '预估和实际完全一致'
      : `${diff > 0 ? '超出' : '提前'} ${time.formatDuration(Math.abs(diff))}`
  }
}

function learnFromCompletion(memory, task) {
  const next = JSON.parse(JSON.stringify(memory || {}))
  const key = categorizeTask(task)
  const existing = next.taskPatterns && next.taskPatterns[key]
    ? next.taskPatterns[key]
    : { samples: 0, avgActualMinutes: 0 }
  const actual = Math.max(1, Number(task.actualMinutes) || Number(task.estimatedMinutes) || 45)
  const samples = Math.min((Number(existing.samples) || 0) + 1, 99)
  const previousWeight = Math.max(samples - 1, 0)
  const avg = previousWeight
    ? (Number(existing.avgActualMinutes || actual) * previousWeight + actual) / samples
    : actual
  const slot = task.scheduledStartMinute != null
    ? time.slotOfMinute(task.scheduledStartMinute)
    : normalizeSlot(task.preferredSlot)

  next.taskPatterns = {
    ...(next.taskPatterns || {}),
    [key]: {
      samples,
      avgActualMinutes: Math.round(avg),
      lastActualMinutes: actual,
      preferredSlot: slot,
      lastTitle: task.title,
      updatedAt: Date.now()
    }
  }

  const slotStats = next.slotStats || {}
  const currentSlot = slotStats[slot] || { completed: 0, totalActualMinutes: 0 }
  slotStats[slot] = {
    completed: Number(currentSlot.completed || 0) + 1,
    totalActualMinutes: Number(currentSlot.totalActualMinutes || 0) + actual
  }
  next.slotStats = slotStats
  next.updatedAt = Date.now()
  return next
}

function shiftRemainingTasks(tasks, completedTask, deltaMinutes) {
  if (!deltaMinutes || !completedTask || completedTask.scheduledEndMinute == null) {
    return tasks
  }
  const completedDateKey = completedTask.dateKey || time.todayKey()

  return tasks.map((task) => {
    if (
      task.status === 'completed' ||
      task.status === 'deleted' ||
      task.id === completedTask.id ||
      (task.dateKey || time.todayKey()) !== completedDateKey ||
      task.scheduledStartMinute == null ||
      task.scheduledStartMinute < completedTask.scheduledEndMinute
    ) {
      return task
    }

    const start = Math.max(0, task.scheduledStartMinute + deltaMinutes)
    const end = Math.max(start + 5, task.scheduledEndMinute + deltaMinutes)
    return {
      ...task,
      scheduledStartMinute: start,
      scheduledEndMinute: end,
      scheduledStart: time.formatMinutesAsClock(start),
      scheduledEnd: time.formatMinutesAsClock(end),
      updatedAt: Date.now()
    }
  })
}

module.exports = {
  applySchedule,
  replanTasks,
  buildAdviceBubbles,
  categorizeTask,
  completionFeedback,
  learnFromCompletion,
  normalizePriority,
  normalizeSlot,
  priorityText,
  recommendDuration,
  shiftRemainingTasks,
  selectTasksForMode,
  withCompletionStats,
  resolveEffectiveSlot,
  currentMinute,
  reflowRemainingTasks
}
