const i18n = require('./i18n')
const systemCopy = require('./system-copy')
const scheduler = require('./scheduler')
const storage = require('./storage')
const time = require('./time')
const runtime = require('./runtime')
const natural = require('./natural-language')
const lifecycle = require('./task-lifecycle')

function safeJson(value) {
  return JSON.stringify(value, null, 2)
}

function extractJsonText(value) {
  const text = String(value || '').trim()
  if (!text) {
    throw new Error('模型没有返回可解析内容')
  }

  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fencedMatch && fencedMatch[1]) {
    return fencedMatch[1].trim()
  }

  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1)
  }

  return text
}

function normalizeAction(action) {
  const typeMap = {
    create: 'create_task',
    add: 'create_task',
    update: 'update_task',
    edit: 'update_task',
    delete: 'delete_task',
    remove: 'delete_task',
    complete: 'complete_task',
    finish: 'complete_task',
    schedule: 'reschedule_tasks',
    reschedule: 'reschedule_tasks',
    remember: 'remember_preference'
  }
  const rawType = String(action.type || action.action || '').trim()
  return {
    ...action,
    type: typeMap[rawType] || rawType
  }
}

function normalizeDraft(raw, userText) {
  const actions = Array.isArray(raw.actions)
    ? raw.actions.map(normalizeAction).filter((item) => item.type)
    : []
  const memoryUpdates = Array.isArray(raw.memoryUpdates) ? raw.memoryUpdates : []

  return {
    id: storage.createId('draft'),
    createdAt: Date.now(),
    source: raw.source || 'ai',
    userText,
    reply: raw.reply || raw.summary || i18n.t('preparedPlan'),
    needConfirmation: raw.needConfirmation !== false,
    actions,
    memoryUpdates,
    adviceBubbles: Array.isArray(raw.adviceBubbles) ? raw.adviceBubbles.slice(0, 3) : []
  }
}

function buildPrompt(userText, context) {
  return [
    '你是一个微信小程序里的轻量 AI 日程 agent。',
    '产品原则：用户用自然语言输入；你只生成结构化行动计划；小程序本地工具负责真正写入、修改、删除、排程和记忆。',
    '你要像任务调度员，不要像监工。语气温和、直接、不给压力。',
    '',
    '当前日期：' + context.today,
    '明天日期：' + context.tomorrow,
    '当前计划强度：' + context.planMode,
    '',
    '可用行动类型：',
    '1. create_task: 创建任务。字段 title, description, dateKey(YYYY-MM-DD), priority(high/medium/low/urgent), estimatedMinutes, preferredSlot(morning/afternoon/evening/any), dueClock。',
    '2. update_task: 修改任务。字段 taskId 或 titleMatch，以及要修改的字段。',
    '3. delete_task: 删除任务。字段 taskId 或 titleMatch。',
    '4. complete_task: 标记完成。字段 taskId 或 titleMatch, actualMinutes, feedback。',
    '5. reschedule_tasks: 重排待办。字段 dateKey, mode(relaxed/flexible/suggestion)。',
    '重排不要重复创建任务；先用 update_task 修改用户明确指定的新时段/优先级，再 reschedule_tasks。可用开始/结束时间与休息间隔用 remember_preference 的 key=workdayStart/workdayEnd/defaultBreakMinutes 保存，休息 value 为分钟数。',
    '6. remember_preference: 记住长期偏好。字段 key, value, evidence。',
    '',
    '要求：',
    '- 支持多意图，例如一句话里同时创建多个任务、调整计划、记住偏好。',
    '- 如果用户只是问今天怎么安排，返回 reschedule_tasks。',
    '- 创建任务时，如果用户没说时长，你要结合长期记忆和历史推断一个 estimatedMinutes。',
    '- 用户表达个人习惯、禁忌、偏好、工作节奏时，增加 remember_preference，kind 可用 time_preference、planning_rule、communication_style、task_habit。',
    '- 你像秘书一样先记事实和证据，不要把一次偶然情况当成永久规则；不确定时 confidence 低一点。',
    '- 除非用户明确说只是咨询，否则输出 actions。',
    '- 不要编造已经不存在的 taskId；如果不确定，用 titleMatch。',
    '- 只输出严格 JSON，不要 Markdown。',
    '',
    '输出 JSON 结构：',
    '{',
    '  "reply": "给用户看的简短说明",',
    '  "needConfirmation": true,',
    '  "actions": [],',
    '  "memoryUpdates": [],',
    '  "adviceBubbles": []',
    '}',
    '',
    '长期记忆快照：',
    safeJson(context.memory),
    '',
    '今天任务：',
    safeJson(context.tasks),
    '',
    '最近完成历史：',
    safeJson(context.history),
    '',
    '用户输入：',
    userText
  ].join('\n')
}

function compactTask(task) {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    priority: task.priority,
    estimatedMinutes: task.estimatedMinutes,
    actualMinutes: task.actualMinutes,
    status: task.status,
    preferredSlot: task.preferredSlot,
    scheduledStart: task.scheduledStart,
    scheduledEnd: task.scheduledEnd
  }
}

function buildContext() {
  const tasks = storage.getTasks()
  const history = storage.getHistory()
  const memory = storage.getMemory()
  return {
    today: time.todayKey(),
    tomorrow: time.addDays(time.todayKey(), 1),
    planMode: storage.getPlanMode(),
    memory: storage.buildMemorySnapshot(memory),
    tasks: tasks.filter((task) => task.status !== 'deleted').map(compactTask),
    history: history.slice(0, 12).map(compactTask)
  }
}

function fallbackDraft(userText) {
  const text = String(userText || '').trim()
  const completedTargets = storage.getTasks().filter((task) => !['completed', 'deleted'].includes(task.status) && text.toLowerCase().includes(String(task.title).toLowerCase()))
  if (completedTargets.length && /标记.*完成|标为.*完成|已经完成|已完成|完成了|做完了|搞定了|^完成|\b(?:complete|completed|finished|done)\b/i.test(text) && !/还没完成|尚未完成|未完成|不要.*标记|别.*标记|\b(?:not|don't|do not)\b/i.test(text)) {
    return normalizeDraft({
      source: 'fallback', reply: i18n.t('completionPrepared'),
      actions: completedTargets.map((task) => ({ type: 'complete_task', taskId: task.id, ...(completedTargets.length === 1 ? { actualMinutes: natural.parseDuration(text) } : {}) }))
    }, userText)
  }
  const shouldSchedule = /(排程|安排|计划|今天做什么|重排|调整)|\b(?:reschedule|replan)\b/i.test(text)
  if (shouldSchedule) {
    return normalizeDraft({
      source: 'fallback',
      reply: i18n.t('ruleReplan'),
      actions: [{ type: 'reschedule_tasks', mode: storage.getPlanMode() }]
    }, userText)
  }

  const shouldComplete = /(完成|做完|结束|搞定)/.test(text)
  if (shouldComplete) {
    return normalizeDraft({
      source: 'fallback',
      reply: i18n.t('completionPrepared'),
      actions: [{
        type: 'complete_task',
        titleMatch: text.replace(/(完成|做完|结束|搞定|了)/g, '').trim(),
        actualMinutes: natural.parseDuration(text)
      }]
    }, userText)
  }

  const dueClock = natural.parseClock(text)
  const title = natural.taskTitle(text) || text.slice(0, 28) || i18n.t('untitledTask')

  return normalizeDraft({
    source: 'fallback',
    reply: i18n.t('ruleTask'),
    actions: [{
      type: 'create_task',
      title,
      description: text,
      priority: /(重要|紧急|必须)/.test(text) ? 'high' : 'medium',
      estimatedMinutes: natural.parseDuration(text),
      dateKey: natural.parseDateKey(text),
      dueClock,
      preferredSlot: natural.preferredSlot(text, dueClock)
    }]
  }, userText)
}

async function runAgent(userText, language) {
  return runtime.plan(userText, language)
}

function findTask(tasks, action) {
  const taskId = action.taskId || action.id
  if (taskId) {
    const byId = tasks.find((task) => task.id === taskId)
    if (byId) {
      return byId
    }
  }

  const titleMatch = String(action.titleMatch || action.title || '').trim()
  if (!titleMatch) {
    return null
  }
  const normalized = titleMatch.toLowerCase()
  return tasks.find((task) => {
    const title = String(task.title || '').toLowerCase()
    return title.includes(normalized) || normalized.includes(title)
  }) || null
}

function buildTaskFromAction(action, history, memory) {
  const task = storage.createEmptyTask(action.title || action.name)
  task.description = action.description || action.note || ''
  task.priority = scheduler.normalizePriority(action.priority)
  task.preferredSlot = scheduler.normalizeSlot(action.preferredSlot || action.timeSlot)
  task.dateKey = action.dateKey || action.dueDate || natural.parseDateKey(`${action.title || ''}${action.description || ''}${action.dueClock || ''}`)

  const recommendation = scheduler.recommendDuration(task, history, memory)
  task.estimatedMinutes = Math.max(5, Number(action.estimatedMinutes || action.durationMinutes || recommendation.minutes))
  task.recommendationBasis = recommendation.basis
  task.recommendationBasisKey = recommendation.basisKey
  task.recommendationBasisParams = recommendation.basisParams
  task.dueClock = action.dueClock || ''
  return task
}

function applyUpdate(task, action, history, memory) {
  const next = { ...task, updatedAt: Date.now() }
  if (action.dateKey) next.dateKey = action.dateKey
  if (action.dueClock != null) next.dueClock = action.dueClock
  if (action.title) {
    next.title = action.title
  }
  if (action.description != null) {
    next.description = action.description
  }
  if (action.priority) {
    next.priority = scheduler.normalizePriority(action.priority)
  }
  if (action.preferredSlot || action.timeSlot) {
    next.preferredSlot = scheduler.normalizeSlot(action.preferredSlot || action.timeSlot)
  }
  if (action.estimatedMinutes || action.durationMinutes) {
    next.estimatedMinutes = Math.max(5, Number(action.estimatedMinutes || action.durationMinutes))
  } else if (!next.estimatedMinutes) {
    next.estimatedMinutes = scheduler.recommendDuration(next, history, memory).minutes
  }
  return next
}

function buildHistoryRecord(task) {
  const feedback = scheduler.completionFeedback(task)
  return {
    ...task,
    feedback,
    completedAt: task.completedAt || Date.now(),
    historyTitle: task.title,
    createdAt: task.createdAt || Date.now()
  }
}

function remember(memory, action) {
  let next = JSON.parse(JSON.stringify(memory || storage.defaultMemory()))
  const key = storage.preferenceKey(String(action.key || '').trim())
  const value = action.value
  if (key) {
    next.userPreferences = {
      ...(next.userPreferences || {}),
      [key]: value
    }
  }
  next = storage.upsertMemoryFact(next, {
    kind: action.kind || 'preference',
    key: key || String(action.value || 'preference').slice(0, 16),
    value,
    evidence: action.evidence || action.reason || '',
    confidence: action.confidence || 0.8,
    source: 'agent'
  })
  next.updatedAt = Date.now()
  return next
}

function applyAgentDraft(draft) {
  const language = i18n.getLang()
  let tasks = storage.getTasks()
  let history = storage.getHistory()
  let memory = storage.getMemory()
  const mode = draft.mode || storage.getPlanMode()
  const changes = []
  const changeDetails = []
  function record(type, params) { const detail = { type, params }; changeDetails.push(detail); changes.push(systemCopy.changeText(detail, language)) }
  const affectedDateKeys = new Set()
  let shouldReschedule = false
  let scheduleMode = mode

  for (const rawAction of draft.actions || []) {
    const action = normalizeAction(rawAction)

    if (action.type === 'create_task') {
      const task = buildTaskFromAction(action, history, memory)
      tasks = [task, ...tasks]
      affectedDateKeys.add(task.dateKey || time.todayKey())
      shouldReschedule = true
      record('create', { title: task.title })
      continue
    }

    if (action.type === 'update_task') {
      const target = findTask(tasks, action)
      if (!target) {
        record('missing', { operationKey: 'update', title: action.titleMatch || action.title || i18n.translate('untitledTask', language) })
        continue
      }
      tasks = tasks.map((task) => task.id === target.id ? applyUpdate(task, action, history, memory) : task)
      affectedDateKeys.add(target.dateKey || time.todayKey())
      shouldReschedule = true
      record('update', { title: target.title })
      continue
    }

    if (action.type === 'delete_task') {
      const target = findTask(tasks, action)
      if (!target) {
        record('missing', { operationKey: 'delete', title: action.titleMatch || action.title || i18n.translate('untitledTask', language) })
        continue
      }
      tasks = tasks.map((task) => task.id === target.id ? { ...task, status: 'deleted', updatedAt: Date.now() } : task)
      affectedDateKeys.add(target.dateKey || time.todayKey())
      shouldReschedule = true
      record('delete', { title: target.title })
      continue
    }

    if (action.type === 'complete_task') {
      const target = findTask(tasks, action)
      if (!target) {
        record('missing', { operationKey: 'complete', title: action.titleMatch || action.title || i18n.translate('untitledTask', language) })
        continue
      }
      const result = lifecycle.completeState({ tasks, history, memory }, target.id, { actualMinutes: action.actualMinutes, adjustPlan: action.adjustPlan, feedback: action.feedback })
      tasks = result.tasks
      history = result.history
      memory = result.memory
      record('complete', { title: target.title })
      continue
    }

    if (action.type === 'reschedule_tasks') {
      scheduleMode = action.mode || scheduleMode
      affectedDateKeys.add(action.dateKey || time.todayKey())
      shouldReschedule = true
      record('reschedule')
      continue
    }

    if (action.type === 'remember_preference') {
      memory = remember(memory, action)
      record('remember')
    }
  }

  for (const update of draft.memoryUpdates || []) {
    memory = remember(memory, update)
    record('remember')
  }

  let plan = null
  if (shouldReschedule) {
    const dateKeys = affectedDateKeys.size ? Array.from(affectedDateKeys) : [time.todayKey()]
    dateKeys.forEach((dateKey) => {
      const replan = (draft.actions || []).some((action) => action.type === 'reschedule_tasks' && (action.dateKey || time.todayKey()) === dateKey)
      plan = (replan ? scheduler.replanTasks : scheduler.applySchedule)(tasks, { mode: scheduleMode, memory, history, dateKey })
      tasks = plan.tasks
      if (replan) {
        storage.saveScheduleReport(plan.report)
        record(scheduleMode === 'suggestion' ? 'suggestions' : 'replan', { count: scheduleMode === 'suggestion' ? plan.report.plannedCount : plan.report.changedCount, fixed: plan.report.fixedCount })
      }
    })
    storage.savePlanMode(scheduleMode)
  }

  storage.saveTasks(tasks)
  storage.saveHistory(history)
  storage.saveMemory(memory)
  storage.clearDraft()

  return {
    changes,
    changeDetails,
    tasks,
    history,
    memory,
    plan
  }
}

module.exports = {
  applyAgentDraft,
  runAgent
}
