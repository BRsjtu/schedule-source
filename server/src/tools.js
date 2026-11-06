const i18n = require('../../utils/i18n')
const systemCopy = require('../../utils/system-copy')
const scheduler = require('../../utils/scheduler')
const lifecycle = require('../../utils/task-lifecycle')
const time = require('../../utils/time')
const llmSchedule = require('../../utils/llm-schedule')
const { createId, normalizeMemory, normalizeState } = require('./state')

const ALLOWED_ACTIONS = new Set([
  'create_task', 'update_task', 'delete_task', 'complete_task', 'reschedule_tasks', 'remember_preference'
])

function findTask(tasks, action) {
  if (action.taskId || action.id) return tasks.find((task) => task.id === (action.taskId || action.id))
  const match = String(action.titleMatch || action.title || '').trim().toLowerCase()
  return match ? tasks.find((task) => String(task.title || '').toLowerCase().includes(match)) : null
}

function newTask(action, state) {
  const task = {
    id: action.createdTaskId || createId('task'),
    title: String(action.title || action.name || '').trim() || i18n.translate('untitledTask', state.language),
    description: action.description || action.note || '',
    priority: scheduler.normalizePriority(action.priority),
    estimatedMinutes: 45,
    actualMinutes: 0,
    status: 'todo',
    dateKey: action.dateKey || action.dueDate || time.todayKey(),
    preferredSlot: scheduler.normalizeSlot(action.preferredSlot || action.timeSlot),
    dueClock: action.dueClock || '',
    scheduledStart: '',
    scheduledEnd: '',
    scheduledStartMinute: null,
    scheduledEndMinute: null,
    stuckCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  const recommended = scheduler.recommendDuration(task, state.history, state.memory, state.language)
  task.recommendationBasisKey = recommended.basisKey
  task.recommendationBasisParams = recommended.basisParams
  task.recommendationBasis = recommended.basis
  task.estimatedMinutes = Math.max(5, Number(action.estimatedMinutes || action.durationMinutes || recommended.minutes))
  return task
}

function remember(memory, action) {
  action = { ...action, key: require('../../utils/storage').preferenceKey(action.key) }
  const next = normalizeMemory(memory)
  if (['workdayStart', 'workdayEnd', 'defaultBreakMinutes', 'dynamicPlan', 'tone'].includes(action.key)) {
    next.userPreferences[action.key] = action.value
  }
  const fact = {
    id: createId('fact'),
    kind: String(action.kind || 'preference'),
    key: String(action.key || action.title || action.kind || 'preference'),
    value: action.value,
    evidence: action.evidence || action.reason || '',
    confidence: Math.max(0.1, Math.min(Number(action.confidence) || 0.8, 1)),
    source: 'server_agent',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    useCount: 0
  }
  const index = next.secretaryFacts.findIndex((item) => item.key === fact.key)
  if (index >= 0) next.secretaryFacts[index] = { ...next.secretaryFacts[index], ...fact, id: next.secretaryFacts[index].id }
  else next.secretaryFacts.unshift(fact)
  next.secretaryFacts = next.secretaryFacts.slice(0, 60)
  next.agentNotes.unshift({ id: createId('note'), key: fact.key, value: fact.value, evidence: fact.evidence, createdAt: Date.now() })
  next.agentNotes = next.agentNotes.slice(0, 30)
  next.updatedAt = Date.now()
  return next
}

function executePlan(inputState, draft, language, options = {}) {
  let state = normalizeState(inputState)
  language = language || draft.language || state.language
  state.language = language === 'en' ? 'en' : 'zh'
  const changes = []
  const changeDetails = []
  function record(type, params) { const detail = { type, params }; changeDetails.push(detail); changes.push(systemCopy.changeText(detail, language)) }
  const affectedDates = new Set()
  let shouldSchedule = false
  let scheduleMode = state.planMode

  for (const action of [...(draft.actions || []), ...(draft.memoryUpdates || []).map((item) => ({ ...item, type: 'remember_preference' }))]) {
    if (!ALLOWED_ACTIONS.has(action.type)) throw new Error(`不支持的 Agent 动作：${action.type}`)
    if (action.type === 'create_task') {
      const task = newTask(action, state)
      state.tasks.unshift(task)
      affectedDates.add(task.dateKey)
      shouldSchedule = true
      record('create', { title: task.title })
    } else if (action.type === 'update_task') {
      const task = findTask(state.tasks, action)
      if (!task) { record('missing', { operationKey: 'update', title: action.titleMatch || action.title || i18n.translate('untitledTask', language) }); continue }
      const allowed = ['title', 'description', 'dateKey', 'dueClock']
      const patch = {}
      allowed.forEach((key) => { if (action[key] != null) patch[key] = action[key] })
      if (action.priority) patch.priority = scheduler.normalizePriority(action.priority)
      if (action.preferredSlot || action.timeSlot) patch.preferredSlot = scheduler.normalizeSlot(action.preferredSlot || action.timeSlot)
      if (action.estimatedMinutes || action.durationMinutes) patch.estimatedMinutes = Math.max(5, Number(action.estimatedMinutes || action.durationMinutes))
      state.tasks = state.tasks.map((item) => item.id === task.id ? { ...item, ...patch, updatedAt: Date.now() } : item)
      affectedDates.add(task.dateKey || time.todayKey())
      affectedDates.add(patch.dateKey || task.dateKey || time.todayKey())
      shouldSchedule = true
      record('update', { title: task.title })
    } else if (action.type === 'delete_task') {
      const task = findTask(state.tasks, action)
      if (!task) { record('missing', { operationKey: 'delete', title: action.titleMatch || action.title || i18n.translate('untitledTask', language) }); continue }
      state.tasks = state.tasks.map((item) => item.id === task.id ? { ...item, status: 'deleted', updatedAt: Date.now() } : item)
      affectedDates.add(task.dateKey || time.todayKey())
      shouldSchedule = true
      record('delete', { title: task.title })
    } else if (action.type === 'complete_task') {
      const task = findTask(state.tasks, action)
      if (!task) { record('missing', { operationKey: 'complete', title: action.titleMatch || action.title || i18n.translate('untitledTask', language) }); continue }
      state = lifecycle.completeState(state, task.id, { actualMinutes: action.actualMinutes, adjustPlan: action.adjustPlan, feedback: action.feedback })
      record('complete', { title: task.title })
    } else if (action.type === 'reschedule_tasks') {
      scheduleMode = ['relaxed', 'flexible', 'suggestion'].includes(action.mode) ? action.mode : scheduleMode
      affectedDates.add(action.dateKey || time.todayKey())
      shouldSchedule = true
      record('reschedule')
    } else if (action.type === 'remember_preference') {
      state.memory = remember(state.memory, action)
      record('remember')
    }
  }

  if (shouldSchedule && options.schedule !== false) {
    for (const dateKey of (affectedDates.size ? affectedDates : new Set([time.todayKey()]))) {
      const replan = (draft.actions || []).find((action) => action.type === 'reschedule_tasks' && (action.dateKey || time.todayKey()) === dateKey)
      if (draft.unifiedSchedule && !replan) continue
      const planOptions = { mode: scheduleMode, memory: state.memory, history: state.history, dateKey, language }
      const plan = replan && replan.llmPlan
        ? llmSchedule.apply(state.tasks, replan.llmPlan, { ...planOptions, model: replan.llmModel, engine: replan.llmEngine })
        : (replan ? scheduler.replanTasks : scheduler.applySchedule)(state.tasks, planOptions)
      state.tasks = plan.tasks
      if (replan) {
        state.scheduleReport = plan.report
        record(scheduleMode === 'suggestion' ? 'suggestions' : 'replan', { count: scheduleMode === 'suggestion' ? plan.report.plannedCount : plan.report.changedCount, fixed: plan.report.fixedCount })
      }
    }
  }
  state.planMode = scheduleMode
  state.memory.userPreferences.planMode = scheduleMode
  state.draft = null
  return { state: normalizeState(state), changes, changeDetails }
}

module.exports = { executePlan }
