const assert = require('node:assert/strict')
const test = require('node:test')
const { hasUnresolvedRelativeAnchor, isReadOnlyQuery, normalizeDraft, plan } = require('../src/agent')
const { normalizeState } = require('../src/state')

test('normalizes nested model tool syntax into an executable action', () => {
  const draft = normalizeDraft({
    needConfirmation: true,
    actions: [{ create_task: { title: '科创任务', dateKey: '2026-07-20', preferredSlot: '11:00' } }]
  }, '明天十一点安排科创任务', 'test-model')
  assert.equal(draft.actions.length, 1)
  assert.equal(draft.actions[0].type, 'create_task')
  assert.equal(draft.actions[0].dueClock, '11:00')
  assert.equal(draft.actions[0].preferredSlot, 'morning')
})

test('explicit user time overrides a contradictory model time', () => {
  const draft = normalizeDraft({
    needConfirmation: true,
    actions: [{ type: 'create_task', title: '写作文', dueClock: '11:00' }]
  }, '明天上午十点写作文', 'test-model')
  assert.equal(draft.actions[0].dueClock, '10:00')
})

test('an ambiguous unqualified hour keeps the model contextual interpretation', () => {
  const draft = normalizeDraft({
    needConfirmation: true,
    actions: [{ type: 'create_task', title: '开会', dueClock: '15:00' }]
  }, '明天三点开会', 'test-model')
  assert.equal(draft.actions[0].dueClock, '15:00')
})

test('task numbers cannot leak into the minute part of an explicit clock', () => {
  const draft = normalizeDraft({
    needConfirmation: true,
    actions: [{ type: 'create_task', title: '科创任务', estimatedMinutes: 25, dueClock: '08:25' }]
  }, '明天8点安排科创任务25', 'test-model')
  assert.equal(draft.actions[0].dueClock, '08:00')
  assert.equal(draft.actions[0].estimatedMinutes, 25)
})

test('an unqualified clock keeps its exact hour and minute within the model chosen half-day', () => {
  const draft = normalizeDraft({
    needConfirmation: true,
    actions: [{ type: 'create_task', title: '写周报', dueClock: '11:30' }]
  }, '今天十点半写周报', 'test-model')
  assert.equal(draft.actions[0].dueClock, '10:30')
})

test('prompt follows the selected mini program language', () => {
  const state = normalizeState({})
  assert.match(require('../src/agent').buildPrompt('Schedule a meeting tomorrow', state, 'en'), /回复语言：English/)
  assert.match(require('../src/agent').buildPrompt('明天安排会议', state, 'zh'), /回复语言：Simplified Chinese/)
})

test('batch actions use the explicit clocks from each user clause in order', () => {
  const draft = normalizeDraft({
    needConfirmation: true,
    actions: [
      { type: 'create_task', title: '早餐', dueClock: '08:30' },
      { type: 'create_task', title: '复习', dueClock: '11:00' },
      { type: 'create_task', title: '交作业', dueClock: '11:00' },
      { type: 'create_task', title: '答辩', dueClock: '14:00' }
    ]
  }, '后天依次安排：八点早餐、九点复习、十一点交作业、下午两点答辩', 'test-model')
  assert.deepEqual(draft.actions.map((item) => item.dueClock), ['08:00', '09:00', '11:00', '14:00'])
})

test('read-only schedule questions can never become mutation actions', () => {
  const inputs = ['明天看一下我什么时间有空', '我明天有什么安排？', '后天什么时候有空？']
  inputs.forEach((input) => {
    assert.equal(isReadOnlyQuery(input), true, input)
    const draft = normalizeDraft({
      needConfirmation: true,
      actions: [{ type: 'create_task', title: input }]
    }, input, 'test-model')
    assert.equal(draft.actions.length, 0, input)
    assert.equal(draft.needConfirmation, false, input)
  })
})

test('a command that asks the agent to find a free slot remains actionable', () => {
  const input = '明天找个空闲时间安排团队业务规划会议'
  assert.equal(isReadOnlyQuery(input), false)
})

test('relative plans require a known anchor date instead of inventing one', () => {
  const input = '北京车展媒体日前两天到北京，媒体日结束后回深圳'
  assert.equal(hasUnresolvedRelativeAnchor(input, { tasks: [] }), true)
  assert.equal(hasUnresolvedRelativeAnchor(input, {
    tasks: [{ id: 'expo', title: '北京车展媒体日', dateKey: '2027-04-22' }]
  }), false)
})

test('fallback shifts multiple meetings when the duration uses Chinese numerals', async () => {
  const originalFetch = global.fetch
  global.fetch = async () => ({
    ok: true,
    async json() {
      return { ok: true, data: { model: 'test-model', text: JSON.stringify({ reply: '三个会议顺延一小时。', needConfirmation: true, actions: [] }) } }
    }
  })
  const tomorrow = require('../../utils/time').addDays(require('../../utils/time').todayKey(), 1)
  const tasks = ['09:00', '11:00', '15:00'].map((clock, index) => ({
    id: `m${index + 1}`,
    title: ['产品会议', '项目会议', '团队会议'][index],
    status: 'planned',
    dateKey: tomorrow,
    dueClock: clock,
    scheduledStart: clock
  }))
  try {
    const draft = await plan({ aiGatewayUrl: 'http://test', aiModel: 'test-model' }, '把明天的三个会议都推迟一小时', normalizeState({ tasks }))
    assert.deepEqual(draft.actions.map((item) => item.dueClock), ['10:00', '12:00', '16:00'])
  } finally {
    global.fetch = originalFetch
  }
})

test('repairs a completion-only reply without inventing a new task or actual duration', async () => {
  const originalFetch = global.fetch
  const state = normalizeState({ tasks: [{ id: 'timed', title: '测试报告', status: 'paused', estimatedMinutes: 60, elapsedSeconds: 2405 }] })
  global.fetch = async () => ({ ok: true, json: async () => ({ ok: true, data: { model: 'test-model', text: JSON.stringify({ reply: '请提供实际用时。', actions: [] }) } }) })
  try {
    const draft = await plan({ aiGatewayUrl: 'http://test', aiModel: 'test-model' }, '测试报告已经完成了，请标记完成，实际用时以计时器记录为准。', state, 'zh')
    assert.equal(draft.actions.length, 1)
    assert.equal(draft.actions[0].type, 'complete_task')
    assert.equal(draft.actions[0].taskId, 'timed')
    assert.equal(Number(draft.actions[0].actualMinutes || 0), 0)
    assert.doesNotMatch(draft.reply, /请提供实际用时/)
    global.fetch = async () => ({ ok: true, json: async () => ({ ok: true, data: { model: 'test-model', text: JSON.stringify({ reply: '已准备。', actions: [{ type: 'complete_task', taskId: 'timed', actualMinutes: 60 }] }) } }) })
    const inferred = await plan({ aiGatewayUrl: 'http://test', aiModel: 'test-model' }, '标记测试报告完成', state, 'zh')
    assert.equal(inferred.actions[0].actualMinutes, undefined, 'model cannot replace tracked time with an inferred duration')
  } finally { global.fetch = originalFetch }
})
