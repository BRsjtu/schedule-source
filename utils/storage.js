const time = require('./time')

const TASKS_KEY = 'scheduleTasks'
const HISTORY_KEY = 'scheduleHistory'
const MEMORY_KEY = 'scheduleLongTermMemory'
const MESSAGES_KEY = 'scheduleAgentMessages'
const DRAFT_KEY = 'schedulePendingDraft'
const PLAN_MODE_KEY = 'schedulePlanMode'
const REPORT_KEY = 'scheduleReplanReport'

const fallbackStore = {}
let syncSuspended = 0

function canUseWxStorage() {
  return typeof wx !== 'undefined' && wx.getStorageSync && wx.setStorageSync
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function read(key, fallbackValue) {
  if (!canUseWxStorage()) {
    return Object.prototype.hasOwnProperty.call(fallbackStore, key)
      ? clone(fallbackStore[key])
      : clone(fallbackValue)
  }

  try {
    const value = wx.getStorageSync(key)
    return value === '' || value == null ? clone(fallbackValue) : value
  } catch (error) {
    return clone(fallbackValue)
  }
}

function write(key, value) {
  if (!canUseWxStorage()) {
    fallbackStore[key] = clone(value)
    return
  }
  wx.setStorageSync(key, value)
  if (!syncSuspended) {
    try {
      require('./runtime').queueStateSync()
    } catch (error) {
      console.error('queue runtime state sync failed', error)
    }
  }
}

function createId(prefix) {
  const random = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now()}_${random}`
}

// Write a timer/completion transition as one sync snapshot.
function saveTaskState(state) {
  syncSuspended += 1
  try {
    saveTasks(state.tasks)
    saveHistory(state.history)
    saveMemory(state.memory)
  } finally { syncSuspended -= 1 }
  if (canUseWxStorage()) require('./runtime').queueStateSync()
}

function defaultMemory() {
  return {
    version: 1,
    updatedAt: Date.now(),
    userPreferences: {
      workdayStart: '09:00',
      workdayEnd: '22:00',
      defaultBreakMinutes: 10,
      dynamicPlan: true,
      planMode: 'flexible',
      tone: '温和、直接、不给压力'
    },
    taskPatterns: {},
    slotStats: {
      morning: { completed: 0, totalActualMinutes: 0 },
      afternoon: { completed: 0, totalActualMinutes: 0 },
      evening: { completed: 0, totalActualMinutes: 0 }
    },
    secretaryFacts: [],
    agentNotes: []
  }
}

function preferenceKey(key) {
  return ({ breakMinutes: 'defaultBreakMinutes', '任务间隔': 'defaultBreakMinutes', '休息间隔': 'defaultBreakMinutes', '任务间休息': 'defaultBreakMinutes', workStart: 'workdayStart', '开始时间': 'workdayStart', workEnd: 'workdayEnd', '结束时间': 'workdayEnd' })[key] || key
}

function normalizeMemory(memory) {
  const base = defaultMemory()
  const next = memory && typeof memory === 'object' ? memory : {}
  const prefs = { ...base.userPreferences, ...(next.userPreferences || {}) }
  const minutes = Number(prefs.defaultBreakMinutes)
  prefs.defaultBreakMinutes = Number.isFinite(minutes) && minutes >= 0 ? minutes : base.userPreferences.defaultBreakMinutes
  const settingKeys = ['workdayStart', 'workdayEnd', 'defaultBreakMinutes', 'dynamicPlan', 'tone']
  return {
    ...base,
    ...next,
    userPreferences: prefs,
    taskPatterns: {
      ...base.taskPatterns,
      ...(next.taskPatterns || {})
    },
    slotStats: {
      ...base.slotStats,
      ...(next.slotStats || {})
    },
    secretaryFacts: Array.isArray(next.secretaryFacts) ? next.secretaryFacts.slice(0, 60).map(fact => settingKeys.includes(fact.key) ? { ...fact, value: prefs[fact.key] } : fact) : [],
    agentNotes: Array.isArray(next.agentNotes) ? next.agentNotes.slice(0, 30) : []
  }
}

function getTasks() {
  const tasks = read(TASKS_KEY, [])
  return Array.isArray(tasks) ? tasks : []
}

function saveTasks(tasks) {
  write(TASKS_KEY, Array.isArray(tasks) ? tasks : [])
}

function getHistory() {
  const history = read(HISTORY_KEY, [])
  return Array.isArray(history) ? history : []
}

function saveHistory(history) {
  write(HISTORY_KEY, Array.isArray(history) ? history.slice(0, 120) : [])
}

function getMemory() {
  return normalizeMemory(read(MEMORY_KEY, defaultMemory()))
}

function saveMemory(memory) {
  write(MEMORY_KEY, normalizeMemory({ ...memory, updatedAt: Date.now() }))
}

function resetMemory() {
  const memory = defaultMemory()
  write(MEMORY_KEY, memory)
  return memory
}

function getMessages() {
  const messages = read(MESSAGES_KEY, [])
  return Array.isArray(messages) ? messages : []
}

function saveMessages(messages) {
  write(MESSAGES_KEY, Array.isArray(messages) ? messages.slice(-80) : [])
}

function appendMessage(message) {
  const messages = getMessages()
  const next = [
    ...messages,
    {
      id: createId('msg'),
      createdAt: Date.now(),
      ...message
    }
  ].slice(-80)
  saveMessages(next)
  return next
}

function clearMessages() {
  write(MESSAGES_KEY, [])
}

function getDraft() {
  return read(DRAFT_KEY, null)
}

function saveDraft(draft) {
  write(DRAFT_KEY, draft || null)
}

function clearDraft() {
  write(DRAFT_KEY, null)
}

function getPlanMode() {
  const memory = getMemory()
  return read(PLAN_MODE_KEY, memory.userPreferences.planMode || 'flexible')
}

function savePlanMode(mode) {
  write(PLAN_MODE_KEY, mode || 'flexible')
  const memory = getMemory()
  memory.userPreferences.planMode = mode || 'flexible'
  saveMemory(memory)
}

function buildMemorySnapshot(memory) {
  const normalized = normalizeMemory(memory)
  const patterns = Object.keys(normalized.taskPatterns)
    .map((key) => {
      const item = normalized.taskPatterns[key]
      return {
        key,
        avgActualMinutes: item.avgActualMinutes,
        samples: item.samples,
        lastActualMinutes: item.lastActualMinutes,
        preferredSlot: item.preferredSlot
      }
    })
    .slice(0, 12)

  return {
    preferences: normalized.userPreferences,
    durationOverrides: normalized.durationOverrides || {},
    taskPatterns: patterns,
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

function normalizeMemoryFact(action) {
  const key = String(action.key || action.title || '').trim()
  const kind = String(action.kind || 'preference').trim() || 'preference'
  return {
    id: action.id || createId('fact'),
    kind,
    key: key || kind,
    value: action.value,
    evidence: action.evidence || action.reason || '',
    confidence: Math.max(0.1, Math.min(Number(action.confidence) || 0.8, 1)),
    source: action.source || 'agent',
    createdAt: action.createdAt || Date.now(),
    updatedAt: Date.now(),
    useCount: Number(action.useCount || 0)
  }
}

function upsertMemoryFact(memory, action) {
  const next = normalizeMemory(memory)
  const fact = normalizeMemoryFact(action)
  const facts = next.secretaryFacts || []
  const existingIndex = facts.findIndex((item) => (
    String(item.kind) === String(fact.kind) &&
    String(item.key) === String(fact.key)
  ))

  if (existingIndex >= 0) {
    facts[existingIndex] = {
      ...facts[existingIndex],
      value: fact.value,
      evidence: fact.evidence || facts[existingIndex].evidence,
      confidence: Math.max(Number(facts[existingIndex].confidence || 0), fact.confidence),
      updatedAt: Date.now()
    }
  } else {
    facts.unshift(fact)
  }

  next.secretaryFacts = facts
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    .slice(0, 60)
  next.agentNotes = [
    {
      id: createId('note'),
      key: fact.key,
      value: fact.value,
      evidence: fact.evidence,
      createdAt: Date.now()
    },
    ...(next.agentNotes || [])
  ].slice(0, 30)
  next.updatedAt = Date.now()
  return next
}

function ensureSeedMessage(content) {
  const messages = getMessages()
  if (messages.length) {
    return messages
  }

  return appendMessage({
    role: 'assistant',
    content: content || '把今天要做的事直接丢给我就行。我会先整理成行动计划，你确认后再写入日程和记忆。'
  })
}

function createEmptyTask(title) {
  return {
    id: createId('task'),
    title: String(title || '').trim() || '未命名任务',
    description: '',
    priority: 'medium',
    estimatedMinutes: 45,
    actualMinutes: 0,
    status: 'todo',
    dateKey: time.todayKey(),
    preferredSlot: 'any',
    scheduledStart: '',
    scheduledEnd: '',
    scheduledStartMinute: null,
    scheduledEndMinute: null,
    stuckCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

function exportState() {
  return {
    language: require('./i18n').getLang(),
    timeContext: time.captureTimeContext(),
    tasks: getTasks(),
    history: getHistory(),
    memory: getMemory(),
    messages: getMessages(),
    draft: getDraft(),
    scheduleReport: getScheduleReport(),
    planMode: getPlanMode()
  }
}

function importState(state) {
  const next = state && typeof state === 'object' ? state : {}
  syncSuspended += 1
  try {
    write(TASKS_KEY, Array.isArray(next.tasks) ? next.tasks : [])
    write(HISTORY_KEY, Array.isArray(next.history) ? next.history : [])
    write(MEMORY_KEY, normalizeMemory(next.memory))
    write(MESSAGES_KEY, Array.isArray(next.messages) ? next.messages : [])
    write(DRAFT_KEY, next.draft || null)
    write(REPORT_KEY, next.scheduleReport || null)
    write(PLAN_MODE_KEY, next.planMode || 'flexible')
  } finally {
    syncSuspended -= 1
  }
  return exportState()
}

function getScheduleReport() { return read(REPORT_KEY, null) }
function saveScheduleReport(report) { write(REPORT_KEY, report || null) }

module.exports = {
  getScheduleReport,
  saveScheduleReport,
  saveTaskState,
  DRAFT_KEY,
  HISTORY_KEY,
  MEMORY_KEY,
  MESSAGES_KEY,
  PLAN_MODE_KEY,
  TASKS_KEY,
  appendMessage,
  buildMemorySnapshot,
  clearDraft,
  clearMessages,
  createEmptyTask,
  createId,
  defaultMemory,
  normalizeMemory,
  preferenceKey,
  ensureSeedMessage,
  exportState,
  getDraft,
  getHistory,
  getMemory,
  getMessages,
  getPlanMode,
  getTasks,
  importState,
  resetMemory,
  saveDraft,
  saveHistory,
  saveMemory,
  saveMessages,
  savePlanMode,
  saveTasks,
  upsertMemoryFact
}
