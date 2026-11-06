const presentation = require('../../utils/memory-presentation')
const storage = require('../../utils/storage')
const theme = require('../../utils/theme')
const i18n = require('../../utils/i18n')
const runtime = require('../../utils/runtime')
const time = require('../../utils/time')
const scheduler = require('../../utils/scheduler')
const taskUi = require('../../utils/task-ui')

function formatPattern(key, pattern) {
  var lang = i18n.getLang()
  var slot = time.slotText(pattern.preferredSlot)
  var desc = lang === 'en'
    ? (pattern.samples || 0) + ' ' + i18n.t('samples') + ' · ' + slot
    : i18n.t('samples') + ' ' + (pattern.samples || 0) + ' ' + i18n.t('timesUnit') + ' · ' + i18n.t('commonSlot') + ' ' + slot
  return {
    key: key,
    title: presentation.categoryText(key, lang),
    samples: pattern.samples || 0,
    avgText: time.formatDuration(pattern.avgActualMinutes || 0),
    lastText: time.formatDuration(pattern.lastActualMinutes || 0),
    slotText: slot,
    desc: desc
  }
}

function formatNote(note) {
  return {
    ...note,
    ...presentation.factText(note, i18n.getLang()),
    timeText: time.formatTimestamp(note.createdAt)
  }
}

function formatFact(fact) {
  return {
    ...fact,
    ...presentation.factText(fact, i18n.getLang()),
    timeText: time.formatTimestamp(fact.updatedAt || fact.createdAt),
    confidenceText: Math.round((Number(fact.confidence) || 0) * 100) + '%'
  }
}

Page({
  data: {
    ...theme.getThemeData(),
    ...i18n.getLangData(),
    memory: {},
    prefs: {},
    patterns: [],
    facts: [],
    notes: []
  },

  onShow() {
    theme.applyTheme(this)
    i18n.applyLang(this)
    this.loadMemory()
    taskUi.watch(this, () => this.loadMemory())
    runtime.refreshState().then(() => this.loadMemory()).catch(function (error) {
      console.error('refresh server memory failed', error)
    })
  },

  onHide() { taskUi.unwatch(this) },
  onUnload() { taskUi.unwatch(this) },

  toggleTheme() {
    theme.toggleTheme(this)
  },

  toggleLang() {
    i18n.toggleLang(this)
    this.loadMemory()
  },

  loadMemory() {
    var memory = scheduler.withCompletionStats(storage.getMemory(), storage.getTasks(), storage.getHistory())
    var patterns = Object.keys(memory.taskPatterns || {})
      .map(function (key) { return formatPattern(key, memory.taskPatterns[key]) })
      .sort(function (a, b) { return b.samples - a.samples })
    var facts = (memory.secretaryFacts || []).map(formatFact)
    var notes = (memory.agentNotes || []).map(formatNote)
    this.setData({
      memory: memory,
      prefs: memory.userPreferences,
      toneText: presentation.toneText(memory.userPreferences.tone, i18n.getLang()),
      patterns: patterns,
      facts: facts,
      notes: notes
    })
    this.setData({ slotRates: ['morning', 'afternoon', 'evening'].map((slot) => {
      const stats = memory.slotStats[slot] || {}
      const attempts = Number(stats.attempts) || 0
      return { slot, title: time.slotText(slot), rate: attempts ? Math.round(Number(stats.completed || 0) / attempts * 100) + '%' : '—', detail: attempts ? i18n.tf('rateSamples', { completed: stats.completed || 0, attempts }) : i18n.t('noRateSamples') }
    }) })
  },

  onPreferenceInput(event) {
    var key = event.currentTarget.dataset.key
    var value = event.detail.value
    this.setData({
      prefs: { ...this.data.prefs, [key]: value },
      ...(key === 'tone' ? { toneText: value } : {})
    })
  },

  onBreakInput(event) {
    var value = Number(event.detail.value) || 0
    this.setData({
      prefs: { ...this.data.prefs, defaultBreakMinutes: value }
    })
  },

  savePreferences() {
    var memory = storage.getMemory()
    memory.userPreferences = { ...memory.userPreferences, ...this.data.prefs }
    storage.saveMemory(memory)
    wx.showToast({ title: i18n.t('memorySavedForSchedule'), icon: 'none' })
    this.loadMemory()
  },

  resetMemory() {
    wx.showModal({ confirmText: i18n.t('confirm'), cancelText: i18n.t('cancel'),
      title: i18n.t('resetTitle'),
      content: i18n.t('resetContent'),
      success: function (res) {
        if (!res.confirm) return
        storage.resetMemory()
        storage.savePlanMode('flexible')
        wx.showToast({ title: i18n.t('resetDone'), icon: 'success' })
        this.loadMemory()
      }.bind(this)
    })
  },

  viewMemorySource(event) {
    const record = (this.data.facts || []).concat(this.data.notes || []).find(item => item.id === event.currentTarget.dataset.id)
    if (!record) return
    wx.showModal({ confirmText: i18n.t('confirm'), cancelText: i18n.t('cancel'), title: i18n.t('memorySourceTitle'), content: [record.key, typeof record.value === 'string' ? record.value : JSON.stringify(record.value), record.evidence].filter(Boolean).join('\n'), showCancel: false })
  },

  clearChat() {
    storage.clearMessages()
    wx.showToast({ title: i18n.t('chatCleared'), icon: 'success' })
  }
})
