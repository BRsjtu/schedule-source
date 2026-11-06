const LANG_KEY = 'scheduleLang'

const MONTHS_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
]

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
]

const STRINGS = {
  zh: {
    tabChat: '智排',
    tabSchedule: '日程',
    tabMemory: '记忆',

    hello: '你好！',
    assistantName: 'Alicia，你的 AI 日程助手',
    assistantCopy: '直接聊天就行。',
    chipCreate: '＋ 创建日程',
    chipToday: '▣ 今日安排',
    chipFree: '◴ 空闲时间',
    promptCreate: '帮我创建一个日程',
    promptToday: '帮我看看今天怎么安排',
    promptFree: '我什么时候有空',
    confirmPrefix: '确认',
    confirmSuffix: '项操作',
    cancel: '取消',
    confirm: '确认',
    processing: '处理中',
    inputPlaceholder: '输入日程需求，直接聊天',
    send: '发送',
    listening: '正在听',
    transcribing: '正在识别语音',
    voiceButtonLabel: '语音输入',
    voiceCancelLabel: '取消录音',
    voiceDoneLabel: '结束录音',
    voiceTooShort: '说话时间太短',
    voiceReady: '已转成文字',
    voiceFailed: '语音识别失败',
    retryVoice: '重试',
    voiceUnavailable: '当前设备不支持录音',
    micPermissionTitle: '需要麦克风权限',
    micPermissionContent: '请在设置中允许使用麦克风，录音只用于转换成日程文字。',
    openSettings: '去设置',

    navSchedule: '日程表',
    viewByDate: '按日期查看安排',
    today: '今天',
    reschedule: '重排',
    start: '开始',
    done: '完成',
    noEvents: '这天还没有日程',
    noEventsHint: '回到智排，说一句"明天下午三点开会"。',
    items: '项',
    estimated: '预计',
    noEventsToday: '今天还没有安排',
    notScheduled: '未安排',
    late: '可能延后',

    navMemory: '长期记忆',
    prefsTitle: '偏好和学习记录',
    prefsSubtitle: '这些信息会同步到专属服务器记忆，让下一次估时和排程更贴合你。',
    localBadge: '长期记忆',
    basicPrefs: '基础偏好',
    startTime: '开始时间',
    endTime: '结束时间',
    breakTime: '任务间隔',
    toneSetting: '提醒语气',
    savePrefs: '保存偏好',
    secretaryProfile: '秘书档案',
    noProfile: '还没有秘书档案',
    noProfileHint: '告诉 AI 你的偏好，例如"上午适合深度工作"，确认后会进入这里。',
    taskPatterns: '任务模式',
    noPatterns: '还没有任务模式',
    noPatternsHint: '完成几个任务后，这里会出现"写作整理""学习输入"等平均用时。',
    agentNotes: '助手备注',
    noNotes: '还没有备注',
    noNotesHint: '比如"我喜欢上午做专注任务"，AI 会在你确认后写入这里。',
    clearChat: '清空对话',
    resetMemory: '重置记忆',
    samples: '样本',
    timesUnit: '次',
    commonSlot: '常见时段',

    statusTodo: '待安排',
    statusPlanned: '已排程',
    statusRunning: '进行中',
    statusPaused: '已暂停',
    statusCompleted: '已完成',

    priorityUrgent: '紧急',
    priorityHigh: '高',
    priorityMedium: '中',
    priorityLow: '低',

    actionCreate: '创建任务',
    actionUpdate: '修改任务',
    actionDelete: '删除任务',
    actionComplete: '完成任务',
    actionReschedule: '重排计划',
    actionRemember: '写入记忆',
    actionDefault: '计划动作',

    saved: '已保存',
    updated: '已更新',
    rescheduled: '已重排',
    chatCleared: '对话已清空',
    resetTitle: '重置长期记忆',
    resetContent: '这会清空偏好、任务模式和助手备注，但不会删除任务列表。是否继续？',
    resetDone: '已重置',
    cannotExecute: '暂时无法执行',
    retryLater: '请稍后重试',
    cancelFailed: '取消失败',
    needTitle: '先写任务名',
    noResult: 'AI 暂时没有返回结果',
    mayOvertime: '可能要超时',
    adjustPlan: '调整计划',
    keepGoing: '继续做',
    noActions: '计划里没有需要执行的动作。',
    addedTask: '已加入：{title}。',
    notAddedTask: '没有写入：{title}。',
    executedActions: '已执行：{changes}。',
    stuckRecorded: '已记录一次卡住。完成后我会把这类任务的预估调得更稳一点。',
    overrunContent: '"{title}"已用到预估的 80%。要先给后面的任务预留 {duration} 吗？',
    bufferReserved: '已给"{title}"预留 {duration}，后续任务已顺延。',
    tasksShiftedLater: '后续任务已后移 {duration}。',
    tasksShiftedEarlier: '后续任务已提前 {duration}。',
    taskCompletedMsg: '"{title}"已完成，{feedback}。{dynamic}',
    seedMessage: '把今天要做的事直接丢给我就行。我会先整理成行动计划，你确认后再写入日程和记忆。',

    langLabel: 'EN',
  },
  en: {
    tabChat: 'Chat',
    tabSchedule: 'Schedule',
    tabMemory: 'Memory',

    hello: 'Hello!',
    assistantName: 'Alicia, your AI schedule assistant',
    assistantCopy: 'Just chat with me.',
    chipCreate: '+ New event',
    chipToday: 'Today\'s plan',
    chipFree: 'Free time',
    promptCreate: 'Create a new event for me',
    promptToday: 'Show me today\'s schedule',
    promptFree: 'When am I free?',
    confirmPrefix: 'Confirm',
    confirmSuffix: 'actions',
    cancel: 'Cancel',
    confirm: 'Confirm',
    processing: 'Processing',
    inputPlaceholder: 'Type your schedule request',
    send: 'Send',
    listening: 'Listening',
    transcribing: 'Transcribing voice',
    voiceButtonLabel: 'Voice input',
    voiceCancelLabel: 'Cancel recording',
    voiceDoneLabel: 'Finish recording',
    voiceTooShort: 'Recording is too short',
    voiceReady: 'Voice converted to text',
    voiceFailed: 'Voice transcription failed',
    retryVoice: 'Retry',
    voiceUnavailable: 'Recording is not supported',
    micPermissionTitle: 'Microphone permission',
    micPermissionContent: 'Allow microphone access in Settings. Audio is used only to turn speech into schedule text.',
    openSettings: 'Settings',

    navSchedule: 'Schedule',
    viewByDate: 'View by date',
    today: 'Today',
    reschedule: 'Reschedule',
    start: 'Start',
    done: 'Done',
    noEvents: 'No events this day',
    noEventsHint: 'Go to Chat and say "Meeting at 3pm tomorrow".',
    items: 'items',
    estimated: 'Est.',
    noEventsToday: 'Nothing scheduled yet',
    notScheduled: 'Not scheduled',
    late: 'May run late',

    navMemory: 'Memory',
    prefsTitle: 'Preferences & Learning',
    prefsSubtitle: 'Synced to your private server memory to improve future estimates and schedules.',
    localBadge: 'Long-term',
    basicPrefs: 'Basic Preferences',
    startTime: 'Start',
    endTime: 'End',
    breakTime: 'Break',
    toneSetting: 'Tone',
    savePrefs: 'Save',
    secretaryProfile: 'Assistant Profile',
    noProfile: 'No profile entries yet',
    noProfileHint: 'Tell the AI your preferences, e.g. "Mornings are best for deep work".',
    taskPatterns: 'Task Patterns',
    noPatterns: 'No patterns yet',
    noPatternsHint: 'Complete a few tasks and average durations will appear here.',
    agentNotes: 'Agent Notes',
    noNotes: 'No notes yet',
    noNotesHint: 'E.g. "I prefer focused work in the morning" — confirmed notes appear here.',
    clearChat: 'Clear chat',
    resetMemory: 'Reset memory',
    samples: 'samples',
    timesUnit: '',
    commonSlot: 'Common slot',

    statusTodo: 'To-do',
    statusPlanned: 'Planned',
    statusRunning: 'In progress',
    statusPaused: 'Paused',
    statusCompleted: 'Completed',

    priorityUrgent: 'Urgent',
    priorityHigh: 'High',
    priorityMedium: 'Medium',
    priorityLow: 'Low',

    actionCreate: 'Create task',
    actionUpdate: 'Update task',
    actionDelete: 'Delete task',
    actionComplete: 'Complete task',
    actionReschedule: 'Reschedule',
    actionRemember: 'Save to memory',
    actionDefault: 'Action',

    saved: 'Saved',
    updated: 'Updated',
    rescheduled: 'Rescheduled',
    chatCleared: 'Chat cleared',
    resetTitle: 'Reset Memory',
    resetContent: 'This clears preferences, patterns, and notes but keeps your tasks. Continue?',
    resetDone: 'Reset done',
    cannotExecute: 'Cannot execute',
    retryLater: 'Please try again later',
    cancelFailed: 'Cancel failed',
    needTitle: 'Enter a task name first',
    noResult: 'No response from AI',
    mayOvertime: 'May go overtime',
    adjustPlan: 'Adjust plan',
    keepGoing: 'Keep going',
    noActions: 'No actions to execute.',
    addedTask: 'Added: {title}.',
    notAddedTask: 'Not added: {title}.',
    executedActions: 'Done: {changes}.',
    stuckRecorded: 'Marked as stuck. Future estimates for this type will be adjusted.',
    overrunContent: '"{title}" has reached 80% of estimated time. Reserve {duration} buffer for remaining tasks?',
    bufferReserved: 'Reserved {duration} for "{title}", remaining tasks shifted.',
    tasksShiftedLater: 'Remaining tasks shifted back {duration}.',
    tasksShiftedEarlier: 'Remaining tasks moved up {duration}.',
    taskCompletedMsg: '"{title}" completed, {feedback}. {dynamic}',
    seedMessage: 'Just tell me what you need to do today. I\'ll organize it into an action plan for you to confirm.',

    langLabel: '中',
  }
}

const taskCopy = require('./task-copy')
Object.assign(STRINGS.zh, taskCopy.zh)
Object.assign(STRINGS.en, taskCopy.en)
const localeCopy = require('./locale-copy')
Object.assign(STRINGS.zh, localeCopy.zh)
Object.assign(STRINGS.en, localeCopy.en)

let fallbackLang = 'zh'

function canUseWxStorage() {
  return typeof wx !== 'undefined' && wx.getStorageSync && wx.setStorageSync
}

function getLang() {
  if (!canUseWxStorage()) return fallbackLang
  try {
    const lang = wx.getStorageSync(LANG_KEY)
    return lang === 'en' ? 'en' : 'zh'
  } catch (error) {
    return fallbackLang
  }
}

function setLang(lang) {
  const next = lang === 'en' ? 'en' : 'zh'
  fallbackLang = next
  if (canUseWxStorage()) {
    wx.setStorageSync(LANG_KEY, next)
  }
  return next
}

function t(key) {
  return translate(key, getLang())
}

// Server callers pass their request language; never change a global locale.
function translate(key, language, params) {
  const lang = language === 'en' ? 'en' : 'zh'
  const catalog = STRINGS[lang] || STRINGS.zh
  let value = catalog[key] !== undefined ? catalog[key] : (STRINGS.zh[key] || key)
  Object.keys(params || {}).forEach(k => { value = value.split('{' + k + '}').join(String(params[k])) })
  return value
}

function tf(key, params) {
  let text = t(key)
  if (params) {
    Object.keys(params).forEach(function (k) {
      text = text.split('{' + k + '}').join(String(params[k]))
    })
  }
  return text
}

function statusText(status) {
  var map = {
    todo: t('statusTodo'),
    planned: t('statusPlanned'),
    running: t('statusRunning'),
    paused: t('statusPaused'),
    completed: t('statusCompleted')
  }
  return map[status] || t('statusTodo')
}

function actionLabel(type) {
  var map = {
    create_task: t('actionCreate'),
    update_task: t('actionUpdate'),
    delete_task: t('actionDelete'),
    complete_task: t('actionComplete'),
    reschedule_tasks: t('actionReschedule'),
    remember_preference: t('actionRemember')
  }
  return map[type] || t('actionDefault')
}

function hasTranslation(key, lang) {
  var catalog = STRINGS[lang === 'en' ? 'en' : 'zh']
  return Object.prototype.hasOwnProperty.call(catalog, key)
}

function priorityText(priority) {
  var map = {
    urgent: t('priorityUrgent'),
    high: t('priorityHigh'),
    medium: t('priorityMedium'),
    low: t('priorityLow')
  }
  return map[priority] || t('priorityMedium')
}

function completionFeedbackText(feedback) {
  if (!feedback) return ''
  if (getLang() !== 'en') return feedback.level + ' · ' + feedback.text
  var diff = Number(feedback.diffMinutes) || 0
  var ratio = Math.abs(Number(feedback.ratio) || 0)
  var level = 'On time'
  if (ratio > 0.6) level = diff > 0 ? 'Significantly over' : 'Well ahead'
  else if (ratio > 0.2) level = diff > 0 ? 'Over' : 'Ahead'
  var detail = diff === 0
    ? 'estimate matched actual time'
    : (diff > 0 ? 'over by ' : 'ahead by ') + Math.abs(diff) + ' min'
  return level + ' · ' + detail
}

function monthName(index) {
  return MONTHS_EN[index] || ''
}

function monthShort(index) {
  return MONTHS_SHORT[index] || ''
}

function getLangData() {
  var lang = getLang()
  var catalog = STRINGS[lang] || STRINGS.zh
  return {
    lang: lang,
    langLabel: catalog.langLabel,
    i18n: Object.assign({}, catalog)
  }
}

function applyTabBar() {
  if (typeof wx === 'undefined') return
  var items = [
    { index: 0, text: t('tabChat') },
    { index: 1, text: t('tabSchedule') },
    { index: 2, text: t('tabMemory') }
  ]
  items.forEach(function (item) {
    if (wx.setTabBarItem) {
      wx.setTabBarItem(item)
    }
  })
}

function applyLang(page) {
  var data = getLangData()
  if (page && page.data && page.data.theme) data.themeText = t(page.data.theme === 'dark' ? 'toggleLight' : 'toggleDark')
  if (page && page.setData) {
    page.setData(data)
  }
  applyTabBar()
  return data
}

function toggleLang(page) {
  var next = getLang() === 'zh' ? 'en' : 'zh'
  setLang(next)
  return applyLang(page)
}

module.exports = {
  translate,
  LANG_KEY: LANG_KEY,
  actionLabel: actionLabel,
  applyLang: applyLang,
  applyTabBar: applyTabBar,
  completionFeedbackText: completionFeedbackText,
  getLang: getLang,
  getLangData: getLangData,
  hasTranslation: hasTranslation,
  monthName: monthName,
  monthShort: monthShort,
  priorityText: priorityText,
  setLang: setLang,
  statusText: statusText,
  t: t,
  tf: tf,
  toggleLang: toggleLang
}
