const theme = require('./utils/theme')
const i18n = require('./utils/i18n')
const runtime = require('./utils/runtime')

App({
  globalData: {
    aiBaseUrl: 'http://127.0.0.1:3010/ai',
    aiModel: 'gpt-5.6-sol',
    // 教育版开发者工具无法配置合法域名，本项目保持 HTTP IP 直连。
    agentBaseUrl: 'http://127.0.0.1:3010/schedule-agent',
    appName: 'AI智排时程'
  },

  onLaunch() {
    theme.applySystemTheme(theme.getTheme())
    i18n.applyTabBar()
    runtime.ensureSession().catch(function (error) {
      console.error('agent runtime bootstrap failed', error)
    })
  }
})
