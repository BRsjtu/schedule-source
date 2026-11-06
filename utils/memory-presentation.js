const i18n = require('./i18n')

const categoryKeys = { '写作整理': 'categoryWriting', '沟通会议': 'categoryMeeting', '学习输入': 'categoryLearning', '运动健康': 'categoryExercise', '轻量杂务': 'categoryChores', '出行安排': 'categoryTravel', '一般任务': 'categoryGeneral' }
const fieldKeys = { exerciseMealOrder: 'memoryExerciseMeal', focusWorkPreferredSlot: 'memoryFocusPeriod', workdayStart: 'memoryWorkStart', workdayEnd: 'memoryWorkEnd', defaultBreakMinutes: 'memoryBreak', tone: 'memoryTone', planMode: 'memoryPlanMode', dynamicPlan: 'memoryDynamic' }
const kindKeys = { preference: 'memoryKindPreference', time_preference: 'memoryKindTime', scheduling: 'memoryKindPlanning', planning_rule: 'memoryKindPlanning', communication_style: 'memoryKindTone', task_habit: 'memoryKindHabit' }

function categoryText(value, language) {
  return categoryKeys[value] ? i18n.translate(categoryKeys[value], language) : value
}

function keyText(key, language) {
  if (fieldKeys[key]) return i18n.translate(fieldKeys[key], language)
  // Custom memory titles remain authored content; hide implementation identifiers.
  if (/^[a-z]+(?:[A-Z][a-zA-Z]*)+$|^[a-z]+(?:_[a-z]+)+$/.test(key || '')) {
    return language === 'en' ? key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ') : i18n.translate('memoryKindOther', language)
  }
  return key
}

function toneText(value, language) {
  const tones = { toneGentle: ['温和、直接、不给压力', 'Gentle, direct, no pressure'], toneDirect: ['简洁、直接', 'Concise and direct'], toneEncouraging: ['积极、鼓励', 'Positive and encouraging'] }
  const key = Object.keys(tones).find(item => tones[item].includes(value))
  return key ? i18n.translate(key, language) : value
}

function valueText(key, value, language) {
  if (key === 'tone') return toneText(value, language)
  if (/Slot|slot|Period|period/.test(key || '')) {
    const slot = { morning: 'slotMorning', afternoon: 'slotAfternoon', evening: 'slotEvening', any: 'slotAny', '上午': 'slotMorning', '下午': 'slotAfternoon', '晚上': 'slotEvening' }[value]
    if (slot) return i18n.translate(slot, language)
  }
  if (key === 'planMode' && ['relaxed', 'flexible', 'suggestion'].includes(value)) return modeText(value, language)
  if (key === 'defaultBreakMinutes') return i18n.translate('memoryMinutes', language, { minutes: value })
  if (typeof value === 'boolean') return i18n.translate(value ? 'memoryEnabled' : 'memoryDisabled', language)
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function modeText(value, language) {
  return i18n.translate({ relaxed: 'modeRelaxed', flexible: 'modeFlexible', suggestion: 'modeSuggestion' }[value] || 'modeFlexible', language)
}

function factText(fact, language) {
  return { kindText: i18n.translate(kindKeys[fact.kind] || 'memoryKindOther', language), keyText: keyText(fact.key, language), valueText: valueText(fact.key, fact.value, language) }
}

function recommendationText(task, language) {
  let key = task.recommendationBasisKey || task.basisKey
  let params = task.recommendationBasisParams || task.basisParams || {}
  const old = task.recommendationBasis || task.basis || ''
  if (!key) {
    if (old === '采用你调整后的预估' || old === 'Using your adjusted estimate') key = 'basisOverride'
    else if (old === '按任务类型默认估算' || old === 'Estimated by task type') key = 'basisDefault'
    else {
      const history = old.match(/^(?:参考 (\d+) 条相似历史|Based on (\d+) similar records)$/)
      const pattern = old.match(/^(?:记忆中“(.+)”平均用时|Average actual duration for “(.+)”)$/)
      if (history) { key = 'basisHistory'; params = { count: history[1] || history[2] } }
      if (pattern) { key = 'basisPattern'; params = { category: pattern[1] || pattern[2] } }
    }
  }
  return key ? i18n.translate(key, language, { ...params, category: categoryText(params.category, language) }) : old
}

module.exports = { categoryText, keyText, toneText, valueText, modeText, factText, recommendationText }
