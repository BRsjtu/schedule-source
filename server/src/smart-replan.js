const llmSchedule = require('../../utils/llm-schedule')
const scheduler = require('../../utils/scheduler')
const time = require('../../utils/time')
const { memorySnapshot } = require('./state')
const { callGateway, extractJsonText } = require('./agent')

function buildPrompt(state, options) {
  const ctx = llmSchedule.context(state.tasks, options)
  const compact = task => ({ id: task.id, title: task.title, description: task.description, priority: task.priority,
    durationMinutes: llmSchedule.duration(task), preferredSlot: task.preferredSlot, dueClock: task.dueClock, status: task.status,
    currentStart: task.scheduledStart, currentEnd: task.scheduledEnd, actualMinutes: task.actualMinutes,
    completedAt: task.completedAt, dateKey: task.dateKey, feedback: task.feedback, stuckCount: task.stuckCount || 0 })
  return [
    'You are the scheduling decision maker. Choose actual start times, task order, and reasons; a validator will ONLY check constraints, not generate times.',
    `TARGET SCHEDULE DATE: ${ctx.dateKey}. ACTUAL CURRENT LOCAL DATE: ${time.todayKey()}. ACTUAL CURRENT LOCAL TIME: ${JSON.stringify(time.currentParts())}. Plan mode: ${ctx.mode}.`,
    ctx.dateKey > time.todayKey() ? 'The target date is IN THE FUTURE. None of its hours or deadlines have elapsed. Ignore the current clock when placing tomorrow/future tasks: morning slots are still available.'
      : ctx.dateKey === time.todayKey() ? 'The target is TODAY: do not place work before the available minute range below.' : 'The target date is in the past: do not invent future hours on that date.',
    `Available minute range: ${ctx.floor}..${ctx.bounds.end}; minimum break on BOTH sides of every task: ${ctx.bounds.breakMinutes} minutes.`,
    'The break is a minimum gap BETWEEN occupied tasks/intervals. Do not add a break at the available-day boundaries: the first task may start exactly at the available floor and the last may end exactly at the available end.',
    'All start values must be HH:MM (00:00..23:59). End = start + durationMinutes. Preserve each task ID, date, title, duration, and priority.',
    'Treat fixed/active tasks and carryovers as blocked intervals. NEVER return a placement or deferred item for them. Existing fixed conflicts are for the user to resolve.',
    'Place every flexible task exactly once, either in placements or deferred. Explain deferrals if hours are full; keep the highest-priority urgent work first. No new tasks.',
    'Relaxed mode: choose the 1–3 most important flexible tasks and defer the others. Other modes: fit all flexible tasks where possible.',
    'Understand task semantics: deadlines, concentration/energy requirements, preparation before meetings, travel, meals and habits stated in descriptions and memory.',
    'Basic preferences are the latest confirmed settings. Their workday bounds and break duration are authoritative; older evidence text must not override them.',
    'Use history and completion rates as evidence, without inventing habits or dependencies. Preferred periods are soft constraints; explain any deviation.',
    'Read the previous plan and current arrangement afresh. Improve actual issues, not just copy previous times. If it already fits well, keep it and explain why; do not shuffle for appearances.',
    'Do not promise changes that are absent from placements. If all work must be deferred, say so plainly.',
    'Explanations should describe task relationships and preferences. Do not repeat exact clock times or calculate end times in summary/reasons; the interface already displays verified start and end times.',
    'Return STRICT JSON: {"summary":{"zh":"简短中文说明","en":"Short English explanation"},"placements":[{"taskId":"existing id","start":"09:30","reason":{"zh":"这个时间的具体理由","en":"Specific reason for this time"}}],"deferred":[{"taskId":"existing id","reason":{"zh":"暂不安排原因","en":"Reason to defer"}}]}.',
    'Write both Chinese and English explanations with equivalent meaning. Preserve user-authored task names inside both languages.',
    'JSON syntax is mandatory: escape newlines and any double quotes inside strings. Use typographic quotes “ ” when quoting a task name in prose, rather than raw ASCII double quotes. No trailing commas or text outside the JSON object.',
    `User request: ${options.instruction || 'Optimize this day using the latest task state and memory.'}`,
    `Flexible tasks: ${JSON.stringify(ctx.movable.map(compact))}`,
    `Fixed and active tasks: ${JSON.stringify(ctx.fixed.map(compact))}`,
    `Blocked intervals (minutes): ${JSON.stringify(ctx.blocks)}`,
    `Memory: ${JSON.stringify(memorySnapshot(scheduler.withCompletionStats(state.memory, state.tasks, state.history)))}`,
    `Period completion rates: ${JSON.stringify(scheduler.withCompletionStats(state.memory, state.tasks, state.history).slotStats)}`,
    `Recent completion history: ${JSON.stringify(state.history.slice(0, 15).map(compact))}`,
    `Previous plan: ${JSON.stringify(state.scheduleReport && state.scheduleReport.dateKey === ctx.dateKey ? state.scheduleReport : null)}`
  ].join('\n')
}

async function generate(config, state, options) {
  const ctx = llmSchedule.context(state.tasks, options)
  if (!ctx.movable.length) {
    const proposal = { summary: { zh: ctx.pending.length ? '这些事项都有固定时间或正在计时，已保留原安排。' : '这个日期没有待排任务。', en: ctx.pending.length ? 'These tasks have fixed times or active timers. Their times are kept.' : 'No pending tasks on this date.' }, placements: [], deferred: [] }
    return { ...llmSchedule.apply(state.tasks, proposal, { ...options, engine: 'constraints' }), proposal, model: '' }
  }
  const prompt = buildPrompt(state, options)
  let correction = '', lastError
  for (let attempt = 0; attempt < 2; attempt++) {
    // Transport errors are real failures. Only an invalid model plan gets one repair.
    const result = await callGateway(config, prompt + correction, { timeoutMs: 90000 })
    try {
      const proposal = JSON.parse(extractJsonText(result.text))
      const applied = llmSchedule.apply(state.tasks, proposal, { ...options, model: result.model || config.aiModel })
      return { ...applied, proposal, model: result.model || config.aiModel }
    } catch (error) {
      lastError = error
      console.error('invalid LLM schedule', error.message)
      correction = '\nYour last result failed validation: ' + error.message + '. Return a corrected complete JSON plan satisfying every hard constraint.'
    }
  }
  throw Object.assign(new Error('AI schedule failed validation: ' + lastError.message), { statusCode: 422 })
}

module.exports = { buildPrompt, generate }
