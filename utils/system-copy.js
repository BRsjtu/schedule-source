const i18n = require('./i18n')

function changeText(change, language) {
  const params = { ...(change.params || {}) }
  if (params.operationKey) params.operation = i18n.translate('operation_' + params.operationKey, language)
  return i18n.translate('change_' + change.type, language, params)
}

function executionText(changes, language) {
  return changes.length ? i18n.translate('executedActions', language, {
    changes: changes.map(item => typeof item === 'string' ? item : changeText(item, language)).join(language === 'en' ? ', ' : '、')
  }) : i18n.translate('noActions', language)
}

// Only migrate known system-generated summaries. User and model prose stays intact.
function legacyChanges(content) {
  if (!/^已执行：/.test(content)) return null
  const tokens = content.replace(/^已执行：/, '').replace(/。$/, '').match(/(?:创建|更新|删除|完成)“[^”]*”|[^、]+/g) || []
  const result = []
  for (const token of tokens) {
    const action = token.match(/^(创建|更新|删除|完成)“([^”]*)”$/)
    if (action) result.push({ type: { 创建: 'create', 更新: 'update', 删除: 'delete', 完成: 'complete' }[action[1]], params: { title: action[2] } })
    else if (/^写入一条长期记忆$/.test(token)) result.push({ type: 'remember' })
    else if (/^重排(?:今天)?计划$/.test(token)) result.push({ type: 'reschedule' })
    else {
      const moved = token.match(/^实际调整 (\d+) 项任务时间(?:，保留 (\d+) 项固定或进行中的任务)?$/)
      const suggested = token.match(/^生成 (\d+) 项(?:排程)?建议，未修改任务$/)
      if (moved) result.push({ type: 'replan', params: { count: moved[1], fixed: moved[2] || 0 } })
      else if (suggested) result.push({ type: 'suggestions', params: { count: suggested[1] } })
      else return null
    }
  }
  return result
}

function messageContent(message, language) {
  if (message.role !== 'assistant') return message.content
  const system = message.system
  if (system && system.type === 'execution') return executionText(system.changes || [], language)
  if (system && system.type === 'reminder') return i18n.translate('taskReminder', language, system.params)
  if (system && system.type === 'seed') return i18n.translate('seedMessage', language)
  if (system && system.type === 'cancel') return i18n.translate('pendingCanceled', language)
  const old = legacyChanges(message.content || '')
  if (old) return executionText(old, language)
  if (['zh', 'en'].some(lang => message.content === i18n.translate('seedMessage', lang))) return i18n.translate('seedMessage', language)
  return message.content
}

function errorText(message, language) {
  const errors = { '没有找到待确认计划': 'errorMissingPlan', '该计划已经处理': 'errorHandledPlan', '计划生成后日程已有变化，请重新生成计划': 'errorStalePlan', '没有识别到清晰的语音。': 'voiceEmpty' }
  if (errors[message]) return i18n.translate(errors[message], language)
  if (/其他请求中更新/.test(message || '')) return i18n.translate('errorConflict', language)
  if (language === 'en' && /[\u3400-\u9fff]/.test(message || '')) return i18n.translate('retryLater', language)
  if (language !== 'en' && !/[\u3400-\u9fff]/.test(message || '')) return i18n.translate('retryLater', language)
  return message || i18n.translate('retryLater', language)
}

module.exports = { changeText, executionText, messageContent, errorText }
