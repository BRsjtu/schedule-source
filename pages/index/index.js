const systemCopy = require('../../utils/system-copy')
const presentation = require('../../utils/memory-presentation')
const replanUi = require('../../utils/replan-presentation')
const { applyAgentDraft, runAgent } = require('../../utils/agent')
const scheduler = require('../../utils/scheduler')
const storage = require('../../utils/storage')
const theme = require('../../utils/theme')
const i18n = require('../../utils/i18n')
const runtime = require('../../utils/runtime')
const time = require('../../utils/time')
const transcription = require('../../utils/transcription')
const taskUi = require('../../utils/task-ui')

let timer = null
let thresholdPrompting = false

function formatMessage(message) {
  return {
    ...message,
    content: systemCopy.messageContent(message, i18n.getLang()),
    isUser: message.role === 'user',
    timeText: time.formatTimestamp(message.createdAt)
  }
}

function formatTask(task, activeTaskId, elapsedSeconds) {
  const activeElapsed = task.id === activeTaskId ? elapsedSeconds : Number(task.elapsedSeconds) || 0
  const estimatedSeconds = Math.max(60, (Number(task.estimatedMinutes) || 1) * 60)
  const progressPercent = Math.max(0, Math.min(Math.round(activeElapsed / estimatedSeconds * 100), 100))
  const hasSchedule = task.scheduledStart && task.scheduledEnd

  return {
    ...task,
    isActive: task.id === activeTaskId,
    statusText: i18n.statusText(task.status),
    priorityText: i18n.priorityText(task.priority),
    estimateText: time.formatDuration(task.estimatedMinutes),
    elapsedText: time.formatDuration(Math.ceil(activeElapsed / 60)),
    progressPercent,
    timeText: hasSchedule ? task.scheduledStart + '-' + task.scheduledEnd : i18n.t('notScheduled'),
    slotText: time.slotText(task.preferredSlot),
    overflowText: task.scheduleOverflow ? i18n.t('late') : '',
    recommendationText: presentation.recommendationText(task, i18n.getLang())
  }
}

function formatDraft(draft) {
  if (!draft) return null

  const operations = [
    ...(draft.actions || []),
    ...(draft.memoryUpdates || []).map((item) => ({ ...item, type: 'remember_preference' }))
  ]
  if (!operations.length) {
    return null
  }

  return {
    ...draft,
    actions: operations.map(function (action, index) {
      var isTaskAction = action.type === 'create_task' || action.type === 'update_task'
      var dateKey = action.dateKey || action.dueDate || action.scheduledStartDateKey || (action.type === 'create_task' ? time.todayKey() : '')
      var startClock = action.scheduledStart || action.dueClock || ''
      var endClock = action.scheduledEnd || ''
      var durationMinutes = Math.max(0, Number(action.estimatedMinutes || action.durationMinutes) || 0)
      if (startClock && !endClock) {
        var startMinute = time.parseClockToMinutes(startClock, null)
        if (startMinute != null && durationMinutes > 0) endClock = time.formatMinutesAsClock(startMinute + durationMinutes)
      }
      var dateText = ''
      if (dateKey) {
        var dateParts = String(dateKey).split('-').map(Number)
        if (dateParts.length === 3 && dateParts.every(function (part) { return Number.isFinite(part) })) {
          dateText = i18n.getLang() === 'en'
            ? i18n.monthShort(dateParts[1] - 1) + ' ' + dateParts[2] + ', ' + dateParts[0]
            : dateParts[0] + '年' + dateParts[1] + '月' + dateParts[2] + '日'
        }
      }
      return {
        ...action,
        id: draft.id + '_' + index,
        label: i18n.actionLabel(action.type),
        previewSchedule: (action.llmPreview || []).map(replanUi.entry),
        titleText: action.title || action.titleMatch || (action.key && presentation.keyText(action.key, i18n.getLang())) || (action.mode && presentation.modeText(action.mode, i18n.getLang())) || i18n.t('actionDefault'),
        memoryValue: action.type === 'remember_preference' ? presentation.valueText(action.key, action.value, i18n.getLang()) : '',
        dateText: dateText,
        scheduleText: isTaskAction && (startClock || action.preferredSlot || action.timeSlot)
          ? (startClock && endClock ? startClock + ' - ' + endClock : (startClock || time.slotText(action.preferredSlot || action.timeSlot)))
          : '',
        durationText: isTaskAction && durationMinutes ? time.formatDuration(durationMinutes) : ''
      }
    })
  }
}

function computeLayoutStyle() {
  var win = {}
  try {
    win = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()) || {}
  } catch (error) {
    win = {}
  }
  var statusBarHeight = Number(win.statusBarHeight)
    || (win.safeArea && Number(win.safeArea.top))
    || 20

  var menu = null
  try {
    menu = wx.getMenuButtonBoundingClientRect()
  } catch (error) {
    menu = null
  }
  var menuValid = menu && menu.top > 0 && menu.width > 0

  var topBarTop = menuValid ? menu.top : statusBarHeight + 4
  var topBarHeight = menuValid ? menu.height : 32
  var capsuleClearance = menuValid && win.windowWidth
    ? Math.max(win.windowWidth - menu.left, 0)
    : 0

  return [
    '--top-bar-top: ' + topBarTop + 'px',
    '--top-bar-height: ' + topBarHeight + 'px',
    '--capsule-clearance: ' + capsuleClearance + 'px'
  ].join('; ')
}

Page({
  data: {
    ...theme.getThemeData(),
    ...i18n.getLangData(),
    layoutStyle: '',
    inputText: '',
    loading: false,
    voiceStarting: false,
    isRecording: false,
    isTranscribing: false,
    voiceDurationText: '00:00',
    messages: [],
    pendingDraft: null,
    tasks: [],
    visibleTasks: [],
    completedToday: [],
    activeTaskId: '',
    draggingTaskId: '',
    timerRunning: false,
    elapsedSeconds: 0,
    elapsedText: '0',
    planMode: 'flexible',
    quickTask: {
      title: '',
      description: '',
      estimatedMinutes: '',
      priority: 'medium',
      preferredSlot: 'any'
    },
    adviceBubbles: [],
    memorySummary: '',
    todaySummary: '',
    dynamicPlan: true
  },

  onLoad() {
    this._pageAlive = true
    this.setData({ layoutStyle: computeLayoutStyle() })
    this.setupVoiceRecorder()
    storage.ensureSeedMessage(i18n.t('seedMessage'))
    this.refreshState()
  },

  onShow() {
    theme.applyTheme(this)
    i18n.applyLang(this)
    this.refreshState()
    taskUi.watch(this, () => this.refreshState())
    runtime.refreshState().then(() => this.refreshState()).catch(function (error) {
      console.error('refresh server agent state failed', error)
    })
  },

  onUnload() {
    taskUi.unwatch(this)
    this._pageAlive = false
    this.cancelVoiceRecording()
    this.teardownVoiceRecorder()
    this.stopTimer()
  },

  onHide() {
    taskUi.unwatch(this)
    if (this.data.isRecording || this.data.voiceStarting) {
      this.cancelVoiceRecording()
    }
  },

  refreshState(extra) {
    extra = extra || {}
    var memory = storage.getMemory()
    var planMode = storage.getPlanMode()
    var tasks = storage.getTasks().filter(function (task) { return task.status !== 'deleted' })
    var activeTaskId = extra.activeTaskId != null ? extra.activeTaskId : this.data.activeTaskId
    var elapsedSeconds = extra.elapsedSeconds != null ? extra.elapsedSeconds : this.data.elapsedSeconds
    var formattedTasks = tasks
      .filter(function (task) { return task.status !== 'completed' })
      .sort(function (a, b) {
        var left = a.scheduledStartMinute == null ? 99999 : a.scheduledStartMinute
        var right = b.scheduledStartMinute == null ? 99999 : b.scheduledStartMinute
        return left - right
      })
      .map(function (task) { return formatTask(task, activeTaskId, elapsedSeconds) })
    var completedToday = tasks
      .filter(function (task) { return task.status === 'completed' && task.dateKey === time.todayKey() })
      .map(function (task) { return formatTask(task, activeTaskId, elapsedSeconds) })
    var visibleTasks = planMode === 'suggestion' ? [] : formattedTasks
    var plan = scheduler.applySchedule(tasks, { mode: planMode, memory: memory })

    this.setData({
      messages: storage.getMessages().map(formatMessage),
      pendingDraft: formatDraft(storage.getDraft()),
      tasks: formattedTasks,
      visibleTasks: visibleTasks,
      completedToday: completedToday,
      planMode: planMode,
      adviceBubbles: plan.advice,
      todaySummary: plan.summary,
      dynamicPlan: Boolean(memory.userPreferences.dynamicPlan),
      activeTaskId: activeTaskId,
      activeSession: tasks.find(function (task) { return task.status === 'running' || task.status === 'paused' }) || null,
      elapsedSeconds: elapsedSeconds,
      elapsedText: time.formatDuration(Math.ceil(elapsedSeconds / 60)),
      ...extra
    })
  },

  onInput(event) {
    this.setData({ inputText: event.detail.value })
  },

  setupVoiceRecorder() {
    if (!wx.getRecorderManager) return

    var recorder = wx.getRecorderManager()
    this.recorderManager = recorder
    this._onRecorderStart = () => {
      if (!this._pageAlive || this._voiceCancelled || (this._voiceSource === 'input' && !this._inputPressActive)) {
        this._voiceCancelled = true
        this._recorderStopping = true
        recorder.stop()
        return
      }
      this._voiceStartedAt = Date.now()
      this.setData({
        voiceStarting: false,
        isRecording: true,
        isTranscribing: false,
        voiceDurationText: '00:00'
      })
      this.startVoiceTimer()
      if (wx.hideKeyboard) wx.hideKeyboard()
    }
    this._onRecorderStop = (result) => {
      this.handleVoiceRecordingStopped(result)
    }
    this._onRecorderError = (error) => {
      console.error('voice recorder failed', error)
      var cancelled = this._voiceCancelled
      this._voiceCancelled = false
      this._recorderStopping = false
      this.clearVoiceTimer()
      if (!this._pageAlive || cancelled) return
      this.setData({
        voiceStarting: false,
        isRecording: false,
        isTranscribing: false,
        voiceDurationText: '00:00'
      })
      wx.showToast({ title: i18n.t('voiceFailed'), icon: 'none' })
    }

    recorder.onStart(this._onRecorderStart)
    recorder.onStop(this._onRecorderStop)
    recorder.onError(this._onRecorderError)
  },

  teardownVoiceRecorder() {
    var recorder = this.recorderManager
    if (!recorder) return
    if (recorder.offStart && this._onRecorderStart) recorder.offStart(this._onRecorderStart)
    if (recorder.offStop && this._onRecorderStop) recorder.offStop(this._onRecorderStop)
    if (recorder.offError && this._onRecorderError) recorder.offError(this._onRecorderError)
    this.clearVoiceTimer()
    this.recorderManager = null
  },

  requestRecordPermission() {
    return new Promise(function (resolve, reject) {
      wx.getSetting({
        success: function (setting) {
          var state = setting.authSetting && setting.authSetting['scope.record']
          if (state === true) {
            resolve()
            return
          }
          if (state === false) {
            var denied = new Error('record permission denied')
            denied.permissionDenied = true
            reject(denied)
            return
          }
          wx.authorize({
            scope: 'scope.record',
            success: resolve,
            fail: function (error) {
              var denied = new Error(error && error.errMsg ? error.errMsg : 'record permission denied')
              denied.permissionDenied = true
              reject(denied)
            }
          })
        },
        fail: reject
      })
    })
  },

  openRecordSettings() {
    wx.showModal({ confirmText: i18n.t('confirm'), cancelText: i18n.t('cancel'),
      title: i18n.t('micPermissionTitle'),
      content: i18n.t('micPermissionContent'),
      confirmText: i18n.t('openSettings'),
      success: function (result) {
        if (result.confirm && wx.openSetting) wx.openSetting()
      }
    })
  },

  async startVoiceRecording(source) {
    if (this.data.loading || this.data.isTranscribing || this.data.isRecording || this.data.voiceStarting || this._recorderStopping) return
    if (!this.recorderManager) {
      wx.showToast({ title: i18n.t('voiceUnavailable'), icon: 'none' })
      return
    }

    this._voiceSource = source || 'button'
    this._voiceCancelled = false
    this.setData({ voiceStarting: true })

    try {
      await this.requestRecordPermission()
      if (!this._pageAlive || this._voiceCancelled || (this._voiceSource === 'input' && !this._inputPressActive)) {
        this.setData({ voiceStarting: false })
        return
      }
      this.recorderManager.start({
        duration: 60000,
        sampleRate: 16000,
        numberOfChannels: 1,
        encodeBitRate: 48000,
        format: 'mp3'
      })
    } catch (error) {
      this.setData({ voiceStarting: false })
      if (error && error.permissionDenied) this.openRecordSettings()
      else wx.showToast({ title: i18n.t('voiceFailed'), icon: 'none' })
    }
  },

  toggleVoiceInput() {
    if (this.data.isRecording) {
      this.finishVoiceRecording()
      return
    }
    this.startVoiceRecording('button')
  },

  onInputTouchStart() {
    this._inputPressActive = true
  },

  onInputLongPress() {
    if (this._inputPressActive) this.startVoiceRecording('input')
  },

  onInputTouchEnd() {
    this._inputPressActive = false
    if (this.data.isRecording && this._voiceSource === 'input') {
      this.finishVoiceRecording()
    }
  },

  onInputTouchCancel() {
    this._inputPressActive = false
    if (this._voiceSource === 'input') this.cancelVoiceRecording()
  },

  finishVoiceRecording() {
    if (!this.recorderManager || !this.data.isRecording || this._recorderStopping) return
    this._recorderStopping = true
    this.recorderManager.stop()
  },

  cancelVoiceRecording() {
    this._voiceCancelled = true
    this._inputPressActive = false
    this.clearVoiceTimer()
    if (this.recorderManager && (this.data.isRecording || this.data.voiceStarting) && !this._recorderStopping) {
      this._recorderStopping = true
      this.recorderManager.stop()
    }
    if (this._pageAlive) {
      this.setData({
        voiceStarting: false,
        isRecording: false,
        isTranscribing: false,
        voiceDurationText: '00:00'
      })
    }
  },

  startVoiceTimer() {
    this.clearVoiceTimer()
    this._voiceTimer = setInterval(() => {
      if (!this._pageAlive || !this.data.isRecording) return
      var seconds = Math.max(0, Math.floor((Date.now() - this._voiceStartedAt) / 1000))
      var minutes = Math.floor(seconds / 60)
      var secondsPart = seconds % 60
      var minutesText = minutes < 10 ? '0' + minutes : String(minutes)
      var secondsText = secondsPart < 10 ? '0' + secondsPart : String(secondsPart)
      this.setData({ voiceDurationText: minutesText + ':' + secondsText })
    }, 500)
  },

  clearVoiceTimer() {
    if (this._voiceTimer) clearInterval(this._voiceTimer)
    this._voiceTimer = null
  },

  async handleVoiceRecordingStopped(result) {
    this._recorderStopping = false
    this.clearVoiceTimer()
    var cancelled = this._voiceCancelled
    this._voiceCancelled = false
    this._voiceSource = ''

    if (!this._pageAlive || cancelled) return

    var duration = Number(result && result.duration) || (Date.now() - Number(this._voiceStartedAt || Date.now()))
    var filePath = result && result.tempFilePath
    if (!filePath || duration < 600) {
      this.setData({
        voiceStarting: false,
        isRecording: false,
        isTranscribing: false,
        voiceDurationText: '00:00'
      })
      wx.showToast({ title: i18n.t('voiceTooShort'), icon: 'none' })
      return
    }

    this.setData({
      voiceStarting: false,
      isRecording: false,
      isTranscribing: true,
      voiceDurationText: '00:00'
    })

    await this.transcribeVoiceFile(filePath)
  },

  async transcribeVoiceFile(filePath) {
    this._lastVoiceFilePath = filePath

    try {
      var lang = this.data.lang === 'en' ? 'en' : 'zh'
      var recognized = await transcription.transcribeFile(filePath, {
        language: '',
        uiLanguage: lang,
        prompt: 'AI智排时程, 科创, 日程, schedule, science project, meeting, homework, reminder'
      })
      if (!this._pageAlive) return

      var currentText = String(this.data.inputText || '')
      var separator = currentText && lang === 'en' && !/\s$/.test(currentText) ? ' ' : ''
      this.setData({
        inputText: currentText + separator + recognized.text,
        isTranscribing: false
      })
      this._lastVoiceFilePath = ''
      wx.showToast({ title: i18n.t('voiceReady'), icon: 'success' })
    } catch (error) {
      console.error('voice transcription failed', error)
      if (!this._pageAlive) return
      this.setData({ isTranscribing: false })
      wx.showModal({ confirmText: i18n.t('confirm'), cancelText: i18n.t('cancel'),
        title: i18n.t('voiceFailed'),
        content: systemCopy.errorText(error && error.message, i18n.getLang()),
        cancelText: i18n.t('cancel'),
        confirmText: i18n.t('retryVoice'),
        success: (result) => {
          if (!result.confirm || !this._pageAlive || this.data.isTranscribing) return
          this.setData({ isTranscribing: true })
          setTimeout(() => this.transcribeVoiceFile(filePath), 200)
        }
      })
    }
  },

  toggleTheme() {
    theme.toggleTheme(this)
  },

  toggleLang() {
    i18n.toggleLang(this)
    this.refreshState()
  },

  useQuickPrompt(event) {
    var prompt = event.currentTarget.dataset.prompt
    if (event.currentTarget.dataset.fill) { this.setData({ inputText: prompt }); return }
    this.askAgent(prompt)
  },

  sendAgentMessage() {
    this.askAgent(this.data.inputText)
  },

  async askAgent(rawText) {
    var text = String(rawText || '').trim()
    if (!text || this.data.loading) return

    storage.appendMessage({ role: 'user', content: text })
    this.setData({
      inputText: '',
      loading: true,
      messages: storage.getMessages().map(formatMessage)
    })

    try {
      var draft = await runAgent(text, this.data.lang)
      if (!draft.runtimeManaged) {
        storage.saveDraft(draft)
        storage.appendMessage({ role: 'assistant', content: draft.reply })
      }
      this.refreshState({ loading: false })
    } catch (error) {
      console.error('agent request failed', error)
      var message = systemCopy.errorText(error && error.message, i18n.getLang())
      storage.appendMessage({ role: 'assistant', content: message })
      this.refreshState({ loading: false })
    }
  },

  async confirmDraft() {
    var draft = storage.getDraft()
    if (!draft) return
    try {
      if (draft.runtimeManaged) {
        await runtime.confirm(draft.id)
      } else {
        var result = applyAgentDraft(draft)
        var content = systemCopy.executionText(result.changeDetails, i18n.getLang())
        storage.appendMessage({ role: 'assistant', content, system: { type: 'execution', changes: result.changeDetails } })
      }
      wx.showToast({ title: i18n.t('updated'), icon: 'success' })
      this.refreshState()
    } catch (error) {
      console.error('plan execution failed', error)
      wx.showModal({ confirmText: i18n.t('confirm'), cancelText: i18n.t('cancel'), title: i18n.t('cannotExecute'), content: systemCopy.errorText(error.message, i18n.getLang()), showCancel: false })
    }
  },

  async discardDraft() {
    var draft = storage.getDraft()
    try {
      if (draft && draft.runtimeManaged) await runtime.discard(draft.id)
      else storage.clearDraft()
      this.refreshState()
    } catch (error) {
      wx.showToast({ title: i18n.t('cancelFailed'), icon: 'none' })
    }
  },

  changeMode(event) {
    var mode = event.currentTarget.dataset.mode
    storage.savePlanMode(mode)
    this.refreshState({ planMode: mode })
  },

  startTask(event) {
    var id = event.currentTarget.dataset.id
    var tasks = storage.getTasks()
    var nextTasks = tasks.map(function (task) {
      if (task.id === id) {
        return { ...task, status: 'running', startedAt: task.startedAt || Date.now(), updatedAt: Date.now() }
      }
      if (task.status === 'running') {
        return { ...task, status: 'paused', updatedAt: Date.now() }
      }
      return task
    })
    var target = nextTasks.find(function (task) { return task.id === id })
    storage.saveTasks(nextTasks)
    this.setData({
      activeTaskId: id,
      timerRunning: true,
      elapsedSeconds: Number(target && target.elapsedSeconds) || 0
    })
    this.startTimer()
    this.refreshState({
      activeTaskId: id,
      timerRunning: true,
      elapsedSeconds: Number(target && target.elapsedSeconds) || 0
    })
  },

  pauseTask() {
    this.persistActiveElapsed('paused')
    this.stopTimer()
    this.refreshState({ timerRunning: false })
  },

  resumeTask() {
    if (!this.data.activeTaskId) return
    this.persistActiveElapsed('running')
    this.setData({ timerRunning: true })
    this.startTimer()
  },

  markStuck() {
    var id = this.data.activeTaskId
    if (!id) return
    var tasks = storage.getTasks().map(function (task) {
      return task.id === id
        ? { ...task, stuckCount: Number(task.stuckCount || 0) + 1, updatedAt: Date.now() }
        : task
    })
    storage.saveTasks(tasks)
    storage.appendMessage({ role: 'assistant', content: i18n.t('stuckRecorded') })
    this.refreshState()
  },

  finishTask(event) {
    var id = (event && event.currentTarget.dataset.id) || this.data.activeTaskId
    if (!id) return

    var tasks = storage.getTasks()
    var target = tasks.find(function (task) { return task.id === id })
    if (!target) return

    var currentElapsed = id === this.data.activeTaskId
      ? this.data.elapsedSeconds
      : Number(target.elapsedSeconds) || (Number(target.estimatedMinutes) || 1) * 60
    var actualMinutes = Math.max(1, Math.ceil(currentElapsed / 60))
    var completed = {
      ...target,
      status: 'completed',
      actualMinutes: actualMinutes,
      elapsedSeconds: currentElapsed,
      completedAt: Date.now(),
      updatedAt: Date.now()
    }
    var feedback = scheduler.completionFeedback(completed)
    var nextTasks = tasks.map(function (task) { return task.id === id ? { ...completed, feedback: feedback } : task })
    var history = [completedHistoryRecord(completed, feedback)].concat(storage.getHistory()).slice(0, 120)
    var memory = scheduler.learnFromCompletion(storage.getMemory(), completed)
    var dynamicText = ''

    if (memory.userPreferences.dynamicPlan && Math.abs(feedback.diffMinutes) >= 5) {
      nextTasks = scheduler.shiftRemainingTasks(nextTasks, completed, feedback.diffMinutes)
      var shiftKey = feedback.diffMinutes > 0 ? 'tasksShiftedLater' : 'tasksShiftedEarlier'
      dynamicText = i18n.tf(shiftKey, { duration: time.formatDuration(Math.abs(feedback.diffMinutes)) })
    }

    storage.saveTasks(nextTasks)
    storage.saveHistory(history)
    storage.saveMemory(memory)
    storage.appendMessage({
      role: 'assistant',
      content: i18n.tf('taskCompletedMsg', {
        title: completed.title,
        feedback: i18n.completionFeedbackText(feedback),
        dynamic: dynamicText
      })
    })
    this.stopTimer()
    this.refreshState({ activeTaskId: '', timerRunning: false, elapsedSeconds: 0 })
  },

  deleteTask(event) {
    var id = event.currentTarget.dataset.id
    var tasks = storage.getTasks().map(function (task) {
      return task.id === id ? { ...task, status: 'deleted', updatedAt: Date.now() } : task
    })
    storage.saveTasks(tasks)
    this.refreshState()
  },

  adjustEstimate(event) {
    var id = event.currentTarget.dataset.id
    var delta = Number(event.currentTarget.dataset.delta) || 0
    var tasks = storage.getTasks().map(function (task) {
      return task.id === id
        ? { ...task, estimatedMinutes: Math.max(5, Number(task.estimatedMinutes || 0) + delta), updatedAt: Date.now() }
        : task
    })
    var plan = scheduler.applySchedule(tasks, { mode: this.data.planMode, memory: storage.getMemory() })
    storage.saveTasks(plan.tasks)
    this.refreshState()
  },

  moveTask(event) {
    var id = event.currentTarget.dataset.id
    var direction = Number(event.currentTarget.dataset.direction) || 0
    if (!direction) return
    this.reorderTaskById(id, direction)
  },

  reorderTaskById(id, direction) {
    var ordered = storage.getTasks()
      .filter(function (task) { return task.status !== 'completed' && task.status !== 'deleted' })
      .sort(function (a, b) {
        var left = a.scheduledStartMinute == null ? 99999 : a.scheduledStartMinute
        var right = b.scheduledStartMinute == null ? 99999 : b.scheduledStartMinute
        return left - right
      })
    var index = ordered.findIndex(function (task) { return task.id === id })
    var targetIndex = index + direction
    if (index < 0 || targetIndex < 0 || targetIndex >= ordered.length) return

    var current = ordered[index]
    var swapTarget = ordered[targetIndex]
    var swapped = storage.getTasks().map(function (task) {
      if (task.id === current.id) return copySchedule(task, swapTarget)
      if (task.id === swapTarget.id) return copySchedule(task, current)
      return task
    })
    storage.saveTasks(swapped)
    this.refreshState()
  },

  startDragTask(event) {
    var id = event.currentTarget.dataset.id
    var touch = event.touches && event.touches[0]
    if (!id || !touch) return
    this.dragState = { id: id, startY: touch.pageY }
    this.setData({ draggingTaskId: id })
  },

  dragTask(event) {
    if (!this.dragState) return
    var touch = event.touches && event.touches[0]
    if (!touch) return
    var deltaY = touch.pageY - this.dragState.startY
    if (Math.abs(deltaY) < 84) return
    var direction = deltaY > 0 ? 1 : -1
    this.reorderTaskById(this.dragState.id, direction)
    this.dragState.startY = touch.pageY
    if (wx.vibrateShort) wx.vibrateShort({ type: 'light' })
  },

  endDragTask() {
    this.dragState = null
    this.setData({ draggingTaskId: '' })
  },

  startTimer() {
    this.stopTimer()
    var startedAt = Date.now()
    var baseSeconds = this.data.elapsedSeconds
    var self = this
    timer = setInterval(function () {
      var elapsedSeconds = baseSeconds + Math.floor((Date.now() - startedAt) / 1000)
      self.setData({
        elapsedSeconds: elapsedSeconds,
        elapsedText: time.formatDuration(Math.ceil(elapsedSeconds / 60))
      })
      self.maybePromptOverrun(elapsedSeconds)
    }, 1000)
  },

  stopTimer() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  },

  persistActiveElapsed(status) {
    var id = this.data.activeTaskId
    if (!id) return
    var elapsedSeconds = this.data.elapsedSeconds
    var tasks = storage.getTasks().map(function (task) {
      return task.id === id
        ? { ...task, status: status, elapsedSeconds: elapsedSeconds, updatedAt: Date.now() }
        : task
    })
    storage.saveTasks(tasks)
  },

  maybePromptOverrun(elapsedSeconds) {
    if (thresholdPrompting || !this.data.activeTaskId) return
    var tasks = storage.getTasks()
    var task = tasks.find((item) => item.id === this.data.activeTaskId)
    if (!task || task.warnedAt80 || task.status !== 'running') return

    var estimateSeconds = Math.max(60, (Number(task.estimatedMinutes) || 1) * 60)
    if (elapsedSeconds < estimateSeconds * 0.8) return

    thresholdPrompting = true
    var bufferMinutes = Math.max(10, Math.round((Number(task.estimatedMinutes) || 45) * 0.25 / 5) * 5)
    storage.saveTasks(tasks.map(function (item) {
      return item.id === task.id ? { ...item, warnedAt80: true, updatedAt: Date.now() } : item
    }))

    var self = this
    wx.showModal({ confirmText: i18n.t('confirm'), cancelText: i18n.t('cancel'),
      title: i18n.t('mayOvertime'),
      content: i18n.tf('overrunContent', { title: task.title, duration: time.formatDuration(bufferMinutes) }),
      confirmText: i18n.t('adjustPlan'),
      cancelText: i18n.t('keepGoing'),
      success: function (res) {
        if (res.confirm) {
          var shifted = scheduler.shiftRemainingTasks(storage.getTasks(), task, bufferMinutes)
          storage.saveTasks(shifted)
          storage.appendMessage({
            role: 'assistant',
            content: i18n.tf('bufferReserved', { title: task.title, duration: time.formatDuration(bufferMinutes) })
          })
          self.refreshState({ elapsedSeconds: elapsedSeconds })
        }
      },
      complete: function () {
        thresholdPrompting = false
      }
    })
  }
})

function completedHistoryRecord(task, feedback) {
  return {
    ...task,
    historyTitle: task.title,
    feedback: feedback,
    timeText: time.formatTimestamp(task.completedAt),
    createdAt: task.createdAt || Date.now()
  }
}

function copySchedule(task, source) {
  return {
    ...task,
    scheduledStart: source.scheduledStart,
    scheduledEnd: source.scheduledEnd,
    scheduledStartMinute: source.scheduledStartMinute,
    scheduledEndMinute: source.scheduledEndMinute,
    scheduleOverflow: source.scheduleOverflow,
    updatedAt: Date.now()
  }
}
