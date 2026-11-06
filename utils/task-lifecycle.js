const scheduler = require('./scheduler')
const time = require('./time')

function elapsedSeconds(task, now = Date.now()) {
  const base = Math.max(0, Number(task.elapsedSeconds) || 0)
  const since = task.timerStartedAt || task.startedAt
  return base + (task.status === 'running' && since ? Math.max(0, Math.floor((now - since) / 1000)) : 0)
}

function startTask(tasks, id, now = Date.now()) {
  return tasks.map((task) => {
    if (task.id === id && !['completed', 'deleted'].includes(task.status)) {
      return { ...task, elapsedSeconds: elapsedSeconds(task, now), startedAt: task.startedAt || now, timerStartedAt: now, status: 'running', updatedAt: now }
    }
    return task.status === 'running' ? { ...task, elapsedSeconds: elapsedSeconds(task, now), timerStartedAt: null, status: 'paused', updatedAt: now } : task
  })
}

function pauseTask(tasks, id, now = Date.now()) {
  return tasks.map((task) => task.id === id && task.status === 'running'
    ? { ...task, elapsedSeconds: elapsedSeconds(task, now), timerStartedAt: null, status: 'paused', updatedAt: now } : task)
}

function adjustAfterCompletion(tasks, completed, memory, now = Date.now()) {
  const delta = completed.feedback.diffMinutes - Number(completed.reservedBufferMinutes || 0)
  const dateKey = completed.dateKey || time.todayKey()
  return scheduler.reflowRemainingTasks(tasks, {
    dateKey, memory, now,
    shiftFromMinute: completed.scheduledEndMinute || 0,
    deltaMinutes: delta
  })
}

function completeState(state, id, options = {}) {
  const target = state.tasks.find((task) => task.id === id)
  if (!target || ['completed', 'deleted'].includes(target.status)) return state
  const now = options.now == null ? Date.now() : options.now
  const seconds = elapsedSeconds(target, now)
  const supplied = Number(options.actualMinutes)
  const actualMinutes = supplied > 0 ? supplied : Math.max(1, Math.ceil(seconds / 60) || Number(target.estimatedMinutes) || 1)
  const completed = { ...target, status: 'completed', actualMinutes, elapsedSeconds: supplied > 0 ? actualMinutes * 60 : seconds || actualMinutes * 60, timerStartedAt: null, completedAt: now, updatedAt: now }
  if (options.feedback) completed.feedbackText = options.feedback
  completed.feedback = scheduler.completionFeedback(completed)
  const autoAdjust = options.adjustPlan == null ? Boolean(state.memory.userPreferences.dynamicPlan) : options.adjustPlan
  completed.pendingAdjustment = !autoAdjust && completed.feedback.diffMinutes !== 0
  let tasks = state.tasks.map((task) => task.id === id ? completed : task)
  const history = [{ ...completed, historyTitle: completed.title }, ...state.history.filter((task) => task.id !== id)].slice(0, 120)
  const memory = scheduler.withCompletionStats(scheduler.learnFromCompletion(state.memory, completed), tasks, history, now)
  if (autoAdjust) tasks = adjustAfterCompletion(tasks, completed, memory, now)
  return { ...state, tasks, history, memory }
}

function resolveAdjustment(state, id, accepted, now = Date.now()) {
  const task = state.tasks.find((item) => item.id === id && item.pendingAdjustment)
  if (!task) return state
  const tasks = accepted ? adjustAfterCompletion(state.tasks, task, state.memory, now) : state.tasks
  return {
    ...state,
    tasks: tasks.map((item) => item.id === id ? { ...item, pendingAdjustment: false, updatedAt: now } : item),
    history: state.history.map((item) => item.id === id ? { ...item, pendingAdjustment: false } : item)
  }
}

function reserveBuffer(state, id, minutes, now = Date.now()) {
  const task = state.tasks.find((item) => item.id === id && item.status === 'running')
  if (!task) return state
  const previous = Number(task.reservedBufferMinutes || 0)
  const nextTasks = state.tasks.map((item) => item.id === id ? { ...item, reservedBufferMinutes: previous + minutes, updatedAt: now } : item)
  return { ...state, tasks: scheduler.reflowRemainingTasks(nextTasks, {
    dateKey: task.dateKey || time.todayKey(), memory: state.memory, now,
    shiftFromMinute: task.scheduledEndMinute || 0, deltaMinutes: minutes
  }) }
}

module.exports = { elapsedSeconds, startTask, pauseTask, completeState, resolveAdjustment, reserveBuffer }
