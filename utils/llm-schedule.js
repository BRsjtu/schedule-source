const scheduler = require('./scheduler')
const time = require('./time')

function locked(task) { return Boolean(task.dueClock || task.startClock || ['running', 'paused'].includes(task.status)) }
function duration(task) { return Math.max(5, Number(task.estimatedMinutes) || 45) }

function context(tasks, options = {}) {
  const dateKey = options.dateKey || time.todayKey()
  const mode = ['relaxed', 'flexible', 'suggestion'].includes(options.mode) ? options.mode : 'flexible'
  const prefs = options.memory && options.memory.userPreferences || {}
  const bounds = { start: time.parseClockToMinutes(prefs.workdayStart, 540), end: time.parseClockToMinutes(prefs.workdayEnd, 1320), breakMinutes: Math.max(0, Number(prefs.defaultBreakMinutes) || 0) }
  const floor = Math.max(bounds.start, scheduler.currentMinute(dateKey, options.now))
  const pending = tasks.filter(task => !['deleted', 'completed'].includes(task.status) && (task.dateKey || time.todayKey()) === dateKey)
  const fixed = pending.filter(locked)
  const movable = pending.filter(task => !locked(task))
  const blocks = fixed.map(task => {
    const start = time.parseClockToMinutes(task.startClock || task.dueClock, task.scheduledStartMinute == null ? floor : Number(task.scheduledStartMinute))
    const end = Math.max(start + duration(task), Number(task.scheduledEndMinute) || 0, task.status === 'running' ? floor + 1 : 0)
    return { taskId: task.id, title: task.title, start, end }
  })
  tasks.filter(task => !['deleted', 'completed'].includes(task.status) && task.dateKey === time.addDays(dateKey, -1) && Number(task.scheduledEndMinute) > 1440)
    .forEach(task => blocks.push({ taskId: task.id, title: task.title, start: 0, end: Number(task.scheduledEndMinute) - 1440, carryover: true }))
  return { dateKey, mode, bounds, floor, pending, fixed, movable, blocks }
}

function bilingual(value, label) {
  if (!value || ['zh', 'en'].some(lang => typeof value[lang] !== 'string' || !value[lang].trim())) throw new Error(label + ' must have zh and en text')
  return { zh: value.zh.trim().slice(0, 700), en: value.en.trim().slice(0, 700) }
}

// The model chooses the times. These checks only accept/reject hard constraints;
// they never sort tasks or replace a model time with a rule-generated time.
function apply(tasks, proposal, options = {}) {
  const ctx = context(tasks, options)
  const summary = bilingual(proposal.summary, 'summary')
  if (!Array.isArray(proposal.placements) || !Array.isArray(proposal.deferred)) throw new Error('placements and deferred must be arrays')
  const movable = new Map(ctx.movable.map(task => [task.id, task]))
  const selected = new Map(), deferred = new Map()
  for (const item of proposal.placements) {
    const task = movable.get(item.taskId)
    if (!task || selected.has(item.taskId)) throw new Error('unknown, fixed or duplicate task: ' + item.taskId)
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(item.start || '')) throw new Error('start must be HH:MM')
    const start = time.parseClockToMinutes(item.start, null), end = start + duration(task)
    if (start == null || start < ctx.floor || end > ctx.bounds.end || start >= 1440) throw new Error('time outside available hours: ' + task.title)
    selected.set(item.taskId, { start, end, reason: bilingual(item.reason, 'task reason') })
  }
  for (const item of proposal.deferred) {
    if (!movable.has(item.taskId) || selected.has(item.taskId) || deferred.has(item.taskId)) throw new Error('invalid deferred task: ' + item.taskId)
    deferred.set(item.taskId, bilingual(item.reason, 'deferred reason'))
  }
  if (selected.size + deferred.size !== movable.size) throw new Error('every flexible task needs a placement or a deferred reason')
  if (ctx.mode === 'relaxed' && selected.size > 3) throw new Error('relaxed mode allows at most three flexible tasks')
  const intervals = ctx.blocks.concat(Array.from(selected, ([taskId, slot]) => ({ taskId, ...slot })))
  for (const [taskId, slot] of selected) {
    if (intervals.some(other => other.taskId !== taskId && slot.start < other.end + ctx.bounds.breakMinutes && slot.end + ctx.bounds.breakMinutes > other.start)) {
      throw new Error('overlap or insufficient break: ' + movable.get(taskId).title)
    }
  }
  const now = options.now == null ? Date.now() : options.now
  const next = tasks.map(task => {
    if (ctx.fixed.some(item => item.id === task.id) && !['running', 'paused'].includes(task.status)) {
      const block = ctx.blocks.find(item => item.taskId === task.id)
      if (task.scheduledStartMinute === block.start && task.scheduledEndMinute === block.end) return task
      return { ...task, status: 'planned', scheduledStartMinute: block.start, scheduledEndMinute: block.end,
        scheduledStart: time.formatMinuteOfDay(block.start), scheduledEnd: time.formatMinuteOfDay(block.end), updatedAt: now }
    }
    const slot = selected.get(task.id)
    if (slot) return { ...task, status: 'planned', effectiveSlot: time.slotOfMinute(slot.start),
      scheduledStartMinute: slot.start, scheduledEndMinute: slot.end, scheduledStart: time.formatMinuteOfDay(slot.start), scheduledEnd: time.formatMinuteOfDay(slot.end),
      scheduledStartDateKey: ctx.dateKey, scheduledEndDateKey: ctx.dateKey, scheduledStartDayOffset: 0, scheduledEndDayOffset: 0,
      crossesMidnight: false, scheduleConflict: false, scheduleOverflow: false, updatedAt: now }
    if (deferred.has(task.id) && ctx.mode === 'flexible') return { ...task, status: 'todo', scheduledStart: '', scheduledEnd: '', scheduledStartMinute: null, scheduledEndMinute: null,
      scheduledStartDateKey: '', scheduledEndDateKey: '', scheduledStartDayOffset: 0, scheduledEndDayOffset: 0, crossesMidnight: false, scheduleConflict: false, scheduleOverflow: false, updatedAt: now }
    return task
  })
  const previous = new Map(tasks.map(task => [task.id, task]))
  const entries = ctx.fixed.concat(ctx.movable.filter(task => selected.has(task.id))).map(task => {
    const slot = selected.get(task.id), old = previous.get(task.id)
    const block = ctx.blocks.find(item => item.taskId === task.id)
    return { id: task.id, title: task.title, locked: locked(task), reason: slot ? 'llm' : 'fixed', reasonCopy: slot && slot.reason,
      priority: scheduler.normalizePriority(task.priority), slot: slot ? time.slotOfMinute(slot.start) : time.slotOfMinute(block.start),
      beforeStart: old.scheduledStartMinute, beforeEnd: old.scheduledEndMinute,
      afterStart: slot ? slot.start : ['running', 'paused'].includes(task.status) ? old.scheduledStartMinute : block.start,
      afterEnd: slot ? slot.end : ['running', 'paused'].includes(task.status) ? old.scheduledEndMinute : block.end,
      conflict: !slot && (Boolean(task.scheduleConflict) || ctx.blocks.some(other => other.taskId !== task.id && block.start < other.end && block.end > other.start)),
      overflow: !slot && block.end > ctx.bounds.end }
  }).sort((a, b) => (a.afterStart || 0) - (b.afterStart || 0))
  const deferredEntries = ctx.movable.filter(task => deferred.has(task.id)).map(task => ({ id: task.id, title: task.title, reasonCopy: deferred.get(task.id),
    beforeStart: task.scheduledStartMinute, beforeEnd: task.scheduledEndMinute, afterStart: null, afterEnd: null, reason: 'llm', priority: scheduler.normalizePriority(task.priority) }))
  const changes = entries.filter(item => item.beforeStart !== item.afterStart || item.beforeEnd !== item.afterEnd)
  if (ctx.mode === 'flexible') changes.push(...deferredEntries.filter(item => item.beforeStart != null))
  const report = { dateKey: ctx.dateKey, mode: ctx.mode, createdAt: now, engine: options.engine || 'llm', model: options.model || '', summary,
    changedCount: ctx.mode === 'suggestion' ? 0 : changes.length, plannedCount: entries.length, fixedCount: ctx.fixed.length, remainingCount: deferred.size,
    entries, changes: ctx.mode === 'suggestion' ? [] : changes, deferred: deferredEntries,
    workdayStart: time.formatMinuteOfDay(ctx.bounds.start), workdayEnd: time.formatMinuteOfDay(ctx.bounds.end), breakMinutes: ctx.bounds.breakMinutes,
    conflictCount: entries.filter(item => item.conflict).length, overflowCount: entries.filter(item => item.overflow).length }
  return { tasks: ctx.mode === 'suggestion' ? tasks : next, report }
}

module.exports = { context, apply, duration, locked }
