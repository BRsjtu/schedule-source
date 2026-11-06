const http = require('node:http')
const path = require('node:path')
const { loadConfig } = require('./config')
const { RuntimeDatabase } = require('./database')
const { AgentRuntime } = require('./runtime')

const MAX_BODY_BYTES = 1024 * 1024

function send(res, statusCode, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(Object.assign(new Error('请求 JSON 无效'), { statusCode: 400 })) }
    })
    req.on('error', reject)
  })
}

function credentials(req) {
  return {
    deviceId: req.headers['x-device-id'],
    deviceSecret: req.headers['x-device-secret']
  }
}

function createServer(config = loadConfig()) {
  const database = new RuntimeDatabase(path.join(config.dataDir, 'schedule-agent.sqlite'))
  const runtime = new AgentRuntime(config, database)
  const rate = new Map()

  function checkRateLimit(key) {
    const now = Date.now()
    const entry = rate.get(key) || { start: now, count: 0 }
    if (now - entry.start > 60000) { entry.start = now; entry.count = 0 }
    entry.count += 1
    rate.set(key, entry)
    if (entry.count > 60) throw Object.assign(new Error('请求过于频繁'), { statusCode: 429 })
  }

  const server = http.createServer(async (req, res) => {
    const requestId = Math.random().toString(36).slice(2, 10)
    try {
      const url = new URL(req.url, 'http://localhost')
      if (req.method === 'GET' && url.pathname === '/health') {
        send(res, 200, { ok: true, service: 'schedule-agent-runtime', model: config.aiModel, time: new Date().toISOString() })
        return
      }

      const auth = credentials(req)
      checkRateLimit(auth.deviceId || req.socket.remoteAddress || 'unknown')
      if (req.method === 'POST' && url.pathname === '/v1/session/bootstrap') {
        const body = await readBody(req)
        const result = runtime.bootstrap(body.deviceId, body.deviceSecret, body.initialState)
        send(res, 200, { ok: true, requestId, data: result })
        return
      }

      const userId = runtime.authenticate(auth.deviceId, auth.deviceSecret)
      if (req.method === 'GET' && url.pathname === '/v1/state') {
        send(res, 200, { ok: true, requestId, data: runtime.getState(userId) })
      } else if (req.method === 'PUT' && url.pathname === '/v1/state') {
        const body = await readBody(req)
        send(res, 200, { ok: true, requestId, data: runtime.syncState(userId, body.state, body.baseRevision) })
      } else if (req.method === 'POST' && url.pathname === '/v1/tasks/save') {
        const body = await readBody(req)
        send(res, 200, { ok: true, requestId, data: await runtime.saveTask(userId, body.task, body.language, body.timeContext) })
      } else if (req.method === 'POST' && url.pathname === '/v1/agent/plan') {
        const body = await readBody(req)
        send(res, 200, { ok: true, requestId, data: await runtime.createPlan(userId, body.text, body.language, body.timeContext) })
      } else if (req.method === 'POST' && url.pathname === '/v1/agent/replan') {
        const body = await readBody(req)
        send(res, 200, { ok: true, requestId, data: await runtime.replanDay(userId, body.dateKey, body.mode, body.language, body.timeContext, body.instruction) })
      } else if (req.method === 'POST' && url.pathname === '/v1/agent/confirm') {
        const body = await readBody(req)
        send(res, 200, { ok: true, requestId, data: runtime.confirmPlan(userId, body.planId, body.language) })
      } else if (req.method === 'POST' && url.pathname === '/v1/agent/discard') {
        const body = await readBody(req)
        send(res, 200, { ok: true, requestId, data: runtime.discardPlan(userId, body.planId) })
      } else if (req.method === 'GET' && url.pathname === '/v1/events') {
        send(res, 200, { ok: true, requestId, data: runtime.listEvents(userId, url.searchParams.get('after')) })
      } else {
        send(res, 404, { ok: false, requestId, error: '接口不存在' })
      }
    } catch (error) {
      const statusCode = Number(error.statusCode) || 500
      if (statusCode >= 500) console.error(`[${requestId}] request failed`, error)
      send(res, statusCode, { ok: false, requestId, error: error.message || '服务器错误' })
    }
  })

  return {
    config,
    database,
    runtime,
    server,
    start() {
      runtime.start()
      return new Promise((resolve) => server.listen(config.port, config.host, resolve))
    },
    async stop() {
      runtime.stop()
      await new Promise((resolve) => server.close(resolve))
      database.close()
    }
  }
}

if (require.main === module) {
  const app = createServer()
  app.start().then(() => console.log(`schedule agent runtime listening on ${app.config.host}:${app.config.port}`))
  const shutdown = () => app.stop().finally(() => process.exit(0))
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

module.exports = { createServer }
