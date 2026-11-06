const path = require('node:path')

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) ? value : fallback
}

function loadConfig() {
  return {
    host: process.env.HOST || '127.0.0.1',
    port: numberFromEnv('PORT', 3030),
    dataDir: path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data')),
    aiGatewayUrl: String(process.env.AI_GATEWAY_URL || 'http://127.0.0.1:3010/ai').replace(/\/+$/, ''),
    aiModel: process.env.AI_MODEL || 'gpt-5.6-sol',
    agentTickMs: Math.max(10000, numberFromEnv('AGENT_TICK_MS', 60000)),
    reminderLeadMinutes: Math.max(1, numberFromEnv('REMINDER_LEAD_MINUTES', 15))
  }
}

module.exports = { loadConfig }
