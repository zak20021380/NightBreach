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
const chromePath = process.env.CHROME_PATH
  ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
if (!existsSync(chromePath)) throw new Error('Chrome was not found.')

const outputDirectory = resolve(
  process.env.NIGHTBREACH_SHED_SCREENSHOTS
    ?? join(projectRoot, 'artifacts', 'shed-validation'),
)
const profilePath = join(
  tmpdir(),
  `nightbreach-chrome-shed-${process.pid}-${Date.now()}`,
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
      if (response.ok) return response
    } catch {
      // The local process is still starting.
    }
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${url}`)
}

async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl)
  await new Promise((resolveSocket, rejectSocket) => {
    socket.addEventListener('open', resolveSocket, { once: true })
    socket.addEventListener('error', rejectSocket, { once: true })
  })

  let nextId = 0
  const pending = new Map()
  const browserErrors = []
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data))
    if (message.id !== undefined) {
      const command = pending.get(message.id)
      if (!command) return
      pending.delete(message.id)
      clearTimeout(command.timeoutId)
      if (message.error) {
        command.reject(new Error(
          `${message.error.code}: ${message.error.message}`,
        ))
      } else {
        command.resolve(message.result)
      }
      return
    }
    if (message.method === 'Runtime.exceptionThrown') {
      browserErrors.push(
        message.params?.exceptionDetails?.exception?.description
          ?? message.params?.exceptionDetails?.text
          ?? 'Unknown browser exception',
      )
    }
    if (message.method === 'Log.entryAdded'
      && message.params?.entry?.level === 'error') {
      browserErrors.push(message.params.entry.text)
    }
  })

  function send(method, params = {}) {
    nextId += 1
    const id = nextId
    return new Promise((resolveCommand, rejectCommand) => {
      const timeoutId = setTimeout(() => {
        pending.delete(id)
        rejectCommand(new Error(`Chrome DevTools command timed out: ${method}`))
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
    name: 'isolated-front.png',
    path: '/shed-preview.html',
    canvasSelector: '#previewCanvas',
    readyExpression:
      `document.querySelector('#previewCanvas')?.dataset.previewReady === 'true'`,
  },
  {
    name: 'enterable-front.png',
    parameters: {
      x: '-15.6',
      z: '13.2',
      targetX: '-15.6',
      targetZ: '19.7',
      pitch: '-0.04',
    },
  },
  {
    name: 'enterable-side.png',
    parameters: {
      x: '-9.1',
      z: '19.7',
      targetX: '-15.6',
      targetZ: '19.7',
      pitch: '-0.04',
    },
  },
  {
    name: 'secondary-front.png',
    parameters: {
      x: '19.4',
      z: '4.5',
      targetX: '19.4',
      targetZ: '10.6',
      pitch: '-0.04',
    },
  },
  {
    name: 'secondary-side.png',
    parameters: {
      x: '25.0',
      z: '10.6',
      targetX: '19.4',
      targetZ: '10.6',
      pitch: '-0.04',
    },
  },
  {
    name: 'enterable-front-open.png',
    parameters: {
      shedMode: 'open',
      x: '-16.55',
      z: '15.0',
      targetX: '-16.55',
      targetZ: '17.9',
    },
  },
  {
    name: 'enterable-open-entry.png',
    parameters: {
      shedMode: 'entry',
    },
    readyExpression:
      `document.querySelector('#renderCanvas')?.dataset.shedEntryValidation !== undefined`,
  },
  {
    name: 'enterable-closed-door-block.png',
    parameters: {
      shedMode: 'closed-block',
    },
  },
  {
    name: 'enterable-mobile-door.png',
    mobileDoorTest: true,
    parameters: {
      x: '-14.669',
      z: '16.75',
      targetX: '-14.669',
      targetZ: '18.033',
    },
  },
]
const viewStart = Number(process.env.NIGHTBREACH_SHED_VIEW_START ?? 0)
const viewCount = Number(process.env.NIGHTBREACH_SHED_VIEW_COUNT ?? views.length)
const selectedViews = views.slice(viewStart, viewStart + viewCount)

const serverPort = await getFreePort()
const cdpPort = await getFreePort()
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
const chromeProcess = spawn(chromePath, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  `--user-data-dir=${profilePath}`,
  `--remote-debugging-port=${cdpPort}`,
  'about:blank',
], {
  cwd: projectRoot,
  stdio: ['ignore', 'ignore', 'pipe'],
  windowsHide: true,
})
let chromeDiagnostics = ''
chromeProcess.stderr.on('data', (chunk) => {
  chromeDiagnostics += String(chunk)
})

let cdp
try {
  const baseUrl = `http://127.0.0.1:${serverPort}`
  await Promise.all([
    waitForHttp(baseUrl),
    waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`),
  ])
  const targetsResponse = await waitForHttp(
    `http://127.0.0.1:${cdpPort}/json/list`,
  )
  const targets = await targetsResponse.json()
  const target = targets.find((entry) => entry.type === 'page')
  if (!target?.webSocketDebuggerUrl) {
    throw new Error('Chrome did not expose a page debugging target.')
  }
  cdp = await connectCdp(target.webSocketDebuggerUrl)
  await Promise.all([
    cdp.send('Runtime.enable'),
    cdp.send('Log.enable'),
    cdp.send('Page.enable'),
  ])
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    deviceScaleFactor: 1,
    height: 720,
    mobile: false,
    width: 1280,
  })
  if (selectedViews.some((view) => view.mobileDoorTest)) {
    await cdp.send('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 5,
    })
  }

  async function evaluate(expression) {
    const result = await cdp.send('Runtime.evaluate', {
      awaitPromise: true,
      expression,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description
          ?? result.exceptionDetails.text
          ?? 'Chrome evaluation failed.',
      )
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
      title: document.title,
    })`)
    throw new Error(
      `Timed out waiting for ${expression}\n`
      + `${state}\n`
      + `${cdp.browserErrors.join('\n')}`,
    )
  }

  for (const view of selectedViews) {
    const url = view.path
      ? `${baseUrl}${view.path}`
      : `${baseUrl}?${query(view.parameters)}`
    await cdp.send('Page.navigate', { url })
    await waitForExpression(
      view.readyExpression
        ?? `document.querySelector('#renderCanvas')?.dataset.shedCaptureReady === 'true'`,
    )
    let mobileDoorValidation = null
    if (view.mobileDoorTest) {
      const before = await evaluate(`({
        door: window.__nightBreachTest.snapshot().door,
        gates: window.__nightBreachTest.inputGates(),
      })`)
      if (!before.gates.isTouchDevice
        || !before.door.interactionAvailable
        || !before.door.mobileUseVisible) {
        throw new Error(
          `Mobile door control was unavailable: ${JSON.stringify(before)}`,
        )
      }
      await evaluate(`(() => {
        const button = document.querySelector('#useButton')
        const bounds = button.getBoundingClientRect()
        button.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          clientX: bounds.left + bounds.width * 0.5,
          clientY: bounds.top + bounds.height * 0.5,
          isPrimary: true,
          pointerId: 91,
          pointerType: 'touch',
        }))
      })()`)
      await waitForExpression(
        `window.__nightBreachTest.snapshot().door.state === 'open'`,
      )
      mobileDoorValidation = {
        before,
        after: await evaluate(`window.__nightBreachTest.snapshot().door`),
      }
    }
    await delay(400)
    const canvasSelector = view.canvasSelector ?? '#renderCanvas'
    const validationState = await evaluate(`JSON.stringify({
      camera: window.__nightBreachTest?.snapshot?.().cameraPosition,
      capture: { ...document.querySelector(${JSON.stringify(canvasSelector)})?.dataset },
      mode: new URLSearchParams(location.search).get('shedMode') ?? 'view',
      mobileDoorValidation: ${JSON.stringify(mobileDoorValidation)},
      structures: window.__nightBreachTest?.snapshot?.().structures,
      title: document.title,
    })`)
    const capture = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
    })
    const outputPath = join(outputDirectory, view.name)
    writeFileSync(outputPath, Buffer.from(capture.data, 'base64'))
    console.log(`shed-validation: ${view.name} ${validationState}`)
    console.log(`shed-screenshot: ${outputPath}`)
  }

  if (cdp.browserErrors.length > 0) {
    throw new Error(`Chrome browser errors:\n${cdp.browserErrors.join('\n')}`)
  }
  console.log(
    `shed-screenshot: captured ${selectedViews.length} views in ${outputDirectory}`,
  )
} catch (error) {
  if (chromeDiagnostics) console.error(chromeDiagnostics)
  throw error
} finally {
  cdp?.socket.close()
  chromeProcess.kill()
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
    console.warn(
      `shed-screenshot: temporary Chrome profile cleanup deferred (${error.message})`,
    )
  }
}
