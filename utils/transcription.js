function getGatewayUrl() {
  var app = getApp()
  var baseUrl = app && app.globalData && app.globalData.aiBaseUrl
  return String(baseUrl || 'http://127.0.0.1:3010/ai').replace(/\/+$/, '')
}

function parseGatewayResponse(raw, statusCode, language) {
  var payload
  var lang = language === 'en' ? 'en' : 'zh'

  try {
    payload = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch (error) {
    throw new Error(lang === 'en'
      ? 'The voice service returned an invalid response.'
      : '语音识别服务返回了无法解析的数据。')
  }

  if (Number(statusCode) < 200 || Number(statusCode) >= 300 || !payload || payload.ok !== true) {
    var detail = String(payload && payload.error || '')
    var isBusy = Number(statusCode) === 429 || /429|saturated|繁忙|try again later/i.test(detail)
    throw new Error(isBusy
      ? (lang === 'en' ? 'The voice service is busy. Please try again in a moment.' : '语音识别服务繁忙，请稍后重试。')
      : (lang === 'en' ? 'Voice transcription is temporarily unavailable.' : '语音识别暂时不可用，请稍后重试。'))
  }

  var text = payload.data && String(payload.data.text || '').trim()
  if (!text) {
    throw new Error(lang === 'en' ? 'No clear speech was detected.' : '没有识别到清晰的语音。')
  }

  return {
    text: text,
    model: payload.data.model || '',
    fallbackUsed: Boolean(payload.data.fallbackUsed)
  }
}

function uploadAudio(filePath, options) {
  return new Promise(function (resolve, reject) {
    var formData = {
      prompt: options.prompt || '',
      response_format: 'json',
      temperature: '0'
    }
    if (options.language) formData.language = options.language

    wx.uploadFile({
      url: getGatewayUrl() + '/v1/audio/transcriptions',
      filePath: filePath,
      name: 'file',
      formData: formData,
      success: function (response) {
        try {
          resolve(parseGatewayResponse(response.data, response.statusCode, options.uiLanguage))
        } catch (error) {
          reject(error)
        }
      },
      fail: function (error) {
        var uploadError = new Error(error && error.errMsg ? error.errMsg : '上传录音失败。')
        uploadError.isUploadTransportError = true
        reject(uploadError)
      }
    })
  })
}

function readAudioBase64(filePath) {
  return new Promise(function (resolve, reject) {
    wx.getFileSystemManager().readFile({
      filePath: filePath,
      encoding: 'base64',
      success: function (result) {
        resolve(result.data)
      },
      fail: function (error) {
        reject(new Error(error && error.errMsg ? error.errMsg : '读取录音文件失败。'))
      }
    })
  })
}

function requestAudioBase64(filePath, options) {
  return readAudioBase64(filePath).then(function (audioBase64) {
    return new Promise(function (resolve, reject) {
      var data = {
        audioBase64: audioBase64,
        fileName: 'voice.mp3',
        mimeType: 'audio/mpeg',
        prompt: options.prompt || '',
        responseFormat: 'json',
        temperature: 0
      }
      if (options.language) data.language = options.language

      wx.request({
        url: getGatewayUrl() + '/v1/audio/transcriptions',
        method: 'POST',
        data: data,
        success: function (response) {
          try {
            resolve(parseGatewayResponse(response.data, response.statusCode, options.uiLanguage))
          } catch (error) {
            reject(error)
          }
        },
        fail: function (error) {
          reject(new Error(error && error.errMsg ? error.errMsg : '语音识别请求失败。'))
        }
      })
    })
  })
}

async function transcribeFile(filePath, options) {
  options = options || {}

  try {
    return await uploadAudio(filePath, options)
  } catch (error) {
    if (!error.isUploadTransportError) {
      throw error
    }

    console.warn('audio upload failed; trying request base64 fallback', error.message)
    return requestAudioBase64(filePath, options)
  }
}

module.exports = {
  parseGatewayResponse: parseGatewayResponse,
  transcribeFile: transcribeFile
}
