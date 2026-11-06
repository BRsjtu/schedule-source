const fs = require('fs')
const path = require('path')
const childProcess = require('child_process')

const root = path.join(__dirname, '..')

const jsFiles = [
  'app.js',
  'utils/ai.js',
  'utils/agent.js',
  'utils/i18n.js',
  'utils/locale-copy.js', 'utils/system-copy.js', 'utils/memory-presentation.js',
  'utils/natural-language.js',
  'utils/scheduler.js',
  'utils/llm-schedule.js',
  'utils/replan-presentation.js',
  'utils/storage.js',
  'utils/runtime.js',
  'utils/theme.js',
  'utils/time.js',
  'utils/transcription.js',
  'utils/task-copy.js',
  'utils/task-lifecycle.js',
  'utils/task-ui.js',
  'utils/schedule-controls.js',
  'pages/timer/timer.js',
  'pages/task-edit/task-edit.js',
  'tools/i18n-test.js',
  'tools/transcription-test.js',
  'tools/voice-input-test.js',
  'tools/longrun-schedule-test.js',
  'pages/index/index.js',
  'pages/history/history.js',
  'pages/memory/memory.js',
  'components/navigation-bar/navigation-bar.js'
]

const jsonFiles = [
  'app.json',
  'project.config.json',
  'sitemap.json',
  'pages/index/index.json',
  'pages/history/history.json',
  'pages/memory/memory.json',
  'pages/timer/timer.json',
  'pages/task-edit/task-edit.json',
  'components/navigation-bar/navigation-bar.json',
  'package.json'
]

const requiredFiles = [
  ...jsFiles,
  ...jsonFiles,
  'app.wxss',
  'pages/index/index.wxml',
  'pages/index/index.wxss',
  'pages/history/history.wxml',
  'pages/history/history.wxss',
  'pages/memory/memory.wxml',
  'pages/memory/memory.wxss',
  'pages/timer/timer.wxml', 'pages/timer/timer.wxss',
  'pages/task-edit/task-edit.wxml', 'pages/task-edit/task-edit.wxss', 'styles/task-utility.wxss'
]

function run(command, args) {
  const result = childProcess.spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    shell: false
  })

  if (result.stdout) {
    process.stdout.write(result.stdout)
  }
  if (result.stderr) {
    process.stderr.write(result.stderr)
  }
  if (result.status !== 0) {
    process.exit(result.status || 1)
  }
}

for (const relativePath of requiredFiles) {
  const filePath = path.join(root, relativePath)
  if (!fs.existsSync(filePath)) {
    throw new Error(`缺少必要文件：${relativePath}`)
  }
}

for (const relativePath of jsonFiles) {
  JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'))
}

for (const relativePath of jsFiles) {
  run(process.execPath, ['--check', relativePath])
}

console.log('项目检查通过：JS 语法、JSON 结构和关键文件均正常。')
