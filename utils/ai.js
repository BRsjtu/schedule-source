const AI_REQUEST_TIMEOUT_MS = 75000

function getGlobalConfig() {
  if (typeof getApp !== 'function') {
    return {
      aiBaseUrl: 'http://127.0.0.1:3010/ai',
      aiModel: 'gpt-5.6-sol'
    }
  }

  const app = getApp()
  return {
    aiBaseUrl: String((app.globalData && app.globalData.aiBaseUrl) || 'http://127.0.0.1:3010/ai').replace(/\/+$/, ''),
    aiModel: (app.globalData && app.globalData.aiModel) || 'gpt-5.6-sol'
  }
}

function createAiError(message, detail) {
  const error = new Error(message || 'AI 请求失败')
  error.detail = detail
  if (detail && detail.errMsg) {
    error.errMsg = detail.errMsg
  }
  return error
}

function callAi(path, data) {
  return new Promise((resolve, reject) => {
    const config = getGlobalConfig()

    if (typeof wx === 'undefined' || !wx.request) {
      reject(createAiError('当前环境无法发起小程序 AI 请求'))
      return
    }

    wx.request({
      url: `${config.aiBaseUrl}${path}`,
      method: 'POST',
      data,
      timeout: AI_REQUEST_TIMEOUT_MS,
      header: {
        'content-type': 'application/json'
      },
      success(res) {
        if (res.data && res.data.ok) {
          resolve(res.data.data)
          return
        }

        const errorMessage = res.data && res.data.error ? res.data.error : 'AI 请求失败'
        console.error('AI request returned error', {
          statusCode: res.statusCode,
          data: res.data
        })
        reject(createAiError(errorMessage, res))
      },
      fail(error) {
        console.error('AI request failed', error)
        reject(createAiError(error && error.errMsg ? error.errMsg : 'AI 请求失败', error))
      }
    })
  })
}

module.exports = {
  callAi,
  getGlobalConfig
}
