const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const time = require('../../utils/time')
const { RuntimeDatabase } = require('../src/database')
const { AgentRuntime } = require('../src/runtime')

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-agent-'))
  const database = new RuntimeDatabase(path.join(dir, 'test.sqlite'))
  const runtime = new AgentRuntime({
    aiGatewayUrl: 'http://gateway.test/ai',
    aiModel: 'test-model',
    reminderLeadMinutes: 15,
    agentTickMs: 60000
  }, database)
  return { dir, database, runtime, close() { database.close(); fs.rmSync(dir, { recursive: true, force: true }) } }
}

test('bootstrap authenticates one isolated device and preserves state', () => {
  const app = fixture()
  try {
    const created = app.runtime.bootstrap('device_1234567890', 'a'.repeat(32), { tasks: [{ id: 't1', title: '数学' }] })
    assert.equal(created.created, true)
    assert.equal(created.state.tasks[0].title, '数学')
    const existing = app.runtime.bootstrap('device_1234567890', 'a'.repeat(32), {})
    assert.equal(existing.created, false)
    assert.equal(existing.state.tasks.length, 1)
    assert.throws(() => app.runtime.authenticate('device_1234567890', 'b'.repeat(32)), /认证失败/)
  } finally {
    app.close()
  }
})

test('plan is persisted, requires confirmation, then executes tools in one transaction', async () => {
  const app = fixture()
  const originalFetch = global.fetch
  global.fetch = async (url, request) => {
    const prompt = JSON.parse(request.body).messages[0].content
    if (prompt.includes('Flexible tasks: ')) {
      const tasks = JSON.parse(prompt.split('Flexible tasks: ')[1].split('\n')[0])
      return { ok: true, json: async () => ({ ok: true, data: { model: 'test-model', text: JSON.stringify({ summary: { zh: '安排晚间复习。', en: 'Review in the evening.' }, placements: tasks.map(task => ({ taskId: task.id, start: '21:00', reason: { zh: '按记忆安排。', en: 'Use the preference.' } })), deferred: [] }) } }) }
    }
    return ({
    ok: true,
    async json() {
      return {
        ok: true,
        data: {
          model: 'test-model',
          text: JSON.stringify({
            reply: '已整理数学复习计划。',
            actions: [{ type: 'create_task', title: '复习数学', dateKey: time.addDays(time.todayKey(), 1), estimatedMinutes: 60, preferredSlot: 'evening' }],
            memoryUpdates: [{ kind: 'time_preference', key: '数学时段', value: '晚上', confidence: 0.9 }]
          })
        }
      }
    }
    })
  }
  try {
    app.runtime.bootstrap('device_abcdefghij', 'c'.repeat(32), {})
    const planned = await app.runtime.createPlan('device_abcdefghij', '明天晚上复习数学一小时')
    assert.equal(planned.state.tasks.length, 0)
    assert.equal(planned.draft.actions.filter(action => action.type === 'create_task').length, 1)
    const confirmed = app.runtime.confirmPlan('device_abcdefghij', planned.draft.id)
    assert.equal(confirmed.state.tasks.length, 1)
    assert.equal(confirmed.state.tasks[0].title, '复习数学')
    assert.equal(confirmed.state.memory.secretaryFacts[0].key, '数学时段')
    assert.equal(app.database.getPlan('device_abcdefghij', planned.draft.id).status, 'confirmed')
  } finally {
    global.fetch = originalFetch
    app.close()
  }
})

test('optimistic revision prevents stale client state from overwriting newer state', () => {
  const app = fixture()
  try {
    const created = app.runtime.bootstrap('device_revision12', 'd'.repeat(32), {})
    const saved = app.runtime.syncState('device_revision12', { ...created.state, planMode: 'relaxed' }, created.revision)
    assert.equal(saved.state.planMode, 'relaxed')
    assert.throws(() => app.runtime.syncState('device_revision12', created.state, created.revision), /其他请求中更新/)
  } finally {
    app.close()
  }
})

test('repairs an AI plan that promises a timed task but returns zero actions', async () => {
  const app = fixture()
  const originalFetch = global.fetch
  global.fetch = async () => ({
    ok: true,
    async json() {
      return {
        ok: true,
        data: {
          model: 'test-model',
          text: JSON.stringify({
            reply: '已整理：明天 03:00 看世界杯决赛。',
            needConfirmation: true,
            actions: [],
            memoryUpdates: []
          })
        }
      }
    }
  })
  try {
    app.runtime.bootstrap('device_repair12345', 'e'.repeat(32), {})
    const planned = await app.runtime.createPlan('device_repair12345', '明天凌晨三点看世界杯决赛')
    assert.equal(planned.draft.actions.filter(action => action.type === 'create_task').length, 1)
    assert.equal(planned.draft.actions[0].title, '看世界杯决赛')
    assert.equal(planned.draft.actions[0].dueClock, '03:00')
    assert.equal(planned.draft.actions[0].dateKey, time.addDays(time.todayKey(), 1))
    assert.equal(planned.state.draft.id, planned.draft.id)
  } finally {
    global.fetch = originalFetch
    app.close()
  }
})

test('does not show an approval draft when the AI returns no executable operation', async () => {
  const app = fixture()
  const originalFetch = global.fetch
  global.fetch = async () => ({
    ok: true,
    async json() {
      return {
        ok: true,
        data: {
          model: 'test-model',
          text: JSON.stringify({
            reply: '今天下午暂时没有已安排任务。',
            needConfirmation: false,
            actions: []
          })
        }
      }
    }
  })
  try {
    app.runtime.bootstrap('device_noop123456', 'f'.repeat(32), {})
    const planned = await app.runtime.createPlan('device_noop123456', '我什么时候有空')
    assert.equal(planned.draft.actions.length, 0)
    assert.equal(planned.state.draft, null)
  } finally {
    global.fetch = originalFetch
    app.close()
  }
})

test('cancels a pending plan from conversation without executing it', async () => {
  const app = fixture()
  const originalFetch = global.fetch
  global.fetch = async () => ({
    ok: true,
    async json() {
      return {
        ok: true,
        data: {
          model: 'test-model',
          text: JSON.stringify({
            reply: '明天三点安排开会。',
            needConfirmation: true,
            actions: [{ type: 'create_task', title: '开会', dateKey: time.addDays(time.todayKey(), 1), dueClock: '15:00' }]
          })
        }
      }
    }
  })
  try {
    app.runtime.bootstrap('device_cancel12345', 'g'.repeat(32), {})
    const first = await app.runtime.createPlan('device_cancel12345', '明天三点开会')
    const cancelled = await app.runtime.createPlan('device_cancel12345', '算了')
    assert.equal(cancelled.state.draft, null)
    assert.equal(cancelled.state.tasks.length, 0)
    assert.equal(app.database.getPlan('device_cancel12345', first.draft.id).status, 'discarded')
  } finally {
    global.fetch = originalFetch
    app.close()
  }
})

test('repairs a time-only correction against the pending plan', async () => {
  const app = fixture()
  const originalFetch = global.fetch
  let callCount = 0
  global.fetch = async () => {
    callCount += 1
    return {
      ok: true,
      async json() {
        return {
          ok: true,
          data: {
            model: 'test-model',
            text: callCount === 1
              ? JSON.stringify({
                reply: '明天三点安排开会。',
                needConfirmation: true,
                actions: [{ type: 'create_task', title: '开会', dateKey: time.addDays(time.todayKey(), 1), dueClock: '15:00' }]
              })
              : JSON.stringify({ reply: '已改成四点。', needConfirmation: true, actions: [] })
          }
        }
      }
    }
  }
  try {
    app.runtime.bootstrap('device_correct1234', 'h'.repeat(32), {})
    const first = await app.runtime.createPlan('device_correct1234', '明天三点开会')
    const corrected = await app.runtime.createPlan('device_correct1234', '改成下午四点')
    assert.equal(corrected.draft.actions.filter(action => action.type === 'create_task').length, 1)
    assert.equal(corrected.draft.actions[0].title, '开会')
    assert.equal(corrected.draft.actions[0].dueClock, '16:00')
    assert.equal(app.database.getPlan('device_correct1234', first.draft.id).status, 'discarded')
  } finally {
    global.fetch = originalFetch
    app.close()
  }
})
