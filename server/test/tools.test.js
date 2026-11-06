const assert = require('node:assert/strict')
const test = require('node:test')
const time = require('../../utils/time')
const { normalizeState } = require('../src/state')
const { executePlan } = require('../src/tools')

function task(id, title, overrides = {}) {
  return {
    id,
    title,
    description: '',
    priority: 'medium',
    estimatedMinutes: 45,
    actualMinutes: 0,
    status: 'todo',
    dateKey: time.todayKey(),
    preferredSlot: 'any',
    dueClock: '',
    scheduledStart: '',
    scheduledEnd: '',
    scheduledStartMinute: null,
    scheduledEndMinute: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides
  }
}

test('executes a multi-action plan and schedules fixed times atomically', () => {
  const tomorrow = time.addDays(time.todayKey(), 1)
  const result = executePlan(normalizeState({}), {
    actions: [
      { type: 'create_task', title: '早餐', dateKey: tomorrow, dueClock: '08:00', estimatedMinutes: 30 },
      { type: 'create_task', title: '团队会议', dateKey: tomorrow, dueClock: '10:00', estimatedMinutes: 60 },
      { type: 'create_task', title: '看世界杯决赛', dateKey: tomorrow, dueClock: '03:00', estimatedMinutes: 120 }
    ]
  })
  assert.equal(result.state.tasks.length, 3)
  assert.deepEqual(result.state.tasks.map((item) => item.scheduledStart).sort(), ['03:00', '08:00', '10:00'])
  assert.equal(result.changes.length, 3)
  assert.equal(result.state.draft, null)
})

test('marks overlapping fixed tasks as conflicts without moving requested times', () => {
  const result = executePlan(normalizeState({}), {
    actions: [
      { type: 'create_task', title: '会议A', dueClock: '10:00', estimatedMinutes: 60 },
      { type: 'create_task', title: '会议B', dueClock: '10:30', estimatedMinutes: 60 }
    ]
  })
  const second = result.state.tasks.find((item) => item.title === '会议B')
  assert.equal(second.scheduledStart, '10:30')
  assert.equal(second.scheduleConflict, true)
})

test('updates, deletes and completes existing tasks by id or title', () => {
  const initial = normalizeState({
    tasks: [task('t1', '团队周会'), task('t2', '写周报'), task('t3', '跑步')]
  })
  const result = executePlan(initial, {
    actions: [
      { type: 'update_task', taskId: 't1', dueClock: '16:00', estimatedMinutes: 60 },
      { type: 'delete_task', titleMatch: '跑步' },
      { type: 'complete_task', taskId: 't2', actualMinutes: 50 }
    ]
  })
  assert.equal(result.state.tasks.find((item) => item.id === 't1').scheduledStart, '16:00')
  assert.equal(result.state.tasks.find((item) => item.id === 't3').status, 'deleted')
  assert.equal(result.state.tasks.find((item) => item.id === 't2').status, 'completed')
  assert.equal(result.state.history.length, 1)
})

test('stores memory updates and applies a requested plan mode', () => {
  const result = executePlan(normalizeState({}), {
    actions: [
      { type: 'remember_preference', kind: 'time_preference', key: '专注工作', value: '上午', evidence: '用户明确说明' },
      { type: 'reschedule_tasks', mode: 'relaxed' }
    ]
  })
  assert.equal(result.state.memory.secretaryFacts[0].key, '专注工作')
  assert.equal(result.state.planMode, 'relaxed')
})

test('reports missing targets without mutating unrelated tasks', () => {
  const initial = normalizeState({ tasks: [task('t1', '保留任务')] })
  const result = executePlan(initial, {
    actions: [
      { type: 'update_task', titleMatch: '不存在的会议', dueClock: '15:00' },
      { type: 'delete_task', titleMatch: '另一个不存在的任务' },
      { type: 'complete_task', titleMatch: '仍然不存在' }
    ]
  })
  assert.equal(result.state.tasks.length, 1)
  assert.equal(result.state.tasks[0].title, '保留任务')
  assert.equal(result.changes.length, 3)
  assert.match(result.changes.join('|'), /未找到/)
})

test('rejects unsupported tool actions before any database write', () => {
  assert.throws(() => executePlan(normalizeState({}), {
    actions: [{ type: 'run_shell', command: 'anything' }]
  }), /不支持的 Agent 动作/)
})

