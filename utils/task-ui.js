const storage = require('./storage')
const lifecycle = require('./task-lifecycle')
const scheduler = require('./scheduler')
const i18n = require('./i18n')

let prompting = false

function complete(id) {
  storage.saveTaskState(lifecycle.completeState(storage.exportState(), id))
}

function checkPrompts(onChange) {
  if (prompting || typeof wx === 'undefined') return
  const state = storage.exportState()
  const pending = state.tasks.find((task) => task.pendingAdjustment)
  const running = state.tasks.find((task) => task.status === 'running' && !task.warnedAt80 && lifecycle.elapsedSeconds(task) >= Number(task.estimatedMinutes) * 60 * 0.8)
  if (!pending && !running) return
  prompting = true
  const task = pending || running
  const minutes = Math.max(10, Math.round(Number(task.estimatedMinutes) * 0.25 / 5) * 5)
  if (running && !pending) storage.saveTasks(state.tasks.map((item) => item.id === task.id ? { ...item, warnedAt80: true, updatedAt: Date.now() } : item))
  wx.showModal({ confirmText: i18n.t('confirm'), cancelText: i18n.t('cancel'),
    title: i18n.t(pending ? 'adjustAfterTitle' : 'mayOvertime'),
    content: pending
      ? i18n.tf('adjustAfterBody', { title: task.title, difference: i18n.completionFeedbackText(task.feedback) })
      : i18n.tf('thresholdBody', { title: task.title, minutes }),
    confirmText: i18n.t('adjustPlan'), cancelText: i18n.t('keepGoing'),
    success(result) {
      const latest = storage.exportState()
      const next = pending ? lifecycle.resolveAdjustment(latest, task.id, result.confirm)
        : result.confirm ? lifecycle.reserveBuffer(latest, task.id, minutes) : latest
      storage.saveTaskState(next)
      if (result.confirm) storage.appendMessage({ role: 'assistant', content: i18n.t('planAdjusted') })
      if (onChange) onChange()
    },
    fail(error) {
      console.error('task adjustment prompt failed', error)
      if (!pending) storage.saveTasks(storage.getTasks().map((item) => item.id === task.id ? { ...item, warnedAt80: false } : item))
    },
    complete() { prompting = false }
  })
}

function adjustNextEstimate(id) {
  const task = storage.getTasks().find((item) => item.id === id)
  if (!task) return
  wx.showModal({ confirmText: i18n.t('confirm'), cancelText: i18n.t('cancel'),
    title: i18n.t('nextEstimateTitle'), editable: true, content: String(task.actualMinutes || task.estimatedMinutes),
    success(result) {
      if (!result.confirm) return
      const minutes = Number(result.content)
      if (!Number.isFinite(minutes) || minutes < 5 || minutes > 1440) {
        wx.showToast({ title: i18n.t('durationInvalid'), icon: 'none' }); return
      }
      const memory = storage.getMemory()
      memory.durationOverrides = { ...(memory.durationOverrides || {}), [scheduler.categorizeTask(task)]: { minutes, updatedAt: Date.now() } }
      storage.saveMemory(memory)
      wx.showToast({ title: i18n.t('nextEstimateSaved'), icon: 'none' })
    }
  })
}

function watch(page, refresh, periodic = false) {
  unwatch(page)
  checkPrompts(refresh)
  page._sessionWatcher = setInterval(() => { if (periodic) refresh(); checkPrompts(refresh) }, 1000)
}

function unwatch(page) {
  if (page._sessionWatcher) clearInterval(page._sessionWatcher)
  page._sessionWatcher = null
}

module.exports = { complete, checkPrompts, adjustNextEstimate, watch, unwatch }
