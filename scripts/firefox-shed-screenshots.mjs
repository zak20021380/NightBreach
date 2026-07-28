import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const firefoxPath = process.env.FIREFOX_PATH
  ?? 'C:\\Program Files\\Mozilla Firefox\\firefox.exe'
if (!existsSync(firefoxPath)) throw new Error('Firefox was not found.')

const outputDirectory = resolve(
  process.env.NIGHTBREACH_SHED_SCREENSHOTS
    ?? join(projectRoot, 'artifacts', 'shed-validation'),
)
const profilePath = join(
  tmpdir(),
  `nightbreach-firefox-shed-${process.pid}-${Date.now()}`,
)
mkdirSync(outputDirectory, { recursive: true })
mkdirSync(profilePath, { recursive: true })

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function getFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        rejectPort(new Error('Could not allocate a local port.'))
        return
      }
      server.close(() => resolvePort(address.port))
    })
  })
}

async function waitForHttp(url, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // The server is still starting.
    }
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${url}`)
}

async function connectBidi(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl)
  socket.binaryType = 'arraybuffer'
  await new Promise((resolveSocket, rejectSocket) => {
    socket.addEventListener('open', resolveSocket, { once: true })
    socket.addEventListener('error', rejectSocket, { once: true })
  })

  let nextId = 0
  const pending = new Map()
  const browserErrors = []
  socket.addEventListener('message', async (event) => {
    let rawMessage = event.data
    if (rawMessage instanceof Blob) rawMessage = await rawMessage.text()
    else if (rawMessage instanceof ArrayBuffer) {
      rawMessage = new TextDecoder().decode(rawMessage)
    }
    const message = JSON.parse(String(rawMessage))
    if (message.id !== undefined) {
      const command = pending.get(message.id)
      if (!command) return
      pending.delete(message.id)
      clearTimeout(command.timeoutId)
      if (message.type === 'error') {
        command.reject(new Error(
          `${message.error}: ${message.message}\n${message.stacktrace ?? ''}`,
        ))
      } else {
        command.resolve(message.result)
      }
      return
    }
    if (message.type === 'event'
      && message.method === 'log.entryAdded'
      && message.params?.level === 'error') {
      browserErrors.push(message.params.text)
    }
  })

  function send(method, params = {}) {
    nextId += 1
    const id = nextId
    return new Promise((resolveCommand, rejectCommand) => {
      const timeoutId = setTimeout(() => {
        pending.delete(id)
        rejectCommand(new Error(`WebDriver BiDi command timed out: ${method}`))
      }, 60_000)
      pending.set(id, {
        reject: rejectCommand,
        resolve: resolveCommand,
        timeoutId,
      })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }

  return { browserErrors, send, socket }
}

function query(parameters) {
  return new URLSearchParams({
    shedCapture: '1',
    ...parameters,
  }).toString()
}

const views = [
  {
    name: 'front-closed.png',
    parameters: {
      x: '-15.6',
      z: '13.4',
      targetX: '-15.6',
      targetZ: '19.7',
      pitch: '-0.04',
    },
  },
  {
    name: 'front-left-closed.png',
    parameters: {
      x: '-19.1',
      z: '15.4',
      targetX: '-16.55',
      targetZ: '17.9',
      pitch: '-0.03',
    },
  },
  {
    name: 'front-right-closed.png',
    parameters: {
      x: '-12.8',
      z: '15.2',
      targetX: '-16.55',
      targetZ: '17.9',
      pitch: '-0.03',
    },
  },
  {
    name: 'back.png',
    parameters: {
      x: '-15.6',
      z: '26.2',
      targetX: '-15.6',
      targetZ: '19.7',
      pitch: '-0.03',
    },
  },
  {
    name: 'left.png',
    parameters: {
      x: '-20.7',
      z: '24.2',
      targetX: '-15.6',
      targetZ: '19.7',
      pitch: '-0.03',
    },
  },
  {
    name: 'right.png',
    parameters: {
      x: '-9.1',
      z: '19.7',
      targetX: '-15.6',
      targetZ: '19.7',
      pitch: '-0.03',
    },
  },
  {
    name: 'interior-closed.png',
    parameters: {
      x: '-15.6',
      z: '19.7',
      targetX: '-17.1',
      targetZ: '18.2',
    },
  },
  {
    name: 'interior-floor.png',
    parameters: {
      x: '-15.6',
      z: '19.7',
      targetX: '-15.6',
      targetZ: '20.7',
      pitch: '0.42',
    },
  },
  {
    name: 'front-open.png',
    parameters: {
      shedMode: 'open',
      x: '-16.55',
      z: '15.0',
      targetX: '-16.55',
      targetZ: '17.9',
    },
  },
  {
    name: 'interior-open-entry.png',
    parameters: {
      shedMode: 'entry',
    },
  },
  {
    name: 'closed-door-block.png',
    parameters: {
      shedMode: 'closed-block',
    },
  },
  {
    name: 'west-wall-block.png',
    parameters: {
      shedMode: 'wall-block',
    },
  },
]
const selectedViews = views.slice(
  Number(process.env.NIGHTBREACH_SHED_VIEW_START ?? 0),
)

const serverPort = await getFreePort()
const bidiPort = await getFreePort()
const vitePath = join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js')
const serverProcess = spawn(process.execPath, [
  vitePath,
  '--host', '127.0.0.1',
  '--port', String(serverPort),
  '--strictPort',
], {
  cwd: projectRoot,
  stdio: 'ignore',
  windowsHide: true,
})
const firefoxProcess = spawn(firefoxPath, [
  '--headless',
  '--new-instance',
  '--no-remote',
  '--profile',
  profilePath,
  '--remote-debugging-port',
  String(bidiPort),
  'about:blank',
], {
  cwd: projectRoot,
  stdio: ['ignore', 'ignore', 'pipe'],
  windowsHide: true,
})
let firefoxDiagnostics = ''
firefoxProcess.stderr.on('data', (chunk) => {
  firefoxDiagnostics += String(chunk)
})

let bidi
try {
  const baseUrl = `http://127.0.0.1:${serverPort}`
  await Promise.all([
    waitForHttp(baseUrl),
    waitForHttp(`http://127.0.0.1:${bidiPort}`),
  ])
  bidi = await connectBidi(`ws://127.0.0.1:${bidiPort}/session`)
  await bidi.send('session.new', { capabilities: {} })
  await bidi.send('session.subscribe', { events: ['log.entryAdded'] })
  const tree = await bidi.send('browsingContext.getTree')
  const context = tree.contexts[0]?.context
  if (!context) throw new Error('Firefox did not expose a browsing context.')
  await bidi.send('browsingContext.setViewport', {
    context,
    devicePixelRatio: 1,
    viewport: { height: 720, width: 1280 },
  })

  async function evaluate(expression) {
    const result = await bidi.send('script.evaluate', {
      awaitPromise: true,
      expression,
      resultOwnership: 'none',
      target: { context },
    })
    if (result.type === 'exception') {
      throw new Error(result.exceptionDetails?.text ?? 'Firefox evaluation failed.')
    }
    return result.result?.value
  }

  async function waitForExpression(expression, timeout = 60_000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return
      await delay(75)
    }
    const state = await evaluate(`JSON.stringify({
      body: document.body?.className,
      canvas: { ...document.querySelector('#renderCanvas')?.dataset },
      instructions: document.querySelector('#instructions')?.textContent,
    })`)
    throw new Error(
      `Timed out waiting for ${expression}\n${state}\n`
      + `${bidi.browserErrors.join('\n')}`,
    )
  }

  for (const view of selectedViews) {
    const url = `${baseUrl}?${query(view.parameters)}`
    await bidi.send('browsingContext.navigate', {
      context,
      url,
      wait: 'complete',
    })
    await waitForExpression(
      `document.querySelector('#renderCanvas')?.dataset.shedCaptureReady === 'true'`,
    )
    const validationState = await evaluate(`JSON.stringify({
      camera: window.__nightBreachTest?.snapshot?.().cameraPosition,
      capture: { ...document.querySelector('#renderCanvas')?.dataset },
      mode: new URLSearchParams(location.search).get('shedMode') ?? 'view',
    })`)
    console.log(`shed-validation: ${view.name} ${validationState}`)
    const capture = await bidi.send('browsingContext.captureScreenshot', {
      context,
      format: { type: 'image/png' },
      origin: 'viewport',
    })
    writeFileSync(
      join(outputDirectory, view.name),
      Buffer.from(capture.data, 'base64'),
    )
    console.log(`shed-screenshot: ${view.name}`)
  }

  if (bidi.browserErrors.length > 0) {
    throw new Error(`Firefox browser errors:\n${bidi.browserErrors.join('\n')}`)
  }
  console.log(
    `shed-screenshot: captured ${selectedViews.length} views in ${outputDirectory}`,
  )
} catch (error) {
  if (firefoxDiagnostics) console.error(firefoxDiagnostics)
  throw error
} finally {
  try {
    await bidi?.send('session.end')
  } catch {
    // Best-effort session cleanup.
  }
  bidi?.socket.close()
  firefoxProcess.kill()
  serverProcess.kill()
  await delay(500)
  try {
    rmSync(profilePath, {
      force: true,
      maxRetries: 10,
      recursive: true,
      retryDelay: 100,
    })
  } catch (error) {
    console.warn(`shed-screenshot: temporary profile cleanup deferred (${error.message})`)
  }
}
