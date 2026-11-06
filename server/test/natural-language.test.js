const assert = require('node:assert/strict')
const test = require('node:test')
const natural = require('../../utils/natural-language')
const time = require('../../utils/time')

test('parses Chinese and numeric clock expressions', () => {
  const cases = [
    ['凌晨三点', '03:00'],
    ['明天凌晨3点看球', '03:00'],
    ['早上七点十五分跑步', '07:15'],
    ['上午十点半开会', '10:30'],
    ['中午一点吃饭', '13:00'],
    ['下午三点半复习', '15:30'],
    ['傍晚六点散步', '18:00'],
    ['晚上八点二十分看电影', '20:20'],
    ['夜里十一点睡觉', '23:00'],
    ['明天 03:05 看比赛', '03:05'],
    ['下午 3:30 开会', '15:30'],
    ['二十三点提交作业', '23:00'],
    ['凌晨零点发布', '00:00'],
    ['24点跨年', '00:00'],
    ['没有明确时间', '']
  ]
  cases.forEach(([input, expected]) => assert.equal(natural.parseClock(input), expected, input))
})

test('parses relative, calendar and weekday dates', () => {
  const today = time.todayKey()
  const cases = [
    ['今天写周报', today],
    ['今晚游泳', today],
    ['明天开会', time.addDays(today, 1)],
    ['明晚看电影', time.addDays(today, 1)],
    ['后天出差', time.addDays(today, 2)],
    ['大后天复盘', time.addDays(today, 3)]
  ]
  cases.forEach(([input, expected]) => assert.equal(natural.parseDateKey(input, today), expected, input))
  assert.match(natural.parseDateKey('8月18号参加研讨会', today), /^\d{4}-08-18$/)
  assert.match(natural.parseDateKey('下周一开会', today), /^\d{4}-\d{2}-\d{2}$/)
})

test('extracts clean task titles from natural schedule requests', () => {
  const cases = [
    ['明天凌晨三点看世界杯决赛', '看世界杯决赛'],
    ['今天下午三点写周报', '写周报'],
    ['帮我明晚八点创建看电影的日程', '看电影'],
    ['4月18号我要去参加AI行业研讨会', '我要去参加AI行业研讨会'],
    ['后天上午十点复习数学', '复习数学']
  ]
  cases.forEach(([input, expected]) => assert.equal(natural.taskTitle(input), expected, input))
})

test('distinguishes actionable statements from questions and empty prompts', () => {
  const actionable = ['明天三点开会', '今晚去游泳', '买菜', '后天交作业']
  const nonActionable = ['你好', '谢谢', 'test', '我什么时候有空', '帮我创建一个日程', '明天有什么安排？']
  actionable.forEach((input) => assert.equal(natural.shouldCreateFallback(input), true, input))
  nonActionable.forEach((input) => assert.equal(natural.shouldCreateFallback(input), false, input))
})

