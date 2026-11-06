const storage = require('../../utils/storage')
const lifecycle = require('../../utils/task-lifecycle')
const taskUi = require('../../utils/task-ui')
const theme = require('../../utils/theme')
const i18n = require('../../utils/i18n')
const runtime = require('../../utils/runtime')

function clockText(seconds) {
  return [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), seconds % 60].map((part) => String(part).padStart(2, '0')).join(':')
}

Page({
  data: { ...theme.getThemeData(), ...i18n.getLangData(), task: null, elapsedClock: '00:00:00', progress: 0 },
  onLoad(query) { this.taskId = query.id; this.refreshTimer() },
  onShow() {
    theme.applyTheme(this); i18n.applyLang(this)
    this.refreshTimer()
    taskUi.watch(this, () => this.refreshTimer(), true)
    runtime.refreshState().then(() => this.refreshTimer()).catch((error) => console.error('timer state sync failed', error))
  },
  onHide() { taskUi.unwatch(this) },
  onUnload() { taskUi.unwatch(this) },
  refreshTimer() {
    const task = storage.getTasks().find((item) => item.id === this.taskId && item.status !== 'deleted')
    if (!task) { this.setData({ task: null }); return }
    const elapsed = task.status === 'completed' ? Number(task.elapsedSeconds) || Number(task.actualMinutes) * 60 : lifecycle.elapsedSeconds(task)
    this.setData({
      task, elapsedClock: clockText(elapsed), progress: Math.min(100, Math.round(elapsed / (Number(task.estimatedMinutes) * 60) * 100)),
      statusText: i18n.statusText(task.status), feedbackText: i18n.completionFeedbackText(task.feedback),
      comparisonText: i18n.tf('estimatedActual', { estimated: task.estimatedMinutes, actual: task.actualMinutes || Math.ceil(elapsed / 60) }),
      stuckText: i18n.tf('stuckCountText', { count: Number(task.stuckCount) || 0 })
    })
  },
  pause() { storage.saveTasks(lifecycle.pauseTask(storage.getTasks(), this.taskId)); this.refreshTimer() },
  resume() { storage.saveTasks(lifecycle.startTask(storage.getTasks(), this.taskId)); this.refreshTimer() },
  finish() { taskUi.complete(this.taskId); this.refreshTimer(); taskUi.checkPrompts(() => this.refreshTimer()) },
  stuck() {
    wx.showActionSheet({
      itemList: ['stuckDistracted', 'stuckDifficult', 'stuckInterrupted'].map(i18n.t),
      success: (result) => {
        const reason = ['distracted', 'difficult', 'interrupted'][result.tapIndex]
        storage.saveTasks(storage.getTasks().map((task) => task.id === this.taskId ? {
          ...task, stuckCount: Number(task.stuckCount || 0) + 1,
          stuckEvents: (task.stuckEvents || []).concat({ reason, at: Date.now() }).slice(-30), updatedAt: Date.now()
        } : task))
        wx.showToast({ title: i18n.t('stuckHelp'), icon: 'none' }); this.refreshTimer()
      }
    })
  },
  adjustEstimate() { taskUi.adjustNextEstimate(this.taskId) },
  backToSchedule() { wx.switchTab({ url: '/pages/history/history' }) }
})
