const THEME_KEY = 'scheduleThemeMode'

const THEME_CONFIG = {
  dark: {
    theme: 'dark',
    themeClass: 'theme-dark',
    themeLabel: '☀️',
    themeText: '切换浅色',
    navColor: '#f6f8f7',
    navBackground: '#101312',
    tabBar: {
      color: '#717b78',
      selectedColor: '#13c59a',
      backgroundColor: '#101312',
      borderStyle: 'black'
    }
  },
  light: {
    theme: 'light',
    themeClass: 'theme-light',
    themeLabel: '🌙',
    themeText: '切换深色',
    navColor: '#132437',
    navBackground: 'rgba(244,247,246,0.96)',
    tabBar: {
      color: '#6b7680',
      selectedColor: '#0a8f72',
      backgroundColor: '#f7faf9',
      borderStyle: 'white'
    }
  }
}

let fallbackTheme = 'dark'

function canUseWxStorage() {
  return typeof wx !== 'undefined' && wx.getStorageSync && wx.setStorageSync
}

function normalizeTheme(theme) {
  return theme === 'light' ? 'light' : 'dark'
}

function getTheme() {
  if (!canUseWxStorage()) {
    return fallbackTheme
  }

  try {
    return normalizeTheme(wx.getStorageSync(THEME_KEY))
  } catch (error) {
    return fallbackTheme
  }
}

function saveTheme(theme) {
  const next = normalizeTheme(theme)
  fallbackTheme = next
  if (canUseWxStorage()) {
    wx.setStorageSync(THEME_KEY, next)
  }
  return next
}

function getThemeData(theme) {
  const next = normalizeTheme(theme || getTheme())
  return { ...THEME_CONFIG[next], themeText: require('./i18n').t(next === 'dark' ? 'toggleLight' : 'toggleDark') }
}

function applySystemTheme(theme) {
  if (typeof wx === 'undefined') {
    return
  }

  const data = getThemeData(theme)
  if (wx.setTabBarStyle) {
    wx.setTabBarStyle(data.tabBar)
  }
  if (wx.setNavigationBarColor) {
    wx.setNavigationBarColor({
      frontColor: data.theme === 'dark' ? '#ffffff' : '#000000',
      backgroundColor: data.theme === 'dark' ? '#101312' : '#f7faf9'
    })
  }
}

function applyTheme(page) {
  const data = getThemeData()
  if (page && page.setData) {
    page.setData(data)
  }
  applySystemTheme(data.theme)
  return data
}

function toggleTheme(page) {
  const next = getTheme() === 'dark' ? 'light' : 'dark'
  saveTheme(next)
  return applyTheme(page)
}

module.exports = {
  THEME_KEY,
  applySystemTheme,
  applyTheme,
  getTheme,
  getThemeData,
  saveTheme,
  toggleTheme
}
