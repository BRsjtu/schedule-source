const storage = require('../../utils/storage')
const scheduler = require('../../utils/scheduler')
const runtime = require('../../utils/runtime')
const systemCopy = require('../../utils/system-copy')
const theme = require('../../utils/theme')
const i18n = require('../../utils/i18n')
const time = require('../../utils/time')

const slots = ['any', 'morning', 'afternoon', 'evening']
const priorities = ['low', 'medium', 'high', 'urgent']

Page({
  data: { ...theme.getThemeData(), ...i18n.getLangData(), form: {}, slotIndex: 0, priorityIndex: 1, fixed: false, recommendation: {}, preview: '', saving: false },
  onLoad(query) {
    const task = query.id && storage.getTasks().find((item) => item.id === query.id)
    this.taskId = task ? task.id : ''
    const form = task ? { ...task } : { title: '', description: '', dateKey: query.date || time.todayKey(), estimatedMinutes: '', preferredSlot: 'any', priority: 'medium', dueClock: '09:00' }
    this.setData({ form, fixed: Boolean(task && task.dueClock), slotIndex: Math.max(0, slots.indexOf(form.preferredSlot)), priorityIndex: Math.max(0, priorities.indexOf(form.priority)) })
    this.updateRecommendation()
  },
  onShow() {
    theme.applyTheme(this); i18n.applyLang(this)
    this.setData({ slotLabels: slots.map(slot => time.slotText(slot)), priorityLabels: priorities.map(i18n.priorityText) })
    this.updateRecommendation()
  },
  inputField(event) {
    const key = event.currentTarget.dataset.key
    this.setData({ form: { ...this.data.form, [key]: event.detail.value } })
    this.updateRecommendation()
  },
  changeSlot(event) {
    const slotIndex = Number(event.detail.value)
    this.setData({ slotIndex, form: { ...this.data.form, preferredSlot: slots[slotIndex] } })
    this.updateRecommendation()
  },
  changePriority(event) {
    const priorityIndex = Number(event.detail.value)
    this.setData({ priorityIndex, form: { ...this.data.form, priority: priorities[priorityIndex] } })
    this.updateRecommendation()
  },
  changeFixed(event) {
    this.setData({ fixed: event.detail.value, form: { ...this.data.form, dueClock: this.data.form.dueClock || '09:00' } })
    this.updateRecommendation()
  },
  updateRecommendation() {
    const memory = scheduler.withCompletionStats(storage.getMemory(), storage.getTasks(), storage.getHistory())
    const recommended = scheduler.recommendDuration(this.data.form, storage.getHistory(), memory)
    const slot = scheduler.resolveEffectiveSlot(this.data.form, memory)
    const candidate = { ...this.data.form, id: this.taskId || '__manual_preview__', status: 'todo', dueClock: this.data.fixed ? this.data.form.dueClock : '', estimatedMinutes: Number(this.data.form.estimatedMinutes) || recommended.minutes }
    const start = this.data.fixed ? time.parseClockToMinutes(candidate.dueClock, null) : null
    this.setData({
      recommendation: { ...recommended, slot, text: i18n.tf('recommendationDetail', { minutes: recommended.minutes, slot: time.slotText(slot) }) },
      preview: start != null ? `${candidate.dateKey} · ${time.formatScheduleMinute(start)}–${time.formatScheduleMinute(start + candidate.estimatedMinutes)}` : i18n.t('smartScheduleOnSave')
    })
  },
  adoptRecommendation() {
    const preferredSlot = this.data.recommendation.slot
    this.setData({ form: { ...this.data.form, estimatedMinutes: this.data.recommendation.minutes, preferredSlot }, slotIndex: Math.max(0, slots.indexOf(preferredSlot)) })
    this.updateRecommendation()
  },
  async saveTask() {
    if (this.data.saving) return
    const form = this.data.form
    if (!String(form.title || '').trim()) { wx.showToast({ title: i18n.t('nameRequired'), icon: 'none' }); return }
    const minutes = Number(form.estimatedMinutes || this.data.recommendation.minutes)
    if (!Number.isFinite(minutes) || minutes < 5 || minutes > 1440) { wx.showToast({ title: i18n.t('durationInvalid'), icon: 'none' }); return }
    this.setData({ saving: true })
    const action = { ...form, title: form.title.trim(), estimatedMinutes: minutes, dueClock: this.data.fixed ? form.dueClock : '', type: this.taskId ? 'update_task' : 'create_task', taskId: this.taskId }
    try {
      await runtime.saveTask(action)
      wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/history/history' }) })
    } catch (error) {
      console.error('smart task save failed', error)
      wx.showModal({ title: i18n.t('smartSaveErrorTitle'), content: systemCopy.errorText(error.message, i18n.getLang()), showCancel: false, confirmText: i18n.t('confirm') })
    } finally { this.setData({ saving: false }) }
  }
})
