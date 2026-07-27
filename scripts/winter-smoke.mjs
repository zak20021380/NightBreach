import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifactDirectory = process.env.NIGHTBREACH_WINTER_ARTIFACT_DIR
  ?? join(tmpdir(), 'nightbreach-winter-validation')
const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean)
const chromePath = chromeCandidates.find((candidate) => existsSync(candidate))

if (!chromePath) throw new Error('Chrome or Edge was not found.')
mkdirSync(artifactDirectory, { recursive: true })

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function getFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        rejectPort(new Error('Could not allocate a local test port.'))
        return
      }
      server.close(() => resolvePort(address.port))
    })
  })
}

async function waitForHttp(url) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // Vite is still starting.
    }
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${url}`)
}

async function connectCdp(debugPort) {
  const deadline = Date.now() + 15_000
  let page
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
      page = targets.find((target) => target.type === 'page')
      if (page) break
    } catch {
      // Chromium is still starting.
    }
    await delay(100)
  }
  if (!page) throw new Error('Timed out waiting for the browser debugging endpoint.')

  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolveSocket, rejectSocket) => {
    socket.addEventListener('open', resolveSocket, { once: true })
    socket.addEventListener('error', rejectSocket, { once: true })
  })
  let commandId = 0
  const pending = new Map()
  const errors = []

  socket.addEventListener('message', async (event) => {
    const message = JSON.parse(String(event.data instanceof Blob ? await event.data.text() : event.data))
    if (message.id) {
      const command = pending.get(message.id)
      if (!command) return
      pending.delete(message.id)
      if (message.error) command.reject(new Error(message.error.message))
      else command.resolve(message.result)
    } else if (message.method === 'Runtime.exceptionThrown') {
      errors.push(message.params.exceptionDetails.text)
    } else if (message.method === 'Runtime.consoleAPICalled'
      && message.params.type === 'error') {
      errors.push(message.params.args.map((argument) =>
        argument.value ?? argument.description ?? '').join(' '))
    }
  })

  function send(method, params = {}) {
    commandId += 1
    return new Promise((resolveCommand, rejectCommand) => {
      pending.set(commandId, { reject: rejectCommand, resolve: resolveCommand })
      socket.send(JSON.stringify({ id: commandId, method, params }))
    })
  }

  async function evaluate(expression) {
    const response = await send('Runtime.evaluate', {
      awaitPromise: true,
      expression,
      returnByValue: true,
    })
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description
        ?? response.exceptionDetails.text)
    }
    return response.result.value
  }

  async function waitFor(expression, timeout = 60_000) {
    const waitDeadline = Date.now() + timeout
    while (Date.now() < waitDeadline) {
      if (await evaluate(expression)) return
      await delay(50)
    }
    throw new Error(`Timed out waiting for: ${expression}`)
  }

  return { errors, evaluate, send, socket, waitFor }
}

async function validateViewport(serverPort, definition) {
  const debugPort = await getFreePort()
  const profilePath = join(tmpdir(), `nightbreach-winter-${process.pid}-${definition.name}`)
  const browser = spawn(chromePath, [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--enable-unsafe-swiftshader',
    '--remote-allow-origins=*',
    '--use-angle=swiftshader',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profilePath}`,
    `--window-size=${definition.width},${definition.height}`,
    'about:blank',
  ], {
    stdio: 'ignore',
    windowsHide: true,
  })
  let cdp
  try {
    cdp = await connectCdp(debugPort)
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      deviceScaleFactor: definition.mobile ? 2 : 1,
      height: definition.height,
      mobile: definition.mobile,
      screenHeight: definition.height,
      screenWidth: definition.width,
      width: definition.width,
    })
    await cdp.send('Emulation.setTouchEmulationEnabled', {
      enabled: definition.mobile,
      maxTouchPoints: definition.mobile ? 5 : 1,
    })
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${serverPort}/` })
    await cdp.waitFor(`
      Boolean(window.__nightBreachTest)
        && document.querySelector('#renderCanvas')?.dataset.sceneReady === 'true'
        && document.querySelector('#renderCanvas')?.dataset.firstFrameRendered === 'true'
        && document.querySelector('#renderCanvas')?.dataset.weaponSource !== 'loading'
        && document.querySelector('#renderCanvas')?.dataset.zombieSource
    `)
    await cdp.evaluate(`document.querySelector('#instructions').click()`)
    await cdp.waitFor(`window.__nightBreachTest.snapshot().deployed`)
    await delay(1_250)

    const winter = await cdp.evaluate(`(() => {
      const canvas = document.querySelector('#renderCanvas');
      const bounds = canvas.getBoundingClientRect();
      return {
        controls: getComputedStyle(document.querySelector('#mobileControls')).display,
        height: innerHeight,
        layoutHeight: bounds.height,
        layoutWidth: bounds.width,
        overflowX: document.documentElement.scrollWidth > innerWidth,
        overflowY: document.documentElement.scrollHeight > innerHeight,
        performanceTier: canvas.dataset.performanceTier,
        state: window.__nightBreachTest.snapshot().winter,
        width: innerWidth,
      };
    })()`)
    assert(
      winter.width === definition.width
        && winter.height === definition.height
        && winter.layoutWidth === definition.width
        && winter.layoutHeight === definition.height,
      `${definition.name} canvas did not fit its viewport: ${JSON.stringify(winter)}`,
    )
    assert(!winter.overflowX && !winter.overflowY,
      `${definition.name} introduced document overflow.`)
    assert(
      winter.state.enabled
        && winter.state.activeParticles > 0
        && winter.state.activeParticles <= winter.state.particleCapacity,
      `${definition.name} snow pool was invalid: ${JSON.stringify(winter.state)}`)
    assert(
      winter.state.particleCapacity === definition.expectedCapacity,
      `${definition.name} used ${winter.state.particleCapacity} flakes instead of ${definition.expectedCapacity}.`,
    )
    assert(
      definition.mobile ? winter.controls !== 'none' : winter.controls === 'none',
      `${definition.name} control layout did not match its input mode.`,
    )

    const screenshot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
    })
    const screenshotPath = join(artifactDirectory, `${definition.name}.png`)
    writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))

    const winterFrames = await cdp.evaluate(`new Promise((resolve) => {
      let frames = 0;
      const startedAt = performance.now();
      function sample(now) {
        frames += 1;
        if (now - startedAt >= 1200) {
          resolve({ elapsed: now - startedAt, fps: frames * 1000 / (now - startedAt), frames });
          return;
        }
        requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    })`)
    const normal = await cdp.evaluate(`window.__nightBreachTest.setWinterMode(false)`)
    assert(
      !normal.enabled && normal.activeParticles === 0
        && normal.fogStart === 24 && normal.fogEnd === 68
        && Math.abs(normal.exposure - 1.06) < 0.001
        && Math.abs(normal.contrast - 1.16) < 0.001
        && Math.abs(normal.skyLightIntensity - 0.82) < 0.001
        && Math.abs(normal.sunLightIntensity - 1.46) < 0.001,
      `${definition.name} could not restore normal mode: ${JSON.stringify(normal)}`,
    )
    const normalFrames = await cdp.evaluate(`new Promise((resolve) => {
      let frames = 0;
      const startedAt = performance.now();
      function sample(now) {
        frames += 1;
        if (now - startedAt >= 1200) {
          resolve({ elapsed: now - startedAt, fps: frames * 1000 / (now - startedAt), frames });
          return;
        }
        requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    })`)
    const restored = await cdp.evaluate(`window.__nightBreachTest.setWinterMode(true)`)
    assert(
      restored.enabled && restored.fogStart === 28 && restored.fogEnd === 72
        && Math.abs(restored.exposure - 1.04) < 0.001
        && Math.abs(restored.contrast - 1.26) < 0.001
        && Math.abs(restored.skyLightIntensity - 0.94) < 0.001
        && Math.abs(restored.sunLightIntensity - 1.62) < 0.001,
      `${definition.name} could not restore winter mode: ${JSON.stringify(restored)}`,
    )
    assert(cdp.errors.length === 0,
      `${definition.name} reported browser errors: ${cdp.errors.join(' | ')}`)
    return {
      name: definition.name,
      frameSample: { normal: normalFrames, winter: winterFrames },
      performanceTier: winter.performanceTier,
      screenshotPath,
      snow: winter.state,
    }
  } finally {
    cdp?.socket.close()
    browser.kill()
    await delay(150)
    try {
      rmSync(profilePath, { force: true, recursive: true })
    } catch {
      // Browser helper processes can briefly retain their profile.
    }
  }
}

const serverPort = await getFreePort()
const vitePath = join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js')
const server = spawn(process.execPath, [
  vitePath,
  '--host', '127.0.0.1',
  '--port', String(serverPort),
  '--strictPort',
], {
  cwd: projectRoot,
  stdio: 'ignore',
  windowsHide: true,
})

try {
  await waitForHttp(`http://127.0.0.1:${serverPort}/`)
  const results = []
  results.push(await validateViewport(serverPort, {
    expectedCapacity: 144,
    height: 720,
    mobile: false,
    name: 'desktop-1280x720',
    width: 1280,
  }))
  results.push(await validateViewport(serverPort, {
    expectedCapacity: 42,
    height: 390,
    mobile: true,
    name: 'mobile-844x390',
    width: 844,
  }))
  console.log(JSON.stringify({ winterValidation: results }, null, 2))
} finally {
  server.kill()
}
