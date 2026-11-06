const i18n = require('../../utils/i18n')
const time = require('../../utils/time')
const natural = require('../../utils/natural-language')
const { createId, memorySnapshot } = require('./state')

const ALLOWED_ACTIONS = new Set([
  'create_task', 'update_task', 'delete_task', 'complete_task', 'reschedule_tasks', 'remember_preference'
])

function isReadOnlyQuery(userText) {
  const text = String(userText || '').trim()
  const query = /(什么时间有空|什么时候有空|有什么安排|有哪些安排|哪天有空|几点开始|还有几件|查一下|看一下.*(?:安排|有空)|[?？])/.test(text)
  const mutation = /(创建|添加|记录|提醒|删除|清空|取消|修改|改到|改成|调整|重排|重新排|完成|做完|安排).*(会议|任务|日程|行程|活动|复习|作业|周报|请假|答辩)/.test(text)
  return query && !mutation
}

function hasUnresolvedRelativeAnchor(userText, state) {
  const text = String(userText || '')
  const relativeAnchor = /(日前\s*[一二两三四五六七八九十\d]+\s*天|结束后|结束之后|开始前)/.test(text)
  const concreteDate = /(今天|明天|后天|大后天|明年|\d{4}\s*年|\d{1,2}\s*月\s*\d{1,2}|(?:下)?(?:周|星期|礼拜)[日天一二三四五六])/.test(text)
  const knownAnchor = ((state && state.tasks) || []).some((task) => {
    const title = String(task.title || '').trim()
    return title.length >= 3 && text.includes(title)
  })
  return relativeAnchor && !concreteDate && !knownAnchor
}

function extractJsonText(value) {
  const text = String(value || '').trim()
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fenced) return fenced[1].trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) return text.slice(start, end + 1)
  return text
}

function normalizeAction(value) {
  let action = value && typeof value === 'object' ? value : {}
  const aliases = {
    create: 'create_task', add: 'create_task', update: 'update_task', edit: 'update_task',
    delete: 'delete_task', remove: 'delete_task', complete: 'complete_task', finish: 'complete_task',
    schedule: 'reschedule_tasks', reschedule: 'reschedule_tasks', remember: 'remember_preference',
    create_event: 'create_task', create_schedule: 'create_task', add_task: 'create_task',
    modify_task: 'update_task', modify_event: 'update_task', update_event: 'update_task',
    delete_event: 'delete_task', cancel_task: 'delete_task', complete_event: 'complete_task'
  }
  if (!action.type && !action.action) {
    const nestedKey = Object.keys(action).find((key) => ALLOWED_ACTIONS.has(aliases[key] || key))
    if (nestedKey && action[nestedKey] && typeof action[nestedKey] === 'object') {
      action = { ...action[nestedKey], type: aliases[nestedKey] || nestedKey }
    }
  }
  const rawType = String(action.type || action.action || '').trim()
  const type = aliases[rawType] || rawType
  if (!ALLOWED_ACTIONS.has(type)) return null
  const next = { ...action, type }
  const slotClock = natural.parseClock(next.preferredSlot)
  const dueClock = natural.parseClock(next.dueClock || next.startClock) || slotClock
  if (dueClock) {
    next.dueClock = dueClock
    next.preferredSlot = natural.preferredSlot('', dueClock)
  }
  return next
}

function normalizeDraft(raw, userText, source, language = 'zh') {
  const value = raw && typeof raw === 'object' ? raw : {}
  const actionSource = value.actions != null ? value.actions : (value.operations != null ? value.operations : value.plan)
  const actionList = Array.isArray(actionSource)
    ? actionSource
    : (actionSource && typeof actionSource === 'object' ? [actionSource] : [])
  let actions = actionList.map(normalizeAction).filter(Boolean)
  if (isReadOnlyQuery(userText)) actions = []
  const inputClocks = natural.extractClocks(userText)
  if (actions.length === 1) {
    const inputClock = inputClocks[0] || ''
    const explicitPeriod = /(凌晨|早上|上午|中午|下午|傍晚|晚上|今夜|明夜|今晚|明晚|夜里|夜晚)/.test(userText)
    const explicit24Hour = /(?:^|\D)(?:1[3-9]|2[0-4])\s*(?:点|时|[:：])/.test(userText)
    if (inputClock && (explicitPeriod || explicit24Hour) && ['create_task', 'update_task'].includes(actions[0].type)) {
      actions[0] = {
        ...actions[0],
        dueClock: inputClock,
        preferredSlot: natural.preferredSlot(userText, inputClock)
      }
    } else if (inputClock && actions[0].dueClock && ['create_task', 'update_task'].includes(actions[0].type)) {
      const inputMinute = time.parseClockToMinutes(inputClock, null)
      const modelMinute = time.parseClockToMinutes(actions[0].dueClock, null)
      if (Number.isFinite(inputMinute) && Number.isFinite(modelMinute)) {
        const inputHour = Math.floor(inputMinute / 60)
        const inputMinutePart = inputMinute % 60
        const candidates = inputHour === 12 ? [0, 12] : [inputHour, inputHour + 12].filter((hour) => hour < 24)
        const modelHour = Math.floor(modelMinute / 60)
        const alignedHour = candidates.reduce((best, hour) => (
          Math.abs(hour - modelHour) < Math.abs(best - modelHour) ? hour : best
        ), candidates[0])
        const alignedClock = time.formatMinutesAsClock(alignedHour * 60 + inputMinutePart)
        if (alignedClock !== actions[0].dueClock) {
          actions[0] = {
            ...actions[0],
            dueClock: alignedClock,
            preferredSlot: natural.preferredSlot(userText, alignedClock)
          }
        }
      }
    }
  } else if (actions.length > 1) {
    const clocks = inputClocks.length === actions.length
      ? inputClocks
      : (/每天/.test(userText) && inputClocks.length === 1 ? actions.map(() => inputClocks[0]) : [])
    if (clocks.length === actions.length) {
      actions = actions.map((action, index) => {
        if (!['create_task', 'update_task'].includes(action.type)) return action
        return {
          ...action,
          dueClock: clocks[index],
          preferredSlot: natural.preferredSlot(userText, clocks[index])
        }
      })
    }
  }
  const memoryUpdates = Array.isArray(value.memoryUpdates) ? value.memoryUpdates : []
  const operationCount = actions.length + memoryUpdates.length
  return {
    id: createId('plan'),
    createdAt: Date.now(),
    source: source || value.source || 'ai',
    runtimeManaged: true,
    userText,
    language,
    reply: value.reply || value.summary || i18n.translate('preparedPlan', language),
    modelNeedConfirmation: value.needConfirmation !== false,
    needConfirmation: operationCount > 0,
    actions,
    memoryUpdates,
    adviceBubbles: Array.isArray(value.adviceBubbles) ? value.adviceBubbles.slice(0, 3) : []
  }
}

function compactTask(task) {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    dateKey: task.dateKey,
    priority: task.priority,
    estimatedMinutes: task.estimatedMinutes,
    actualMinutes: task.actualMinutes,
    status: task.status,
    preferredSlot: task.preferredSlot,
    dueClock: task.dueClock,
    scheduledStart: task.scheduledStart,
    scheduledEnd: task.scheduledEnd
  }
}

function buildPrompt(userText, state, language) {
  const replyLanguage = language === 'en' ? 'English' : 'Simplified Chinese'
  const today = time.todayKey()
  const context = {
    today,
    tomorrow: time.addDays(today, 1),
    planMode: state.planMode,
    memory: memorySnapshot(state.memory),
    tasks: state.tasks.filter((task) => task.status !== 'deleted').map(compactTask),
    history: state.history.slice(0, 12).map(compactTask),
    pendingDraft: state.draft ? { id: state.draft.id, reply: state.draft.reply, actions: state.draft.actions, memoryUpdates: state.draft.memoryUpdates } : null
  }
  return [
    '你是部署在服务器上的私人日程秘书 Agent。',
    '你负责理解用户、读取长期记忆和结构化日程，然后一次性生成可审阅的计划。',
    '采用 Plan -> Human Approval -> Execute：当前阶段只制定计划，绝对不要声称已经执行。',
    '采用 Smart Agent, Dumb Tools：你负责时间理解、冲突判断和多意图拆解；执行工具只做明确动作。',
    '语气温和、直接、不给压力。',
    `回复语言：${replyLanguage}。reply、adviceBubbles、title、description、evidence 等自然语言字段必须使用该语言；JSON 字段名和枚举值保持英文。`,
    '',
    `当前日期：${context.today}`,
    `明天日期：${context.tomorrow}`,
    `当前用户时区：${JSON.stringify(state.timeContext || { timeZone: 'server-local (legacy client)' })}`,
    `当前用户当地时间：${time.formatMinuteOfDay(time.currentParts().hour * 60 + time.currentParts().minute)}`,
    `计划强度：${context.planMode}`,
    '',
    '工具动作：',
    'create_task: title, description, dateKey, priority, estimatedMinutes, preferredSlot, dueClock',
    'update_task: taskId 或 titleMatch，加需要修改的字段',
    'delete_task: taskId 或 titleMatch',
    'complete_task: taskId 或 titleMatch, actualMinutes, feedback',
    'reschedule_tasks: dateKey, mode(relaxed/flexible/suggestion)',
    'remember_preference: kind, key, value, evidence, confidence',
    '',
    '规则：',
    '- 一次输入可以产生多个动作，先完整推理，再生成一个计划。',
    '- 当前日期和当地时间属于这位用户，所有日期与时刻按用户当地时间理解，不要转换成北京时间。',
    '- 用户明确指定今天/today/tonight时必须使用当前日期；即使时间已过也不能擅自改到明天，应提示用户时间已过。',
    '- 用户陈述带日期或时间的未来事项时，必须生成 create_task；禁止只在 reply 里说已安排却让 actions 为空。',
    '- actions 为空时 needConfirmation 必须为 false；只要 actions 或 memoryUpdates 非空，needConfirmation 必须为 true。',
    '- 没说时长时，结合历史和长期记忆推断 estimatedMinutes。',
    '- dueClock 只用于用户明确指定的固定开始时刻。你推测的安排时间不能写进 dueClock；没有明确钟点或用户说时间可调整时，dueClock 留空，交给智能排程决定。',
    '- 完成任务时，用户未明确提供实际用时就不要填写 actualMinutes；执行工具会读取已保存的计时记录，不需要再询问或估算。',
    '- durationOverrides 是用户手动校准过的同类任务预估；用户未指定时长时优先采用。',
    '- 重排已有任务时生成 reschedule_tasks，不要重复创建任务。用户指定新时段、优先级时先用 update_task 修改相关任务，再重排。固定时间事项除非用户要求修改，否则保留。',
    '- 用户要求保存或修改记忆时必须生成 remember_preference 或 memoryUpdates，不能只口头答应。已有同类偏好使用其原 key 替换，避免新旧偏好互相矛盾。',
    '- 可用开始/结束时间、任务间休息、提醒语气、动态计划分别用固定 key=workdayStart/workdayEnd/defaultBreakMinutes/tone/dynamicPlan；时间用 HH:MM，休息用分钟数，动态计划用布尔值。',
    '- 运动相对用餐的长期习惯使用 kind=planning_rule, key=exerciseMealOrder, value 用简短自然语言明确饭前或饭后；专注时段使用 kind=time_preference, key=focusWorkPreferredSlot。修改同一习惯始终使用同一 key。',
    '- 仅记住或修改偏好时只保存记忆，不主动移动现有任务；用户同时要求排程或重排时，先写入记忆再生成 reschedule_tasks。创建和编辑任务会由统一排程自动安排。',
    '- 个人习惯、禁忌和稳定节奏可写入记忆；偶然情况不要当永久规则。',
    '- 修改或删除时不得编造 taskId，不确定就使用 titleMatch。',
    '- 如果存在待确认计划，用户说改时间、改日期或改内容时，返回修改后的完整替代计划，不要假装旧计划已经入库。',
    '- 只输出严格 JSON，不要 Markdown。',
    '',
    '输出：{"reply":"简短说明","needConfirmation":true,"actions":[],"memoryUpdates":[],"adviceBubbles":[]}',
    '',
    `长期记忆：${JSON.stringify(context.memory)}`,
    `任务：${JSON.stringify(context.tasks)}`,
    `最近历史：${JSON.stringify(context.history)}`,
    `当前待确认计划：${JSON.stringify(context.pendingDraft)}`,
    language === 'en' ? 'Write all assistant prose and advice in English only. Preserve user-authored task names and original evidence.' : '助手回复和建议统一使用中文；保留用户原始任务名称和引用证据。',
    `用户输入：${userText}`
  ].join('\n')
}

function repairPendingDraft(userText, state, language = state.language || 'zh') {
  const pending = state && state.draft
  if (!pending || !Array.isArray(pending.actions) || !pending.actions.length) return null
  const dueClock = natural.parseClock(userText)
  const hasDate = /(今天|明天|后天|大后天|\d{1,2}\s*月\s*\d{1,2}|(?:下)?(?:周|星期|礼拜)[日天一二三四五六])|\b(today|tomorrow|tonight|yesterday)\b/i.test(String(userText || ''))
  if (!dueClock && !hasDate) return null

  const actions = pending.actions.map((action, index) => {
    if (index !== 0 || action.type !== 'create_task') return { ...action }
    return {
      ...action,
      ...(dueClock ? { dueClock, preferredSlot: natural.preferredSlot(userText, dueClock) } : {}),
      ...(hasDate ? { dateKey: natural.parseDateKey(userText) } : {})
    }
  })
  return normalizeDraft({
    reply: i18n.translate(dueClock ? 'pendingTimeCorrected' : 'pendingCorrected', language, { clock: dueClock }),
    needConfirmation: true,
    actions,
    memoryUpdates: pending.memoryUpdates || []
  }, userText, 'pending_plan_repair', language)
}

function fallbackDraft(userText, state, language = state.language || 'zh') {
  const text = String(userText || '').trim()
  const activeTasks = (state.tasks || []).filter((item) => item.status !== 'deleted' && item.status !== 'completed')
  const matchingTasks = activeTasks.filter((item) => text.toLowerCase().includes(String(item.title).toLowerCase()))

  const completionIntent = /标记.*完成|标为.*完成|已经完成|已完成|完成了|做完了|搞定了|^完成|\b(?:complete|completed|finished|done)\b/i.test(text)
    && !/还没完成|尚未完成|未完成|不要.*标记|别.*标记|\b(?:not|don't|do not)\b/i.test(text)
  if (completionIntent && !isReadOnlyQuery(text)) {
    return normalizeDraft({
      reply: i18n.translate(matchingTasks.length ? 'completionPrepared' : 'missingPendingTask', language),
      actions: matchingTasks.map((task) => ({ type: 'complete_task', taskId: task.id, ...(matchingTasks.length === 1 ? { actualMinutes: natural.parseDuration(text) } : {}) }))
    }, text, 'server_fallback', language)
  }

  if (/(删除|清空|取消).*(日程|行程|任务|会议|周会|周报)|(日程|行程|任务|会议|周会|周报).*(删除|清空|取消)|都删除|全部删除/.test(text)) {
    const targets = matchingTasks.length ? matchingTasks : activeTasks.filter((item) => /所有|全部|清空/.test(text))
    if (targets.length) {
      const actions = targets.map((item) => ({ type: 'delete_task', taskId: item.id, titleMatch: item.title }))
      if (/请假/.test(text)) {
        actions.push({
          type: 'create_task',
          title: i18n.translate('leaveTask', language),
          description: text,
          dateKey: natural.parseDateKey(text),
          estimatedMinutes: 8 * 60,
          preferredSlot: 'any'
        })
      }
      return normalizeDraft({
        reply: i18n.translate('preparedCount', language, { count: actions.length }),
        actions
      }, text, 'server_fallback', language)
    }
  }

  if (/(推迟|顺延|提前|改到|改成|调整到|挪到)/.test(text)) {
    let targets = matchingTasks
    if (!targets.length && /会议/.test(text)) targets = activeTasks.filter((item) => /会议|周会/.test(item.title))
    if (targets.length) {
      const explicitClock = natural.parseClock(text)
      const delay = text.match(/(推迟|顺延|提前)\s*([一二两三四五六七八九十\d]+)\s*(小时|分钟)/)
      const numberMap = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
      const direction = delay && delay[1] === '提前' ? -1 : 1
      const amount = delay ? (Number(delay[2]) || numberMap[delay[2]] || 0) : 0
      const delta = delay ? amount * (delay[3] === '小时' ? 60 : 1) * direction : 0
      return normalizeDraft({
        reply: i18n.translate('preparedCount', language, { count: targets.length }),
        actions: targets.map((item) => {
          const currentMinute = time.parseClockToMinutes(item.dueClock || item.scheduledStart, null)
          const dueClock = explicitClock || (Number.isFinite(currentMinute) && delta ? time.formatMinutesAsClock(currentMinute + delta) : '')
          return {
            type: 'update_task',
            taskId: item.id,
            titleMatch: item.title,
            ...(dueClock ? { dueClock } : {}),
            dateKey: natural.parseDateKey(text)
          }
        })
      }, text, 'server_fallback', language)
    }
  }

  if (/(排程|重排|重新排|重新安排|调整).*(任务|日程|计划)|(任务|日程|计划).*(重排|重新排|重新安排|调整)|今天做什么|怎么安排|\b(?:reschedule|replan)\b/i.test(text)) {
    return normalizeDraft({
      reply: i18n.translate('ruleReplan', language),
      actions: [{ type: 'reschedule_tasks', mode: state.planMode }]
    }, text, 'server_fallback', language)
  }

  const repeat = text.match(/未来\s*([一二两三四五六七八九十\d]+)\s*天每天/)
  if (repeat) {
    const numberMap = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
    const count = Math.max(1, Math.min(Number(repeat[1]) || numberMap[repeat[1]] || 1, 14))
    const dueClock = natural.parseClock(text)
    const title = natural.taskTitle(text).replace(/^未来.*?天每天\s*/, '') || i18n.translate('repeatTask', language)
    return normalizeDraft({
      reply: i18n.translate('repeatPrepared', language, { count }),
      actions: Array.from({ length: count }, (_, index) => ({
        type: 'create_task', title, description: text, dateKey: time.addDays(time.todayKey(), index), dueClock,
        preferredSlot: natural.preferredSlot(text, dueClock)
      }))
    }, text, 'server_fallback', language)
  }

  const clauses = text.split(/[、，,；;]/).map((item) => item.trim()).filter(Boolean)
  const timedClauses = clauses.filter((item) => natural.parseClock(item))
  if (timedClauses.length >= 2) {
    const dateKey = natural.parseDateKey(text)
    return normalizeDraft({
      reply: i18n.translate('preparedCount', language, { count: timedClauses.length }),
      actions: timedClauses.map((item) => {
        const dueClock = natural.parseClock(item)
        return {
          type: 'create_task', title: natural.taskTitle(item) || i18n.translate('untitledTask', language), description: item,
          dateKey, dueClock, preferredSlot: natural.preferredSlot(item, dueClock)
        }
      })
    }, text, 'server_fallback', language)
  }
  const dueClock = natural.parseClock(text)
  return normalizeDraft({
    reply: i18n.translate('ruleTask', language),
    actions: [{
      type: 'create_task',
      title: natural.taskTitle(text) || text.slice(0, 28) || i18n.translate('untitledTask', language),
      description: text,
      priority: /(重要|紧急|必须)/.test(text) ? 'high' : 'medium',
      estimatedMinutes: natural.parseDuration(text),
      dateKey: natural.parseDateKey(text),
      dueClock,
      preferredSlot: natural.preferredSlot(text, dueClock)
    }]
  }, text, 'server_fallback', language)
}

async function callGateway(config, prompt, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 180000)
  try {
    const response = await fetch(`${config.aiGatewayUrl}/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.aiModel,
        messages: [{ role: 'user', content: prompt }],
        responseMimeType: 'application/json',
        temperature: 0.1
      }),
      signal: controller.signal
    })
    const payload = await response.json()
    if (!response.ok || !payload.ok || !payload.data) {
      throw new Error(payload.error || `AI gateway returned ${response.status}`)
    }
    return payload.data
  } finally {
    clearTimeout(timer)
  }
}

async function plan(config, userText, state, language) {
  try {
    const result = await callGateway(config, buildPrompt(userText, state, language))
    const parsed = JSON.parse(extractJsonText(result.text))
    const draft = normalizeDraft(parsed, userText, result.model || config.aiModel, language)
    if (!natural.extractClocks(userText).length) {
      draft.actions.forEach(action => {
        if (action.type !== 'create_task' || !action.dueClock) return
        const previous = state.draft && state.draft.actions.find(item => item.type === 'create_task' && item.title === action.title && item.dueClock === action.dueClock)
        if (!previous) action.dueClock = ''
      })
    }
    // An explicit single relative day takes precedence over the model's date.
    const dayHints = String(userText).match(/大后天|后天|明天|明早|明晚|昨天|今天|今晚|今夜|\bday after tomorrow\b|\btomorrow\b|\byesterday\b|\btoday\b|\btonight\b/gi) || []
    const requestedDates = new Set(dayHints.map((hint) => natural.parseDateKey(hint)))
    const hasCalendarDate = /\d{4}-\d{2}-\d{2}|\d{1,2}\s*月|(?:周|星期|礼拜)|\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i.test(userText)
    if (requestedDates.size === 1 && !hasCalendarDate) {
      const dateKey = Array.from(requestedDates)[0]
      let corrected = false
      draft.actions.forEach((action) => {
        if (['create_task', 'update_task', 'reschedule_tasks'].includes(action.type)) {
          corrected = corrected || Boolean(action.dateKey && action.dateKey !== dateKey)
          action.dateKey = dateKey
        }
      })
      if (corrected) draft.reply = language === 'en'
        ? `I've kept the plan on your requested local date, ${dateKey}. Please review the tasks before confirming.`
        : `已按你指定的当地日期 ${dateKey} 整理计划，请核对任务后确认。`
    }
    if (natural.parseDuration(userText) == null) {
      draft.actions.forEach((action) => { if (action.type === 'complete_task') delete action.actualMinutes })
    }
    if (hasUnresolvedRelativeAnchor(userText, state)) {
      draft.actions = []
      draft.memoryUpdates = []
      draft.needConfirmation = false
      return draft
    }
    const operationCount = draft.actions.length + draft.memoryUpdates.length
    if (!operationCount) {
      const pendingRepair = repairPendingDraft(userText, state, language)
      if (pendingRepair) return pendingRepair
      const explicitSchedule = /(今天|明天|后天|大后天|明年|\d{1,2}\s*月\s*\d{1,2}|(?:下)?(?:周|星期|礼拜)[日天一二三四五六]).*(点|时|安排|参加|提交|复习|开会|会议|去|看|写|交|吃|跑|游泳)/.test(userText)
      const operationIntent = /(删除|清空|取消|推迟|顺延|提前|改到|改成|调整|重排|重新排|完成|做完)/.test(userText)
      const unsafeToolRequest = /(run_shell|shell|服务器文件|系统文件)/i.test(userText)
      const shouldRepair = !unsafeToolRequest && !isReadOnlyQuery(userText) && (
        (draft.modelNeedConfirmation && natural.shouldCreateFallback(userText)) ||
        explicitSchedule ||
        operationIntent
      )
      if (shouldRepair) {
        const repaired = fallbackDraft(userText, state, language)
        repaired.source = `${result.model || config.aiModel}:repaired`
        if (!repaired.actions.some((action) => action.type === 'complete_task')) repaired.reply = draft.reply
        repaired.adviceBubbles = draft.adviceBubbles
        repaired.error = 'AI returned no executable actions; deterministic action added'
        return repaired
      }
    }
    return draft
  } catch (error) {
    console.error('agent planning failed; server fallback used', error)
    const draft = fallbackDraft(userText, state, language)
    draft.error = error && error.message ? error.message : 'AI planning failed'
    return draft
  }
}

module.exports = { buildPrompt, hasUnresolvedRelativeAnchor, isReadOnlyQuery, normalizeDraft, plan, repairPendingDraft, fallbackDraft, callGateway, extractJsonText }
