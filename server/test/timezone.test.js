const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const time = require('../../utils/time')
const natural = require('../../utils/natural-language')
const scheduler = require('../../utils/scheduler')
const { withTimeContext, normalizeTimeContext } = require('../src/clock')
const { RuntimeDatabase } = require('../src/database')
const { AgentRuntime } = require('../src/runtime')

const incident = Date.parse('2026-10-10T03:51:47.871Z')
const china = { timeZone: 'Asia/Shanghai', timezoneOffsetMinutes: -480 }
const chicago = { timeZone: 'America/Chicago', timezoneOffsetMinutes: 300 }

function freeze(now) {
  const RealDate = global.Date
  global.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])) }
    static now() { return now }
  }
  return () => { global.Date = RealDate }
}

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-timezone-'))
  const database = new RuntimeDatabase(path.join(dir, 'test.sqlite'))
  const runtime = new AgentRuntime({ aiGatewayUrl: 'http://test', aiModel: 'test', reminderLeadMinutes: 15 }, database)
  return { database, runtime, close() { database.close(); fs.rmSync(dir, { recursive: true, force: true }) } }
}

test('the screenshot instant is October 9 in the student zone and October 10 in China', () => {
  withTimeContext(chicago, () => {
    assert.equal(time.dateKeyAt(incident), '2026-10-09')
    assert.equal(scheduler.currentMinute('2026-10-09', incident), 1372)
    assert.equal(natural.parseClock('8:15 PM physics reading'), '20:15')
    assert.equal(natural.parseClock('12 AM sleep'), '00:00')
  })
  withTimeContext(china, () => assert.equal(time.dateKeyAt(incident), '2026-10-10'))
  withTimeContext({ timezoneOffsetMinutes: 300 }, () => assert.equal(time.dateKeyAt(incident), '2026-10-09'))
  assert.equal(normalizeTimeContext({ timeZone: 'not-a-zone', timezoneOffsetMinutes: 300 }).timeZone, '')
})

test('concurrent users retain separate dates through asynchronous planning', async () => {
  const app = fixture()
  const restore = freeze(incident)
  const originalFetch = global.fetch
  const prompts = []
  global.fetch = async (url, options) => {
    const prompt = JSON.parse(options.body).messages[0].content
    prompts.push(prompt)
    await new Promise(resolve => setImmediate(resolve))
    return { ok: true, json: async () => ({ ok: true, data: { model: 'test', text: JSON.stringify({ reply: 'Ready.', actions: [{ type: 'create_task', title: 'Homework', dateKey: '2026-10-10', dueClock: '19:00', estimatedMinutes: 60 }] }) } }) }
  }
  try {
    app.runtime.bootstrap('timezone_student_us', 'u'.repeat(32), { timeContext: chicago })
    app.runtime.bootstrap('timezone_student_cn', 'c'.repeat(32), { timeContext: china })
    const [us, cn] = await Promise.all([
      app.runtime.createPlan('timezone_student_us', 'Today at 7 PM math homework for 1 hour.', 'en'),
      app.runtime.createPlan('timezone_student_cn', '今天晚上7点写作业一小时。', 'zh')
    ])
    assert.match(prompts[0], /当前日期：2026-10-09/)
    assert.match(prompts[1], /当前日期：2026-10-10/)
    assert.equal(us.draft.actions[0].dateKey, '2026-10-09', 'today cannot silently become the server date')
    assert.equal(cn.draft.actions[0].dateKey, '2026-10-10')
    assert.match(us.draft.reply, /2026-10-09/)
    assert.equal(app.runtime.confirmPlan('timezone_student_us', us.draft.id).state.tasks[0].dateKey, '2026-10-09')
    assert.equal(app.runtime.confirmPlan('timezone_student_cn', cn.draft.id).state.tasks[0].dateKey, '2026-10-10')
  } finally { global.fetch = originalFetch; restore(); app.close() }
})

test('tomorrow and server fallback use the user day rather than the host day', async () => {
  const app = fixture()
  const restore = freeze(incident)
  const originalFetch = global.fetch
  const originalError = console.error
  global.fetch = async () => { throw new Error('offline fixture') }
  console.error = () => {}
  try {
    app.runtime.bootstrap('timezone_fallback_us', 'u'.repeat(32), { timeContext: chicago })
    const result = await app.runtime.createPlan('timezone_fallback_us', 'Tomorrow at 7 PM math homework', 'en')
    assert.equal(result.draft.source, 'server_fallback')
    assert.equal(result.draft.actions[0].dateKey, '2026-10-10')
    assert.equal(result.draft.actions[0].dueClock, '19:00')
    const today = await app.runtime.createPlan('timezone_fallback_us', '今天晚上7点作业', 'zh')
    assert.equal(today.draft.actions[0].dateKey, '2026-10-09')
  } finally { global.fetch = originalFetch; console.error = originalError; restore(); app.close() }
})

test('reflow and completion statistics use local wall time and retain future work', () => {
  const now = Date.parse('2026-10-10T01:30:00Z') // Oct 9, 20:30 CDT
  withTimeContext(chicago, () => {
    const task = { id: 'future', title: 'Review', dateKey: '2026-10-09', status: 'planned', estimatedMinutes: 30, preferredSlot: 'evening', scheduledStartMinute: 1260, scheduledEndMinute: 1290 }
    const moved = scheduler.reflowRemainingTasks([task], { dateKey: task.dateKey, now, memory: { userPreferences: { defaultBreakMinutes: 0 } } })[0]
    assert.equal(moved.dateKey, '2026-10-09')
    assert.equal(moved.scheduledStartMinute, 1260, 'future local task must not shift into another day')
    const stats = scheduler.withCompletionStats({ slotStats: {} }, [task], [], now)
    assert.equal(stats.slotStats.evening, undefined, 'future local deadline is not a missed attempt')
  })
})

test('reminders tick each user in their own local date and clock', () => {
  const app = fixture()
  const restore = freeze(incident)
  try {
    const task = (dateKey, minute) => ({ id: 'remind', title: 'Review', dateKey, status: 'planned', scheduledStartMinute: minute, scheduledStart: time.formatMinuteOfDay(minute) })
    app.runtime.bootstrap('timezone_reminder_us', 'u'.repeat(32), { timeContext: chicago, tasks: [task('2026-10-09', 1380)] })
    app.runtime.bootstrap('timezone_reminder_cn', 'c'.repeat(32), { timeContext: china, tasks: [task('2026-10-10', 720)] })
    app.runtime.tick()
    assert.equal(app.runtime.listEvents('timezone_reminder_us', 0).length, 1)
    assert.equal(app.runtime.listEvents('timezone_reminder_cn', 0).length, 1)
    app.runtime.tick()
    assert.equal(app.runtime.listEvents('timezone_reminder_us', 0).length, 1, 'timezone-aware reminders still deduplicate')
  } finally { restore(); app.close() }
})

test('reopening from another zone updates context without deleting existing tasks', () => {
  const app = fixture()
  try {
    app.runtime.bootstrap('timezone_travel_device', 't'.repeat(32), { timeContext: china, tasks: [{ id: 'existing', title: 'Review', dateKey: '2026-10-11' }] })
    const reopened = app.runtime.bootstrap('timezone_travel_device', 't'.repeat(32), { timeContext: chicago, tasks: [] })
    assert.equal(reopened.state.tasks[0].id, 'existing')
    assert.equal(reopened.state.timeContext.timeZone, 'America/Chicago')
    const legacySync = app.runtime.syncState('timezone_travel_device', { tasks: reopened.state.tasks }, reopened.revision)
    assert.equal(legacySync.state.timeContext.timeZone, 'America/Chicago')
  } finally { app.close() }
})

test('IANA zones follow US daylight saving time while dates remain calendar days', () => {
  withTimeContext({ timeZone: 'America/New_York' }, () => {
    assert.equal(time.currentParts(Date.parse('2026-11-01T05:30:00Z')).hour, 1)
    assert.equal(time.currentParts(Date.parse('2026-11-01T06:30:00Z')).hour, 1)
    assert.equal(time.dateKeyAt(Date.parse('2026-11-01T06:30:00Z')), '2026-11-01')
    assert.equal(time.addDays('2026-11-01', 1), '2026-11-02')
  })
})
