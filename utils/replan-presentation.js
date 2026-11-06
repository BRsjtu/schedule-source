const i18n = require('./i18n')
const time = require('./time')

function period(start, end) {
  return start == null || end == null ? i18n.t('notScheduled')
    : `${time.formatScheduleMinute(start)}–${time.formatScheduleMinute(end)}`
}

function entry(item) {
  const reasons = { fixed: 'replanFixedReason', preference: 'replanPreferenceReason', memory: 'replanMemoryReason',
    pattern: 'replanPatternReason', rate: 'replanRateReason', priority: 'replanPriorityReason' }
  return { ...item, beforeText: period(item.beforeStart, item.beforeEnd), afterText: period(item.afterStart, item.afterEnd),
    reasonText: item.reasonCopy && item.reasonCopy[i18n.getLang()] || i18n.tf(reasons[item.reason] || 'replanPriorityReason', { slot: time.slotText(item.slot), rate: item.rate }) + (item.outsidePreferred ? i18n.t('replanFallbackReason') : ''),
    detailText: `${i18n.priorityText(item.priority)} · ${time.formatDuration(item.afterEnd - item.afterStart)}` }
}

function report(value, dateKey) {
  if (!value || value.dateKey !== dateKey) return null
  const suggestion = value.mode === 'suggestion'
  let title = i18n.tf(suggestion ? 'replanSuggested' : value.changedCount ? 'replanChanged' : 'replanNoChange', { count: value.changedCount })
  const body = !value.plannedCount ? i18n.t('replanEmpty')
    : value.fixedCount === value.plannedCount && !value.remainingCount ? i18n.t('replanAllFixed')
    : suggestion ? i18n.t('replanSuggestionBody') : !value.changedCount ? i18n.t('replanSameReason') : i18n.t('replanApplied')
  return { ...value, title, body: value.summary && value.summary[i18n.getLang()] || body,
    sourceText: value.engine === 'llm' ? i18n.t('smartReplanLabel') : '', timeText: time.formatTimestamp(value.createdAt),
    basis: i18n.tf('replanBasis', { start: value.workdayStart, end: value.workdayEnd, minutes: value.breakMinutes }),
    keptText: i18n.tf('replanKept', { count: value.fixedCount, remaining: value.remainingCount }),
    warning: value.conflictCount || value.overflowCount ? i18n.tf('replanWarnings', { conflicts: value.conflictCount, late: value.overflowCount }) : '',
    changes: suggestion ? [] : value.changes.map(entry), deferred: (value.deferred || []).map(entry) }
}

module.exports = { report, entry }
