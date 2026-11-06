const storage = require('./storage')
const scheduler = require('./scheduler')
const lifecycle = require('./task-lifecycle')
const taskUi = require('./task-ui')
const i18n = require('./i18n')
const time = require('./time')
const replanUi = require('./replan-presentation')

function presentation(page, allTasks) {
  const planMode = storage.getPlanMode()
  const memory = scheduler.withCompletionStats(storage.getMemory(), storage.getTasks(), storage.getHistory())
  const pending = allTasks.filter((task) => task.status !== 'completed')
  const report = storage.getScheduleReport()
  const smart = report && report.engine === 'llm' && report.mode === planMode && report.dateKey === page.data.selectedDateKey
  const selectedIds = new Set(smart && planMode === 'relaxed' ? report.entries.map(item => item.id)
    : scheduler.selectTasksForMode(pending, planMode, memory, page.data.selectedDateKey).map((task) => task.id))
  const visible = planMode === 'suggestion' ? [] : allTasks.filter((task) =>
    planMode === 'relaxed' ? task.status !== 'completed' && selectedIds.has(task.id) : task.status === 'completed' || selectedIds.has(task.id))
  const suggested = smart && planMode === 'suggestion' ? report.entries.filter(entry => !entry.locked).slice(0, 3).map(entry => allTasks.find(task => task.id === entry.id)).filter(Boolean)
    : scheduler.selectTasksForMode(pending, 'relaxed', memory, page.data.selectedDateKey).slice(0, 3)
  return {
    planMode, dynamicPlan: Boolean(memory.userPreferences.dynamicPlan), allDayTasks: allTasks,
    dayTasks: visible,
    modeHint: i18n.t(planMode === 'relaxed' ? 'relaxedHint' : planMode === 'suggestion' ? 'suggestionHint' : 'flexibleHint'),
    suggestions: suggested.map((task) => {
      const report = storage.getScheduleReport()
      const result = report && report.mode === 'suggestion' && report.dateKey === page.data.selectedDateKey && report.entries.find((entry) => entry.id === task.id)
      const advice = result && replanUi.entry(result)
      return { id: task.id, title: task.title, text: advice ? `${advice.afterText} · ${advice.reasonText}` : `${task.periodText} · ${task.estimateText}` }
    }),
    activeSession: storage.getTasks().find((task) => task.status === 'running' || task.status === 'paused') || null
  }
}

const methods = {
  addManualTask() { wx.navigateTo({ url: `/pages/task-edit/task-edit?date=${this.data.selectedDateKey}` }) },
  editTask(event) { wx.navigateTo({ url: `/pages/task-edit/task-edit?id=${event.currentTarget.dataset.id}` }) },
  openActiveTimer() {
    if (this.data.activeSession) wx.navigateTo({ url: `/pages/timer/timer?id=${this.data.activeSession.id}` })
  },
  changePlanMode(event) {
    storage.savePlanMode(event.currentTarget.dataset.mode)
    this.loadSchedule()
  },
  changeDynamicPlan(event) {
    const memory = storage.getMemory()
    memory.userPreferences.dynamicPlan = Boolean(event.detail.value)
    storage.saveMemory(memory)
    this.loadSchedule()
  },
  startTask(event) {
    const id = event.currentTarget.dataset.id
    storage.saveTasks(lifecycle.startTask(storage.getTasks(), id))
    this.loadSchedule()
    wx.navigateTo({ url: `/pages/timer/timer?id=${id}` })
  },
  completeTask(event) {
    const id = event.currentTarget.dataset.id
    taskUi.complete(id)
    this.loadSchedule()
    wx.navigateTo({ url: `/pages/timer/timer?id=${id}` })
  },
  adjustNextEstimate(event) { taskUi.adjustNextEstimate(event.currentTarget.dataset.id) },
  beginTaskDrag(event) {
    const id = event.currentTarget.dataset.id
    const task = storage.getTasks().find((item) => item.id === id)
    if (!task || task.status === 'completed') return
    if (task.dueClock || task.startClock || ['running', 'paused'].includes(task.status)) {
      wx.showToast({ title: i18n.t('fixedDragHint'), icon: 'none' }); return
    }
    const touch = event.touches && event.touches[0]
    if (!touch) return
    this._drag = { id, y: touch.pageY }
    this.setData({ draggingTaskId: id })
    if (wx.vibrateShort) wx.vibrateShort({ type: 'light' })
  },
  moveTaskDrag(event) {
    if (!this._drag) return
    const touch = event.touches && event.touches[0]
    if (!touch || Math.abs(touch.pageY - this._drag.y) < 70) return
    const tasks = storage.getTasks()
    const ordered = tasks.filter((task) => (task.dateKey || time.todayKey()) === this.data.selectedDateKey && !['completed', 'deleted', 'running', 'paused'].includes(task.status) && !task.dueClock && !task.startClock)
      .sort((a, b) => (a.scheduledStartMinute || 0) - (b.scheduledStartMinute || 0))
    const from = ordered.findIndex((task) => task.id === this._drag.id)
    const to = from + (touch.pageY > this._drag.y ? 1 : -1)
    if (from < 0 || to < 0 || to >= ordered.length) return
    const moved = ordered.splice(from, 1)[0]
    ordered.splice(to, 0, moved)
    storage.saveTasks(scheduler.reflowRemainingTasks(tasks, {
      dateKey: this.data.selectedDateKey, memory: storage.getMemory(), orderIds: ordered.map((task) => task.id)
    }))
    this._drag.y = touch.pageY
    this.loadSchedule()
  },
  endTaskDrag() { this._drag = null; this.setData({ draggingTaskId: '' }) }
}

module.exports = { presentation, methods }
