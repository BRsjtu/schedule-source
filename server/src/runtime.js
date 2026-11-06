const i18n = require('../../utils/i18n')
const systemCopy = require('../../utils/system-copy')
const crypto = require('node:crypto')
const time = require('../../utils/time')
const { plan } = require('./agent')
const { appendMessage, normalizeState, createId } = require('./state')
const { executePlan } = require('./tools')
const { normalizeTimeContext, withTimeContext } = require('./clock')
const smartReplan = require('./smart-replan')

function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret || '')).digest('hex')
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''))
  const b = Buffer.from(String(right || ''))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function scheduleBase(state) {
  return { tasks: state.tasks, history: state.history, memory: state.memory, planMode: state.planMode, timeContext: state.timeContext, scheduleReport: state.scheduleReport }
}

function mergeMessages(left, right) {
  return [...new Map([...left, ...right].map(message => [message.id, message])).values()].sort((a, b) => a.createdAt - b.createdAt).slice(-80)
}

class AgentRuntime {
  constructor(config, database) {
    this.config = config
    this.database = database
    this.timer = null
  }

  bootstrap(deviceId, deviceSecret, initialState) {
    if (!/^[A-Za-z0-9_-]{12,120}$/.test(String(deviceId || ''))) throw Object.assign(new Error('无效的设备标识'), { statusCode: 400 })
    if (String(deviceSecret || '').length < 24) throw Object.assign(new Error('设备密钥过短'), { statusCode: 400 })
    const secretHash = hashSecret(deviceSecret)
    const existing = this.database.getUser(deviceId)
    if (!existing) {
      const result = this.database.createUser(deviceId, secretHash, initialState)
      return { ...result, created: true }
    }
    if (!safeEqual(existing.secret_hash, secretHash)) throw Object.assign(new Error('设备认证失败'), { statusCode: 401 })
    this.database.touchUser(deviceId)
    const current = this.database.getState(deviceId)
    const context = normalizeTimeContext(initialState && initialState.timeContext)
    const previous = current.state.timeContext
    const changed = context && (!previous || previous.timeZone !== context.timeZone || previous.timezoneOffsetMinutes !== context.timezoneOffsetMinutes)
    const result = changed ? this.database.saveState(deviceId, { ...current.state, timeContext: context }, current.revision) : current
    return { ...result, created: false }
  }

  authenticate(deviceId, deviceSecret) {
    const user = this.database.getUser(deviceId)
    if (!user || !safeEqual(user.secret_hash, hashSecret(deviceSecret))) {
      throw Object.assign(new Error('设备认证失败'), { statusCode: 401 })
    }
    this.database.touchUser(deviceId)
    return user.id
  }

  getState(userId) {
    return this.database.getState(userId)
  }

  latestScheduleState(userId, previous) {
    const latest = this.database.getState(userId)
    if (latest.revision !== previous.revision && (JSON.stringify(scheduleBase(latest.state)) !== JSON.stringify(scheduleBase(previous.state)) || JSON.stringify(latest.state.draft) !== JSON.stringify(previous.state.draft))) {
      throw Object.assign(new Error('计划生成后日程已有变化，请重新生成计划'), { statusCode: 409 })
    }
    return latest
  }

  syncState(userId, state, baseRevision) {
    const current = this.database.getState(userId)
    return this.database.saveState(userId, { ...state, timeContext: normalizeTimeContext(state && state.timeContext) || current.state.timeContext }, Number(baseRevision))
  }

  async createPlan(userId, userText, language, clientTimeContext) {
    const current = this.database.getState(userId)
    const context = normalizeTimeContext(clientTimeContext) || current.state.timeContext
    return withTimeContext(context, () => this.createPlanInContext(userId, userText, language, current, context))
  }

  async createPlanInContext(userId, userText, language, current, context) {
    const text = String(userText || '').trim()
    const replyLanguage = language === 'en' ? 'en' : 'zh'
    if (!text) throw Object.assign(new Error('请输入日程需求'), { statusCode: 400 })
    let state = appendMessage({ ...current.state, timeContext: context, language: replyLanguage }, { role: 'user', content: text })
    const pendingDraft = state.draft
    if (pendingDraft && /^(?:算了|取消|不要了|撤销|别创建了|这个不要了|cancel|never mind|nevermind)[，,。.!！\s]*$/.test(text.toLowerCase())) {
      state.draft = null
      state = appendMessage(state, { role: 'assistant', content: i18n.translate('pendingCanceled', replyLanguage), system: { type: 'cancel' } })
      const saved = this.database.saveState(userId, state, current.revision)
      this.database.discardPlan(userId, pendingDraft.id)
      return {
        draft: {
          id: pendingDraft.id,
          createdAt: Date.now(),
          runtimeManaged: true,
          reply: i18n.translate('pendingCanceled', replyLanguage),
          needConfirmation: false,
          actions: [],
          memoryUpdates: []
        },
        ...saved
      }
    }
    const draft = await plan(this.config, text, state, replyLanguage)
    await this.prepareSchedule(state, draft, text, replyLanguage)
    const latest = this.latestScheduleState(userId, current)
    state.messages = mergeMessages(state.messages, latest.state.messages)
    state = appendMessage(state, { role: 'assistant', content: draft.reply })
    const operationCount = draft.actions.length + draft.memoryUpdates.length
    draft.baseSchedule = scheduleBase(state)
    state.draft = operationCount ? draft : null
    const saved = this.database.saveState(userId, state, latest.revision)
    if (pendingDraft && pendingDraft.id !== draft.id) {
      this.database.discardPlan(userId, pendingDraft.id)
    }
    if (operationCount) {
      this.database.createPlan({ id: draft.id, userId, userText: text, draft, stateRevision: saved.revision })
    }
    return { draft, ...saved }
  }

  async prepareSchedule(state, draft, instruction, language) {
    draft.unifiedSchedule = true
    draft.actions.forEach(action => { if (action.type === 'create_task') action.createdTaskId = action.createdTaskId || createId('task') })
    // Creation, editing and explicit replanning use the same decision maker.
    // Project preferences first, so the proposal already uses the new memory.
    const dates = new Set()
    for (const action of draft.actions) {
      if (action.type === 'create_task') dates.add(action.dateKey || time.todayKey())
      if (['update_task', 'delete_task'].includes(action.type)) {
        const match = String(action.titleMatch || action.title || '').toLowerCase()
        const target = state.tasks.find(task => task.id === action.taskId || (!action.taskId && match && String(task.title || '').toLowerCase().includes(match)))
        if (target) {
          dates.add(target.dateKey || time.todayKey())
          if (action.type === 'update_task') dates.add(action.dateKey || target.dateKey || time.todayKey())
        }
      }
    }
    for (const dateKey of dates) {
      if (dateKey < time.todayKey()) continue
      if (!draft.actions.some(action => action.type === 'reschedule_tasks' && (action.dateKey || time.todayKey()) === dateKey)) {
        draft.actions.push({ type: 'reschedule_tasks', dateKey, mode: state.planMode, automatic: true })
      }
    }
    const replans = draft.actions.filter(action => action.type === 'reschedule_tasks')
    if (!replans.length && [...draft.actions, ...draft.memoryUpdates].length && draft.actions.every(action => action.type === 'remember_preference')) {
      draft.reply = i18n.translate('preparedCount', language, { count: draft.actions.length + draft.memoryUpdates.length })
    }
    if (replans.length) {
      const projected = executePlan(state, { ...draft, actions: draft.actions.filter(action => action.type !== 'reschedule_tasks') }, language, { schedule: false }).state
      for (const action of replans) {
        const result = await smartReplan.generate(this.config, projected, { dateKey: action.dateKey || time.todayKey(), mode: action.mode || projected.planMode, memory: projected.memory, instruction })
        action.llmPlan = result.proposal
        action.llmModel = result.model
        action.llmEngine = result.report.engine
        action.llmPreview = result.report.entries
        draft.reply = [draft.reply, i18n.translate('smartReplanReview', language, { summary: result.report.summary[language] })].filter(Boolean).join(' ')
        projected.tasks = result.tasks
        projected.scheduleReport = result.report
      }
    }
  }

  async saveTask(userId, input, language, clientTimeContext) {
    const current = this.database.getState(userId)
    const context = normalizeTimeContext(clientTimeContext) || current.state.timeContext
    return withTimeContext(context, async () => {
      const title = String(input && input.title || '').trim()
      const minutes = Number(input && input.estimatedMinutes)
      if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(input.dateKey || '') || !Number.isFinite(minutes) || minutes < 5 || minutes > 1440) throw Object.assign(new Error('任务名称、日期或时长无效'), { statusCode: 400 })
      if (input.dueClock && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.dueClock)) throw Object.assign(new Error('固定时间无效'), { statusCode: 400 })
      if (input.taskId && !current.state.tasks.some(task => task.id === input.taskId && !['completed', 'deleted'].includes(task.status))) throw Object.assign(new Error('没有找到可修改的任务'), { statusCode: 404 })
      const state = normalizeState({ ...current.state, timeContext: context, language })
      const action = { type: input.taskId ? 'update_task' : 'create_task', taskId: input.taskId, title: title.slice(0, 100), description: String(input.description || '').slice(0, 500), dateKey: input.dateKey, estimatedMinutes: minutes, priority: input.priority, preferredSlot: input.preferredSlot, dueClock: input.dueClock || '' }
      const draft = { actions: [action], memoryUpdates: [] }
      await this.prepareSchedule(state, draft, '', state.language)
      return this.database.transaction(() => {
        const latest = this.latestScheduleState(userId, current)
        const result = executePlan(state, draft, state.language)
        result.state.messages = latest.state.messages
        const saved = this.database.saveState(userId, result.state, latest.revision)
        if (state.draft) this.database.discardPlan(userId, state.draft.id)
        return saved
      })
    })
  }

  confirmPlan(userId, planId, language) {
    return this.database.transaction(() => {
      const record = this.database.getPlan(userId, planId)
      if (!record) throw Object.assign(new Error('没有找到待确认计划'), { statusCode: 404 })
      if (record.status !== 'pending') throw Object.assign(new Error('该计划已经处理'), { statusCode: 409 })
      const current = this.database.getState(userId)
      if (current.revision !== record.state_revision && (!record.draft.baseSchedule || current.state.draft?.id !== planId || JSON.stringify(scheduleBase(current.state)) !== JSON.stringify(record.draft.baseSchedule))) throw Object.assign(new Error('计划生成后日程已有变化，请重新生成计划'), { statusCode: 409 })
      const result = withTimeContext(current.state.timeContext, () => executePlan(current.state, record.draft, language || record.draft.language || current.state.language))
      result.state = appendMessage(result.state, {
        role: 'assistant',
        content: systemCopy.executionText(result.changeDetails, result.state.language),
        system: { type: 'execution', changes: result.changeDetails }
      })
      const saved = this.database.saveState(userId, result.state, current.revision)
      this.database.confirmPlan(planId)
      return { changes: result.changes, ...saved }
    })
  }

  async replanDay(userId, dateKey, mode, language, clientTimeContext, instruction) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey || '')) throw Object.assign(new Error('无效的日程日期'), { statusCode: 400 })
    const current = this.database.getState(userId)
    const context = normalizeTimeContext(clientTimeContext) || current.state.timeContext
    return withTimeContext(context, async () => {
      const state = normalizeState(current.state)
      state.language = language === 'en' ? 'en' : 'zh'
      state.timeContext = context
      const result = await smartReplan.generate(this.config, state, { dateKey, mode: mode || state.planMode, memory: state.memory, instruction: String(instruction || '').slice(0, 500) })
      // A timer, edit or completion during the model call makes this plan stale.
      return this.database.transaction(() => {
        const latest = this.latestScheduleState(userId, current)
        const pendingId = state.draft && state.draft.id
        state.tasks = result.tasks
        state.scheduleReport = result.report
        state.planMode = result.report.mode
        state.memory.userPreferences.planMode = state.planMode
        state.draft = null
        state.messages = latest.state.messages
        const saved = this.database.saveState(userId, state, latest.revision)
        if (pendingId) this.database.discardPlan(userId, pendingId)
        return saved
      })
    })
  }

  discardPlan(userId, planId) {
    const current = this.database.getState(userId)
    const state = normalizeState(current.state)
    state.draft = null
    const saved = this.database.saveState(userId, state, current.revision)
    this.database.discardPlan(userId, planId)
    return saved
  }

  listEvents(userId, afterId) {
    return this.database.listEvents(userId, Number(afterId) || 0)
  }

  tick() {
    for (const row of this.database.listStates()) {
      const current = this.database.getState(row.user_id)
      const state = normalizeState(current.state)
      withTimeContext(state.timeContext, () => {
        const today = time.todayKey()
        const parts = time.currentParts()
        const nowMinutes = parts.hour * 60 + parts.minute
        let changed = false
        for (const task of state.tasks) {
          if (task.status === 'completed' || task.status === 'deleted' || task.dateKey !== today || task.scheduledStartMinute == null) continue
          const minutesUntil = task.scheduledStartMinute - nowMinutes
          if (minutesUntil < 0 || minutesUntil > this.config.reminderLeadMinutes) continue
          const eventKey = `reminder:${task.id}:${task.dateKey}:${task.scheduledStart}`
          const inserted = this.database.insertEvent(row.user_id, eventKey, 'task_reminder', {
            taskId: task.id,
            title: task.title,
            scheduledStart: task.scheduledStart,
            minutesUntil
          })
          if (inserted) {
            state.messages = appendMessage(state, {
              role: 'assistant',
              content: i18n.translate('taskReminder', state.language, { title: task.title, clock: task.scheduledStart }),
              system: { type: 'reminder', params: { title: task.title, clock: task.scheduledStart } }
            }).messages
            changed = true
          }
        }
        if (changed) {
          try { this.database.saveState(row.user_id, state, current.revision) } catch (error) { console.error('reminder state update failed', error) }
        }
      })
    }
  }

  start() {
    this.tick()
    this.timer = setInterval(() => this.tick(), this.config.agentTickMs)
    this.timer.unref()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

module.exports = { AgentRuntime, hashSecret }
