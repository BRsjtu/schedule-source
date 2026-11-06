const { AsyncLocalStorage } = require('node:async_hooks')
const time = require('../../utils/time')

const contexts = new AsyncLocalStorage()
time.setTimeContextProvider(() => contexts.getStore())

function normalizeTimeContext(value) {
  if (!value || typeof value !== 'object') return null
  const offset = Number(value.timezoneOffsetMinutes)
  const hasOffset = value.timezoneOffsetMinutes != null && Number.isFinite(offset) && Math.abs(offset) <= 840
  let timeZone = ''
  if (typeof value.timeZone === 'string' && value.timeZone.length < 100) {
    try { timeZone = new Intl.DateTimeFormat('en', { timeZone: value.timeZone }).resolvedOptions().timeZone } catch (error) { /* use device offset */ }
  }
  if (!timeZone && !hasOffset) return null
  return { timeZone, ...(hasOffset ? { timezoneOffsetMinutes: offset } : {}), capturedAt: Number(value.capturedAt) || Date.now() }
}

function withTimeContext(value, callback) {
  return contexts.run(normalizeTimeContext(value), callback)
}

module.exports = { normalizeTimeContext, withTimeContext }
