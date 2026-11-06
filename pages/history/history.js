const scheduler = require('../../utils/scheduler')
const storage = require('../../utils/storage')
const theme = require('../../utils/theme')
const i18n = require('../../utils/i18n')
const runtime = require('../../utils/runtime')
const time = require('../../utils/time')
const controls = require('../../utils/schedule-controls')
const taskUi = require('../../utils/task-ui')
const replanUi = require('../../utils/replan-presentation')
const systemCopy = require('../../utils/system-copy')

function toDate(dateKey) {
  var parts = String(dateKey || time.todayKey()).split('-').map(Number)
  return new Date(parts[0], parts[1] - 1, parts[2])
}

function formatMonthLabel(dateKey) {
  var date = toDate(dateKey)
  if (i18n.getLang() === 'en') {
    return i18n.monthName(date.getMonth()) + ' ' + date.getFullYear()
  }
  return date.getFullYear() + '年' + (date.getMonth() + 1) + '月'
}

function formatDayTitle(dateKey) {
  return time.relativeDateText(dateKey) + ' · ' + dateKey
}

function formatTask(task) {
  var feedback = task.feedback || (task.status === 'completed' ? scheduler.completionFeedback(task) : null)
  var hasScheduledMinutes = task.scheduledStartMinute != null
    && task.scheduledEndMinute != null
    && Number.isFinite(Number(task.scheduledStartMinute))
    && Number.isFinite(Number(task.scheduledEndMinute))
  return {
    ...task,
    statusText: i18n.statusText(task.status),
    priorityText: i18n.priorityText(task.priority),
    estimateText: time.formatDuration(task.estimatedMinutes),
    actualText: task.actualMinutes ? time.formatDuration(task.actualMinutes) : '',
    periodText: hasScheduledMinutes
      ? time.formatScheduleMinute(task.scheduledStartMinute) + '-' + time.formatScheduleMinute(task.scheduledEndMinute)
      : task.scheduledStart && task.scheduledEnd
        ? task.scheduledStart + '-' + task.scheduledEnd
      : i18n.t('notScheduled'),
    slotText: task.effectiveSlot ? time.slotText(task.effectiveSlot) : time.slotText(task.preferredSlot),
    feedbackText: i18n.completionFeedbackText(feedback)
  }
}

function buildCalendarDays(monthDateKey, selectedDateKey, tasks) {
  var monthDate = toDate(monthDateKey)
  var firstDay = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1)
  var start = new Date(firstDay)
  start.setDate(firstDay.getDate() - firstDay.getDay())
  var taskCounts = tasks.reduce(function (map, task) {
    if (task.status === 'deleted') return map
    var key = task.dateKey || time.todayKey()
    map[key] = (map[key] || 0) + 1
    return map
  }, {})

  return Array.from({ length: 42 }).map(function (_, index) {
    var date = new Date(start)
    date.setDate(start.getDate() + index)
    var dateKey = time.formatDateKey(date)
    return {
      dateKey: dateKey,
      day: date.getDate(),
      isCurrentMonth: date.getMonth() === monthDate.getMonth(),
      isSelected: dateKey === selectedDateKey,
      isToday: dateKey === time.todayKey(),
      taskCount: taskCounts[dateKey] || 0
    }
  })
}

function buildDaySummary(tasks) {
  if (!tasks.length) return i18n.t('noEventsToday')
  var total = tasks
    .filter(function (task) { return task.status !== 'completed' })
    .reduce(function (sum, task) { return sum + (Number(task.estimatedMinutes) || 0) }, 0)
  return tasks.length + ' ' + i18n.t('items') + ' · ' + i18n.t('estimated') + ' ' + time.formatDuration(total)
}

function getWeekdayLabels() {
  if (i18n.getLang() === 'en') {
    return ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
  }
  return ['日', '一', '二', '三', '四', '五', '六']
}

Page({
  data: {
    ...theme.getThemeData(),
    ...i18n.getLangData(),
    selectedDateKey: time.todayKey(),
    monthDateKey: time.todayKey(),
    monthLabel: '',
    dayTitle: '',
    daySummary: '',
    weekdayLabels: getWeekdayLabels(),
    calendarDays: [],
    dayTasks: [],
    completedRecords: [],
    replanning: false,
    replanRequest: ''
  },

  onShow() {
    theme.applyTheme(this)
    i18n.applyLang(this)
    this.setData({ weekdayLabels: getWeekdayLabels() })
    this.loadSchedule()
    taskUi.watch(this, () => { if (!this._drag) this.loadSchedule() })
    runtime.refreshState().then(() => this.loadSchedule()).catch(function (error) {
      console.error('refresh server schedule failed', error)
    })
  },

  onHide() { taskUi.unwatch(this); this.endTaskDrag() },
  onUnload() { taskUi.unwatch(this) },

  toggleTheme() {
    theme.toggleTheme(this)
  },

  toggleLang() {
    i18n.toggleLang(this)
    this.setData({ weekdayLabels: getWeekdayLabels() })
    this.loadSchedule()
  },

  loadSchedule() {
    var report = storage.getScheduleReport()
    var tasks = storage.getTasks().filter(function (task) { return task.status !== 'deleted' })
    var dayTasks = tasks
      .filter((task) => (task.dateKey || time.todayKey()) === this.data.selectedDateKey)
      .sort(function (a, b) {
        var left = a.scheduledStartMinute == null ? 99999 : a.scheduledStartMinute
        var right = b.scheduledStartMinute == null ? 99999 : b.scheduledStartMinute
        return left - right
      })
      .map(formatTask)
      .map(function (task) {
        var deferred = report && report.dateKey === task.dateKey && (report.deferred || []).find(item => item.id === task.id)
        if (deferred && task.scheduledStartMinute == null) return { ...task, scheduleReason: replanUi.entry(deferred).reasonText }
        var result = report && report.dateKey === task.dateKey && report.entries.find((item) => item.id === task.id)
        if (!result || result.afterStart !== task.scheduledStartMinute || result.afterEnd !== task.scheduledEndMinute) return task
        var detail = replanUi.entry(result)
        return { ...task, scheduleReason: detail.reasonText, scheduleChanged: report.mode !== 'suggestion' && report.changes.some((item) => item.id === task.id), previousPeriod: detail.beforeText }
      })
    var completedRecords = storage.getHistory()
      .filter((item) => (item.dateKey || time.todayKey()) === this.data.selectedDateKey)
      .slice(0, 6)
      .map(formatTask)

    this.setData({
      monthLabel: formatMonthLabel(this.data.monthDateKey),
      dayTitle: formatDayTitle(this.data.selectedDateKey),
      daySummary: buildDaySummary(dayTasks),
      calendarDays: buildCalendarDays(this.data.monthDateKey, this.data.selectedDateKey, tasks),
      dayTasks: dayTasks,
      completedRecords: completedRecords,
      replanReport: replanUi.report(report, this.data.selectedDateKey)
    })
    this.setData(controls.presentation(this, dayTasks))
  },

  selectDate(event) {
    var dateKey = event.currentTarget.dataset.date
    this.setData({ selectedDateKey: dateKey, monthDateKey: dateKey })
    this.loadSchedule()
  },

  prevMonth() {
    var date = toDate(this.data.monthDateKey)
    var next = time.formatDateKey(new Date(date.getFullYear(), date.getMonth() - 1, 1))
    this.setData({ monthDateKey: next })
    this.loadSchedule()
  },

  nextMonth() {
    var date = toDate(this.data.monthDateKey)
    var next = time.formatDateKey(new Date(date.getFullYear(), date.getMonth() + 1, 1))
    this.setData({ monthDateKey: next })
    this.loadSchedule()
  },

  goToday() {
    var today = time.todayKey()
    this.setData({ selectedDateKey: today, monthDateKey: today })
    this.loadSchedule()
  },

  onReplanRequest(event) { this.setData({ replanRequest: event.detail.value }) },

  async rescheduleDay() {
    if (this.data.replanning) return
    this.setData({ replanning: true })
    try {
      const result = await runtime.replan(this.data.selectedDateKey, storage.getPlanMode(), this.data.replanRequest)
      const report = result.state.scheduleReport
      wx.showToast({ title: i18n.t(report.mode === 'suggestion' ? 'replanSuggestedToast' : report.changedCount ? 'rescheduled' : 'replanNoChangeToast'), icon: 'none' })
      this.setData({ replanAnchor: '' })
      this.loadSchedule()
      this.setData({ replanAnchor: 'replan-result' })
    } catch (error) {
      console.error('LLM rescheduling failed', error)
      wx.showModal({ title: i18n.t('smartReplanErrorTitle'), content: error.statusCode === 409 ? systemCopy.errorText(error.message, i18n.getLang()) : i18n.t('smartReplanFailed'), confirmText: i18n.t('confirm'), showCancel: false })
    } finally { this.setData({ replanning: false }) }
  },

  startTask(event) {
    var id = event.currentTarget.dataset.id
    var tasks = storage.getTasks().map(function (task) {
      if (task.id === id) {
        return { ...task, status: 'running', startedAt: Date.now(), updatedAt: Date.now() }
      }
      return task.status === 'running' ? { ...task, status: 'paused', updatedAt: Date.now() } : task
    })
    storage.saveTasks(tasks)
    this.loadSchedule()
  },

  completeTask(event) {
    var id = event.currentTarget.dataset.id
    var tasks = storage.getTasks()
    var target = tasks.find(function (task) { return task.id === id })
    if (!target) return
    var actualMinutes = target.startedAt
      ? Math.max(1, Math.ceil((Date.now() - Number(target.startedAt)) / 60000))
      : Math.max(1, Number(target.estimatedMinutes) || 1)
    var completed = {
      ...target,
      status: 'completed',
      actualMinutes: actualMinutes,
      completedAt: Date.now(),
      updatedAt: Date.now()
    }
    var feedback = scheduler.completionFeedback(completed)
    var nextTasks = tasks.map(function (task) { return task.id === id ? { ...completed, feedback: feedback } : task })
    var history = [
      { ...completed, feedback: feedback, historyTitle: completed.title }
    ].concat(storage.getHistory()).slice(0, 120)
    var memory = scheduler.learnFromCompletion(storage.getMemory(), completed)
    if (memory.userPreferences.dynamicPlan && Math.abs(feedback.diffMinutes) >= 5) {
      nextTasks = scheduler.shiftRemainingTasks(nextTasks, completed, feedback.diffMinutes)
    }
    storage.saveTasks(nextTasks)
    storage.saveHistory(history)
    storage.saveMemory(memory)
    this.loadSchedule()
  },
  ...controls.methods
})
