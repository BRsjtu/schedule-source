const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { RuntimeDatabase } = require('../src/database')
const { AgentRuntime } = require('../src/runtime')
const { normalizeState } = require('../src/state')
const llm = require('../../utils/llm-schedule')
const presentation = require('../../utils/replan-presentation')
const i18n = require('../../utils/i18n')
const { buildPrompt } = require('../src/smart-replan')
const dateKey = '2030-06-04'
const words = { zh: '先完成会议材料，让邮件占用低精力时段。', en: 'Prepare meeting material first and use a low-energy slot for email.' }
const task = (id, start, extra = {}) => ({ id, title: id, dateKey, preferredSlot: 'any', priority: 'medium', status: 'planned', estimatedMinutes: 30,
  scheduledStartMinute: start, scheduledEndMinute: start + 30, scheduledStart: `${Math.floor(start / 60)}:00`, ...extra })
function state() { return normalizeState({ tasks: [task('prepare', 960), task('email', 540), task('fixed', 840, { dueClock: '14:00' })] }) }
function proposal(a = '09:45', b = '11:00') { return { summary: words, placements: [{ taskId: 'prepare', start: a, reason: words }, { taskId: 'email', start: b, reason: words }], deferred: [] } }
function response(value) { return { ok: true, json: async () => ({ ok: true, data: { model: 'test-llm', text: JSON.stringify(value) } }) } }
function fixture(initial = state()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-replan-')), database = new RuntimeDatabase(path.join(dir, 'test.sqlite'))
  const runtime = new AgentRuntime({ aiModel: 'test-llm', aiGatewayUrl: 'http://test' }, database)
  runtime.bootstrap('smart_device_123456', 's'.repeat(32), initial)
  return { runtime, database, close() { database.close(); fs.rmSync(dir, { recursive: true, force: true }) } }
}

test('model start times are applied exactly, fixed times stay fixed and repeated clicks call the model again', async () => {
  const app = fixture(), original = global.fetch
  let calls = 0
  global.fetch = async () => response(++calls === 1 ? proposal() : proposal('10:15', '11:30'))
  try {
    const first = await app.runtime.replanDay('smart_device_123456', dateKey, 'flexible', 'en')
    assert.equal(first.state.tasks[0].scheduledStartMinute, 585, 'not the old rule time at 09:00')
    assert.equal(first.state.tasks[2].scheduledStartMinute, 840)
    assert.equal(first.state.tasks[0].dueClock, undefined, 'a model time does not make the task fixed')
    assert.equal(first.state.scheduleReport.engine, 'llm')
    const second = await app.runtime.replanDay('smart_device_123456', dateKey, 'flexible', 'en')
    assert.equal(calls, 2)
    assert.equal(second.state.tasks[0].scheduledStartMinute, 615)
    assert.equal(app.runtime.getState('smart_device_123456').state.scheduleReport.model, 'test-llm')
    i18n.setLang('en'); assert.equal(presentation.report(second.state.scheduleReport, dateKey).body, words.en)
    i18n.setLang('zh'); assert.equal(presentation.report(second.state.scheduleReport, dateKey).body, words.zh)
  } finally { global.fetch = original; i18n.setLang('zh'); app.close() }
})

test('hard constraints reject collisions, fixed changes, missing tasks and invalid clocks', () => {
  const tasks = state().tasks, opts = { dateKey, mode: 'flexible', memory: state().memory }
  assert.throws(() => llm.apply(tasks, proposal('13:50'), opts), /overlap/)
  assert.throws(() => llm.apply(tasks, proposal('09:45', '10:20'), opts), /insufficient break/)
  assert.throws(() => llm.apply(tasks, { ...proposal(), placements: [{ taskId: 'fixed', start: '15:00', reason: words }] }, opts), /fixed/)
  assert.throws(() => llm.apply(tasks, { ...proposal(), placements: [] }, opts), /every flexible/)
  assert.throws(() => llm.apply(tasks, proposal('09:99'), opts), /HH:MM/)
  const running = tasks.map(item => item.id === 'prepare' ? { ...item, status: 'running' } : item)
  assert.throws(() => llm.apply(running, proposal(), opts), /fixed/)
})

test('suggestion mode never changes tasks; relaxed mode uses the model selected tasks and preserves others', () => {
  const initial = state()
  assert.deepEqual(llm.apply(initial.tasks, proposal(), { dateKey, memory: initial.memory, mode: 'suggestion' }).tasks, initial.tasks)
  const plan = { summary: words, placements: proposal().placements.slice(1), deferred: [{ taskId: 'prepare', reason: words }] }
  const relaxed = llm.apply(initial.tasks, plan, { dateKey, memory: initial.memory, mode: 'relaxed' })
  assert.deepEqual(relaxed.tasks[0], initial.tasks[0])
  assert.equal(relaxed.report.deferred[0].id, 'prepare')
  assert.ok(relaxed.report.entries.some(item => item.id === 'email'))
})

test('invalid model times receive one model repair instead of rule substitution', async () => {
  const app = fixture(), original = global.fetch
  let calls = 0
  global.fetch = async () => response(++calls === 1 ? proposal('13:50') : proposal())
  try {
    const result = await app.runtime.replanDay('smart_device_123456', dateKey, 'flexible', 'zh')
    assert.equal(calls, 2); assert.equal(result.state.tasks[0].scheduledStartMinute, 585)
  } finally { global.fetch = original; app.close() }
})

test('model outage and invalid plans leave the saved schedule untouched', async () => {
  const app = fixture(), original = global.fetch
  const before = app.runtime.getState('smart_device_123456')
  try {
    global.fetch = async () => { throw new Error('offline fixture') }
    await assert.rejects(app.runtime.replanDay('smart_device_123456', dateKey, 'flexible', 'zh'), /offline/)
    assert.deepEqual(app.runtime.getState('smart_device_123456'), before)
    global.fetch = async () => response(proposal('13:50'))
    await assert.rejects(app.runtime.replanDay('smart_device_123456', dateKey, 'flexible', 'zh'), /failed validation/)
    assert.deepEqual(app.runtime.getState('smart_device_123456'), before)
  } finally { global.fetch = original; app.close() }
})

test('edits during a model call prevent an old plan from overwriting current tasks', async () => {
  const app = fixture(), original = global.fetch
  global.fetch = async () => {
    const current = app.runtime.getState('smart_device_123456')
    app.runtime.syncState('smart_device_123456', { ...current.state, tasks: current.state.tasks.map(item => item.id === 'prepare' ? { ...item, title: 'Edited while planning' } : item) }, current.revision)
    return response(proposal())
  }
  try {
    await assert.rejects(app.runtime.replanDay('smart_device_123456', dateKey, 'flexible', 'zh'), /日程已有变化/)
    assert.equal(app.runtime.getState('smart_device_123456').state.tasks[0].title, 'Edited while planning')
    assert.equal(app.runtime.getState('smart_device_123456').state.tasks[0].scheduledStartMinute, 960)
  } finally { global.fetch = original; app.close() }
})

test('a reminder during model planning does not block replanning or discard the reminder', async () => {
  const app = fixture(), original = global.fetch
  global.fetch = async () => {
    const current = app.runtime.getState('smart_device_123456')
    app.runtime.syncState('smart_device_123456', { ...current.state, messages: [{ id: 'reminder', role: 'assistant', content: 'Meeting soon', createdAt: Date.now() }] }, current.revision)
    return response(proposal())
  }
  try {
    const saved = await app.runtime.replanDay('smart_device_123456', dateKey, 'flexible', 'zh')
    assert.equal(saved.state.tasks.find(task => task.id === 'prepare').scheduledStartMinute, 585)
    assert.equal(saved.state.messages[0].id, 'reminder')
  } finally { global.fetch = original; app.close() }
})

test('chat confirmation applies the same model proposal after preference changes and stable task creation', async () => {
  const app = fixture(), original = global.fetch
  let calls = 0
  global.fetch = async (url, request) => {
    if (++calls === 1) return response({ reply: 'Review this plan.', actions: [{ type: 'create_task', title: 'New prep', dateKey, estimatedMinutes: 20 }, { type: 'reschedule_tasks', dateKey }], memoryUpdates: [{ key: 'defaultBreakMinutes', value: 20 }] })
    const prompt = JSON.parse(request.body).messages[0].content
    const tasks = JSON.parse(prompt.split('Flexible tasks: ')[1].split('\n')[0])
    assert.match(prompt, /minimum break on BOTH sides of every task: 20/)
    const created = tasks.find(item => item.title === 'New prep')
    return response({ ...proposal(), placements: proposal().placements.concat({ taskId: created.id, start: '12:00', reason: words }) })
  }
  try {
    const draft = await app.runtime.createPlan('smart_device_123456', 'Create New prep, set a 20 minute break and replan June 4, 2030.', 'en')
    assert.equal(app.runtime.getState('smart_device_123456').state.tasks.length, 3)
    assert.ok(draft.draft.actions[1].llmPlan)
    assert.ok(draft.draft.actions[1].llmPreview)
    const confirmed = app.runtime.confirmPlan('smart_device_123456', draft.draft.id)
    assert.equal(calls, 2, 'confirmation applies the reviewed proposal without another model call')
    assert.equal(confirmed.state.memory.userPreferences.defaultBreakMinutes, 20)
    assert.equal(confirmed.state.tasks.find(item => item.title === 'New prep').scheduledStartMinute, 720)
    assert.equal(confirmed.state.tasks.find(item => item.id === 'prepare').scheduledStartMinute, 585)
    assert.equal(confirmed.state.scheduleReport.engine, 'llm')
  } finally { global.fetch = original; app.close() }
})

test('prompt passes local context, semantic task descriptions, memory, history and prior plan', () => {
  const initial = state(); initial.tasks[0].description = 'Prepare before the meeting; focus work'; initial.scheduleReport = { dateKey, summary: words }
  const prompt = buildPrompt(initial, { dateKey, mode: 'flexible', memory: initial.memory, instruction: 'Exercise after dinner' })
  assert.match(prompt, /Prepare before the meeting/); assert.match(prompt, /Exercise after dinner/)
  assert.match(prompt, /Previous plan:/); assert.match(prompt, /Memory:/); assert.match(prompt, /Recent completion history:/)
  assert.match(prompt, /target date is IN THE FUTURE/)
  assert.match(prompt, /ACTUAL CURRENT LOCAL DATE:/)
})

test('manual creation and editing use model times and a failed save keeps the original state', async () => {
  const app = fixture(), original = global.fetch
  let calls = 0
  global.fetch = async (url, request) => {
    const prompt = JSON.parse(request.body).messages[0].content
    const tasks = JSON.parse(prompt.split('Flexible tasks: ')[1].split('\n')[0])
    const added = tasks.find(item => item.title === 'Swim')
    return response({ ...proposal(), placements: proposal().placements.concat({ taskId: added.id, start: ++calls === 1 ? '19:10' : '20:10', reason: words }) })
  }
  try {
    const saved = await app.runtime.saveTask('smart_device_123456', { title: 'Swim', dateKey, estimatedMinutes: 60, dueClock: '' }, 'zh')
    const added = saved.state.tasks.find(item => item.title === 'Swim')
    assert.equal(added.scheduledStartMinute, 1150)
    assert.equal(added.dueClock, '')
    assert.equal(saved.state.scheduleReport.engine, 'llm')
    const edited = await app.runtime.saveTask('smart_device_123456', { ...added, taskId: added.id, description: 'After dinner' }, 'zh')
    assert.equal(edited.state.tasks.find(item => item.id === added.id).scheduledStartMinute, 1210)
    assert.equal(calls, 2)
    global.fetch = async () => { throw new Error('offline fixture') }
    await assert.rejects(app.runtime.saveTask('smart_device_123456', { ...added, taskId: added.id, title: 'Unsaved edit' }, 'zh'), /offline/)
    assert.deepEqual(app.runtime.getState('smart_device_123456'), edited)
  } finally { global.fetch = original; app.close() }
})

test('chat creation automatically prepares the same smart schedule without a replan command', async () => {
  const app = fixture(normalizeState({})), original = global.fetch
  let calls = 0
  global.fetch = async (url, request) => {
    if (++calls === 1) return response({ reply: '请确认游泳任务。', actions: [{ type: 'create_task', title: '游泳', dateKey, estimatedMinutes: 60, dueClock: '16:00' }], memoryUpdates: [] })
    const prompt = JSON.parse(request.body).messages[0].content
    const tasks = JSON.parse(prompt.split('Flexible tasks: ')[1].split('\n')[0])
    return response({ summary: words, placements: [{ taskId: tasks[0].id, start: '19:10', reason: words }], deferred: [] })
  }
  try {
    const planned = await app.runtime.createPlan('smart_device_123456', '2030-06-04添加游泳一小时，时间可调整', 'zh')
    assert.ok(planned.draft.actions.find(item => item.type === 'reschedule_tasks').automatic)
    assert.equal(planned.state.tasks.length, 0)
    const saved = app.runtime.confirmPlan('smart_device_123456', planned.draft.id)
    assert.equal(saved.state.tasks[0].scheduledStartMinute, 1150)
    assert.equal(saved.state.tasks[0].dueClock, '', 'an inferred model time must never lock a flexible task')
    assert.equal(saved.state.scheduleReport.engine, 'llm')
    assert.equal(calls, 2)
  } finally { global.fetch = original; app.close() }
})

test('memory-only chat updates preferences after confirmation without moving tasks or accumulating opposite habits', async () => {
  const initial = state()
  initial.memory.secretaryFacts = [{ id: 'habit', kind: 'preference', key: 'exerciseMealOrder', value: '运动放饭前' }]
  const app = fixture(initial), original = global.fetch
  let calls = 0
  global.fetch = async () => { calls++; return response({ reply: '确认后记住运动放饭后，休息20分钟。', actions: [], memoryUpdates: [{ kind: 'planning_rule', key: 'exerciseMealOrder', value: '运动放晚饭后' }, { key: '任务间隔', value: '20' }] }) }
  try {
    const planned = await app.runtime.createPlan('smart_device_123456', '把偏好改为运动放晚饭后，休息改为20分钟，仅修改记忆', 'zh')
    assert.equal(planned.draft.actions.length, 0)
    assert.equal(planned.state.memory.userPreferences.defaultBreakMinutes, 10)
    const saved = app.runtime.confirmPlan('smart_device_123456', planned.draft.id)
    assert.deepEqual(saved.state.tasks, initial.tasks)
    assert.equal(saved.state.memory.userPreferences.defaultBreakMinutes, 20)
    const habits = saved.state.memory.secretaryFacts.filter(item => item.key === 'exerciseMealOrder')
    assert.equal(habits.length, 1)
    assert.equal(habits[0].id, 'habit')
    assert.equal(habits[0].value, '运动放晚饭后')
    assert.equal(calls, 1)
  } finally { global.fetch = original; app.close() }
})

test('editing basic break settings updates the stored memory fact and replans existing tasks with the latest interval', async () => {
  const initial = state()
  initial.memory.secretaryFacts = [{ id: 'break', key: 'defaultBreakMinutes', value: 10, evidence: '以前设为10分钟' }]
  const app = fixture(initial), original = global.fetch
  global.fetch = async (url, request) => {
    const prompt = JSON.parse(request.body).messages[0].content
    assert.match(prompt, /minimum break on BOTH sides of every task: 20/)
    return response(proposal('09:45', '10:35'))
  }
  try {
    const current = app.runtime.getState('smart_device_123456')
    const memory = { ...current.state.memory, userPreferences: { ...current.state.memory.userPreferences, defaultBreakMinutes: 20 } }
    app.runtime.syncState('smart_device_123456', { ...current.state, memory }, current.revision)
    const saved = await app.runtime.replanDay('smart_device_123456', dateKey, 'flexible', 'zh')
    assert.equal(saved.state.memory.secretaryFacts[0].value, 20)
    assert.equal(saved.state.tasks.find(item => item.id === 'email').scheduledStartMinute - saved.state.tasks.find(item => item.id === 'prepare').scheduledEndMinute, 20)
    assert.equal(saved.state.scheduleReport.breakMinutes, 20)
  } finally { global.fetch = original; app.close() }
})
