const DEVICE_ID_KEY = 'scheduleRuntimeDeviceId'
const DEVICE_SECRET_KEY = 'scheduleRuntimeDeviceSecret'
const SYNC_DELAY_MS = 700

let revision = null
let sessionPromise = null
let pendingState = null
let syncTimer = null
let syncPromise = null

function storage() {
  return require('./storage')
}

function randomText(length) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-'
  let value = ''
  for (let index = 0; index < length; index += 1) {
    value += chars[Math.floor(Math.random() * chars.length)]
  }
  return value
}

function credentials() {
  let deviceId = wx.getStorageSync(DEVICE_ID_KEY)
  let deviceSecret = wx.getStorageSync(DEVICE_SECRET_KEY)
  if (!deviceId) {
    deviceId = `device_${Date.now()}_${randomText(16)}`
    wx.setStorageSync(DEVICE_ID_KEY, deviceId)
  }
  if (!deviceSecret) {
    deviceSecret = randomText(48)
    wx.setStorageSync(DEVICE_SECRET_KEY, deviceSecret)
  }
  return { deviceId, deviceSecret }
}

function baseUrl() {
  const app = typeof getApp === 'function' ? getApp() : null
  return String((app && app.globalData && app.globalData.agentBaseUrl) || 'http://127.0.0.1:3010/schedule-agent').replace(/\/+$/, '')
}

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    if (typeof wx === 'undefined' || !wx.request) {
      reject(new Error('当前环境无法连接 Agent Runtime'))
      return
    }
    const auth = credentials()
    wx.request({
      url: `${baseUrl()}${path}`,
      method: options.method || 'GET',
      data: options.data,
      timeout: options.timeout || 200000,
      header: {
        'content-type': 'application/json',
        'x-device-id': auth.deviceId,
        'x-device-secret': auth.deviceSecret
      },
      success(res) {
        if (res.data && res.data.ok) resolve(res.data.data)
        else {
          const error = new Error((res.data && res.data.error) || `Agent Runtime 请求失败 (${res.statusCode})`)
          error.statusCode = res.statusCode
          reject(error)
        }
      },
      fail(error) {
        reject(new Error((error && error.errMsg) || 'Agent Runtime 网络请求失败'))
      }
    })
  })
}

function applyServerState(result, keepLocalChanges = false) {
  if (!result || !result.state) return result
  revision = Number(result.revision)
  // A pause/complete can happen while a prior snapshot is in flight.
  if (keepLocalChanges && pendingState) return result
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = null
  pendingState = null
  revision = Number(result.revision)
  storage().importState(result.state)
  return result
}

function ensureSession() {
  if (sessionPromise) return sessionPromise
  if (typeof wx === 'undefined' || !wx.request) return Promise.reject(new Error('当前环境无法连接 Agent Runtime'))
  const auth = credentials()
  sessionPromise = request('/v1/session/bootstrap', {
    method: 'POST',
    data: { ...auth, initialState: storage().exportState() },
    timeout: 20000
  }).then((result) => applyServerState(result, true)).catch((error) => {
    sessionPromise = null
    throw error
  })
  return sessionPromise
}

function queueStateSync() {
  if (typeof wx === 'undefined' || !wx.request) return
  pendingState = storage().exportState()
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    syncTimer = null
    flushStateSync().catch((error) => console.error('runtime state sync failed', error))
  }, SYNC_DELAY_MS)
}

async function flushStateSync() {
  await ensureSession()
  if (syncPromise) {
    await syncPromise
    return pendingState ? flushStateSync() : null
  }
  if (!pendingState) return null
  const state = pendingState
  pendingState = null
  syncPromise = request('/v1/state', {
    method: 'PUT',
    data: { state, baseRevision: revision },
    timeout: 20000
  }).then((result) => applyServerState(result, true)).catch(async (error) => {
    if (error.statusCode === 409) {
      const current = await request('/v1/state')
      revision = Number(current.revision)
      const local = pendingState || state
      const tasks = new Map(current.state.tasks.map((task) => [task.id, task]))
      local.tasks.forEach((task) => {
        const remote = tasks.get(task.id)
        if (!remote || Number(task.updatedAt || 0) >= Number(remote.updatedAt || 0)) tasks.set(task.id, task)
      })
      const messages = new Map(current.state.messages.concat(local.messages).map((message) => [message.id, message]))
      pendingState = { ...local, tasks: Array.from(tasks.values()), messages: Array.from(messages.values()).sort((a, b) => a.createdAt - b.createdAt).slice(-80) }
      storage().importState(pendingState)
    } else {
      pendingState = pendingState || state
    }
    throw error
  }).finally(() => { syncPromise = null })
  return syncPromise
}

async function refreshState() {
  await ensureSession()
  if (pendingState || syncPromise) await flushStateSync()
  return applyServerState(await request('/v1/state'), true)
}

async function plan(text, language) {
  await ensureSession()
  if (pendingState || syncPromise) await flushStateSync()
  const result = applyServerState(await request('/v1/agent/plan', {
    method: 'POST',
    data: { text, language: language === 'en' ? 'en' : 'zh', timeContext: require('./time').captureTimeContext() }
  }))
  return result.draft
}

async function confirm(planId) {
  await ensureSession()
  return applyServerState(await request('/v1/agent/confirm', { method: 'POST', data: { planId, language: require('./i18n').getLang() } }))
}

async function replan(dateKey, mode, instruction) {
  await ensureSession()
  if (pendingState || syncPromise) await flushStateSync()
  const result = await request('/v1/agent/replan', { method: 'POST', data: { dateKey, mode, instruction, language: require('./i18n').getLang(), timeContext: require('./time').captureTimeContext() } })
  if (pendingState || syncPromise) {
    await refreshState()
    throw new Error('计划生成后日程已有变化，请重新生成计划')
  }
  return applyServerState(result, true)
}

async function saveTask(task) {
  await ensureSession()
  if (pendingState || syncPromise) await flushStateSync()
  const result = await request('/v1/tasks/save', { method: 'POST', data: { task, language: require('./i18n').getLang(), timeContext: require('./time').captureTimeContext() } })
  if (pendingState || syncPromise) {
    await refreshState()
    throw new Error('计划生成后日程已有变化，请重新生成计划')
  }
  return applyServerState(result, true)
}

async function discard(planId) {
  await ensureSession()
  return applyServerState(await request('/v1/agent/discard', { method: 'POST', data: { planId } }))
}

module.exports = { confirm, discard, ensureSession, flushStateSync, plan, replan, saveTask, queueStateSync, refreshState }
