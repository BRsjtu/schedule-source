const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { RuntimeDatabase } = require('../src/database')
const { AgentRuntime } = require('../src/runtime')
const { fallbackDraft, repairPendingDraft } = require('../src/agent')
const i18n = require('../../utils/i18n')
const copy = require('../../utils/system-copy')
const time = require('../../utils/time')

test('English fallback and pending corrections use the request language', () => {
  const state = { language: 'en', planMode: 'flexible', tasks: [] }
  for (const input of ['Tomorrow at 2 PM chemistry class', 'Reschedule my tasks']) {
    const result = fallbackDraft(input, state, 'en')
    assert.doesNotMatch(result.reply, /[\u3400-\u9fff]/)
    assert.equal(result.language, 'en')
  }
  assert.equal(fallbackDraft('Reschedule my tasks', state, 'en').actions[0].type, 'reschedule_tasks')
  const draft = repairPendingDraft('Tomorrow at 3 PM', { ...state, draft: { actions: [{ type: 'create_task', title: 'Chemistry class' }] } }, 'en')
  assert.match(draft.reply, /15:00/)
  assert.doesNotMatch(draft.reply, /[\u3400-\u9fff]/)
})

test('language stays per user through planning, confirmation, cancellation and reminders', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-locale-'))
  const database = new RuntimeDatabase(path.join(dir, 'test.sqlite'))
  const runtime = new AgentRuntime({ aiGatewayUrl: 'http://test', aiModel: 'test', reminderLeadMinutes: 15 }, database)
  const originalFetch = global.fetch
  global.fetch = async (url, request) => {
    await new Promise(resolve => setImmediate(resolve))
    const prompt = JSON.parse(request.body).messages[0].content
    if (prompt.includes('Flexible tasks: ')) {
      const tasks = JSON.parse(prompt.split('Flexible tasks: ')[1].split('\n')[0])
      return { ok: true, json: async () => ({ ok: true, data: { model: 'test', text: JSON.stringify({ summary: { zh: '已安排课程。', en: 'Class schedule ready.' }, placements: tasks.map((task, index) => ({ taskId: task.id, start: `${String(9 + index).padStart(2, '0')}:00`, reason: { zh: '采用偏好。', en: 'Using the preference.' } })), deferred: [] }) } }) }
    }
    return { ok: true, json: async () => ({ ok: true, data: { model: 'test', text: JSON.stringify({ actions: [{ type: 'create_task', title: 'Chemistry class', dateKey: '2099-01-01', estimatedMinutes: 30 }], memoryUpdates: [{ kind: 'scheduling', key: 'focusWorkPreferredSlot', value: 'morning' }] }) } }) }
  }
  try {
    runtime.bootstrap('locale_english_device', 'e'.repeat(32), { language: 'en' })
    runtime.bootstrap('locale_chinese_device', 'c'.repeat(32), { language: 'zh' })
    i18n.setLang('zh')
    const [en, zh] = await Promise.all([runtime.createPlan('locale_english_device', 'Create Chemistry class', 'en'), runtime.createPlan('locale_chinese_device', '创建 Chemistry class', 'zh')])
    assert.doesNotMatch(en.draft.reply, /[\u3400-\u9fff]/)
    assert.match(zh.draft.reply, /[\u3400-\u9fff]/)
    assert.equal(en.state.language, 'en')
    const doneEn = runtime.confirmPlan('locale_english_device', en.draft.id)
    const doneZh = runtime.confirmPlan('locale_chinese_device', zh.draft.id)
    const message = doneEn.state.messages.at(-1)
    assert.match(message.content, /Created “Chemistry class”/)
    assert.doesNotMatch(message.content, /[\u3400-\u9fff]/)
    assert.match(doneZh.state.messages.at(-1).content, /创建/)
    assert.equal(message.system.type, 'execution')
    assert.match(copy.messageContent(message, 'zh'), /创建“Chemistry class”/)
    assert.equal(doneEn.state.memory.secretaryFacts[0].value, 'morning')
    const switched = await runtime.createPlan('locale_english_device', 'Create another class', 'en')
    assert.match(runtime.confirmPlan('locale_english_device', switched.draft.id, 'zh').state.messages.at(-1).content, /创建/)
    await runtime.createPlan('locale_english_device', 'Create a class', 'en')
    const canceled = await runtime.createPlan('locale_english_device', 'Cancel', 'en')
    assert.match(canceled.draft.reply, /Canceled/)
    assert.equal(canceled.state.draft, null)
    const current = runtime.getState('locale_english_device')
    const parts = time.currentParts(), minute = parts.hour * 60 + parts.minute
    runtime.syncState('locale_english_device', { ...current.state, language: 'en', tasks: [{ id: 'reminder1', title: 'Review', status: 'planned', dateKey: time.todayKey(), scheduledStartMinute: minute, scheduledStart: time.formatMinuteOfDay(minute) }] }, current.revision)
    runtime.tick()
    const reminder = runtime.getState('locale_english_device').state.messages.at(-1)
    assert.match(reminder.content, /starts at/)
    assert.equal(reminder.system.type, 'reminder')
    assert.match(copy.messageContent(reminder, 'zh'), /将在/)
  } finally {
    global.fetch = originalFetch; i18n.setLang('zh')
    database.close(); fs.rmSync(dir, { recursive: true, force: true })
  }
})
