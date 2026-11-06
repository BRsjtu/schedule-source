const crypto = require('node:crypto')
const storageDomain = require('../../utils/storage')
const { normalizeTimeContext } = require('./clock')

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function createId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
}

function normalizeState(value) {
  const source = value && typeof value === 'object' ? value : {}
  return {
    language: source.language === 'en' ? 'en' : 'zh',
    timeContext: normalizeTimeContext(source.timeContext),
    tasks: Array.isArray(source.tasks) ? source.tasks.slice(0, 500) : [],
    history: Array.isArray(source.history) ? source.history.slice(0, 120) : [],
    memory: storageDomain.defaultMemory && source.memory
      ? normalizeMemory(source.memory)
      : normalizeMemory(source.memory),
    messages: Array.isArray(source.messages) ? source.messages.slice(-80) : [],
    draft: source.draft && typeof source.draft === 'object' ? source.draft : null,
    scheduleReport: source.scheduleReport && typeof source.scheduleReport === 'object' ? source.scheduleReport : null,
    planMode: ['relaxed', 'flexible', 'suggestion'].includes(source.planMode)
      ? source.planMode
      : 'flexible'
  }
}

function normalizeMemory(value) {
  return storageDomain.normalizeMemory(value)
}

function appendMessage(state, message) {
  const next = normalizeState(state)
  const previous = next.messages[next.messages.length - 1]
  if (previous && previous.role === message.role && previous.content === message.content) {
    return next
  }
  next.messages.push({ id: createId('msg'), createdAt: Date.now(), ...message })
  next.messages = next.messages.slice(-80)
  return next
}

function memorySnapshot(memory) {
  const normalized = normalizeMemory(memory)
  return {
    preferences: normalized.userPreferences,
    durationOverrides: normalized.durationOverrides || {},
    taskPatterns: Object.entries(normalized.taskPatterns).slice(0, 12).map(([key, item]) => ({ key, ...item })),
    secretaryFacts: normalized.secretaryFacts.slice(0, 12).map((item) => ({
      kind: item.kind,
      key: item.key,
      value: item.value,
      confidence: item.confidence,
      evidence: item.evidence
    })),
    recentNotes: normalized.agentNotes.slice(0, 8)
  }
}

module.exports = { appendMessage, clone, createId, memorySnapshot, normalizeMemory, normalizeState }
