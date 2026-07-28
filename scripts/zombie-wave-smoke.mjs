import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const firefoxPath = process.env.FIREFOX_PATH
  ?? 'C:\\Program Files\\Mozilla Firefox\\firefox.exe'
if (!existsSync(firefoxPath)) {
  throw new Error('Firefox was not found. Set FIREFOX_PATH to run the zombie wave smoke test.')
}

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

async function waitForHttp(url, timeout = 15_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // The local endpoint is still starting.
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
  socket.addEventListener('message', async (event) => {
    let rawMessage = event.data
    if (rawMessage instanceof Blob) rawMessage = await rawMessage.text()
    else if (rawMessage instanceof ArrayBuffer) {
      rawMessage = new TextDecoder().decode(rawMessage)
    }
    const message = JSON.parse(String(rawMessage))
    if (message.id === undefined) return
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
  })

  function send(method, params = {}) {
    nextId += 1
    const id = nextId
    return new Promise((resolveCommand, rejectCommand) => {
      const timeoutId = setTimeout(() => {
        pending.delete(id)
        rejectCommand(new Error(`WebDriver BiDi command timed out: ${method}`))
      }, 60_000)
      pending.set(id, { reject: rejectCommand, resolve: resolveCommand, timeoutId })
      socket.send(JSON.stringify({ id, method, params }))
    })
  }

  return { send, socket }
}

function horizontalDistance(first, second) {
  return Math.hypot(first.x - second.x, first.z - second.z)
}

const serverPort = await getFreePort()
const bidiPort = await getFreePort()
const profilePath = join(
  tmpdir(),
  `nightbreach-zombie-wave-${process.pid}-${Date.now()}`,
)
mkdirSync(profilePath, { recursive: true })
const firefoxEnvironment = { ...process.env }
if (process.env.NIGHTBREACH_DISABLE_FIREFOX_SANDBOX === '1') {
  Object.assign(firefoxEnvironment, {
    MOZ_DISABLE_CONTENT_SANDBOX: '1',
    MOZ_DISABLE_GMP_SANDBOX: '1',
    MOZ_DISABLE_GPU_SANDBOX: '1',
    MOZ_DISABLE_RDD_SANDBOX: '1',
    MOZ_DISABLE_SOCKET_PROCESS_SANDBOX: '1',
  })
}
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
  env: firefoxEnvironment,
  stdio: ['ignore', 'ignore', 'pipe'],
  windowsHide: true,
})
let firefoxDiagnostics = ''
firefoxProcess.stderr.on('data', (chunk) => {
  firefoxDiagnostics += String(chunk)
})

let bidi
try {
  const gameUrl = `http://127.0.0.1:${serverPort}`
  console.log('zombie-wave-smoke: starting local browser session')
  await Promise.all([
    waitForHttp(gameUrl),
    waitForHttp(`http://127.0.0.1:${bidiPort}`),
  ])
  bidi = await connectBidi(`ws://127.0.0.1:${bidiPort}/session`)
  await bidi.send('session.new', { capabilities: {} })
  const tree = await bidi.send('browsingContext.getTree')
  const context = tree.contexts[0]?.context
  if (!context) throw new Error('Firefox did not expose a browsing context.')
  await bidi.send('browsingContext.setViewport', {
    context,
    devicePixelRatio: 1,
    viewport: { height: 720, width: 1280 },
  })
  await bidi.send('browsingContext.navigate', {
    context,
    url: gameUrl,
    wait: 'none',
  })

  async function evaluate(expression) {
    const result = await bidi.send('script.evaluate', {
      awaitPromise: true,
      expression: `JSON.stringify(${expression})`,
      resultOwnership: 'none',
      target: { context },
    })
    if (result.type === 'exception') {
      throw new Error(result.exceptionDetails?.text ?? 'Firefox evaluation failed.')
    }
    const serialized = result.result?.value
    return serialized === undefined ? undefined : JSON.parse(serialized)
  }

  async function waitForExpression(expression, timeout = 15_000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return
      await delay(50)
    }
    throw new Error(`Timed out waiting for expression: ${expression}`)
  }

  await waitForExpression(`
    Boolean(window.__nightBreachTest)
      && document.querySelector('#renderCanvas')?.dataset.sceneReady === 'true'
      && Boolean(document.querySelector('#renderCanvas')?.dataset.zombieSource)
  `, 60_000)

  // Face away from the first spawn candidate so it passes the existing
  // off-camera safety rule while remaining beyond the former 28-unit detector.
  await evaluate(`(() => {
    window.__nightBreachTest.setCameraRotation(0, Math.PI);
    window.__nightBreachTest.deferNextZombieSpawns(1);
    document.querySelector('#instructions').click();
    return true;
  })()`)
  await waitForExpression(`
    window.__nightBreachTest.snapshot().deployed
      && window.__nightBreachTest.snapshot().wave.currentWave === 1
  `)
  await delay(250)
  const deferred = await evaluate('window.__nightBreachTest.snapshot()')
  assert(deferred.wave.status === 'active' && deferred.wave.spawnedZombies === 0,
    `The controlled deferred spawn changed wave counters: ${JSON.stringify(deferred.wave)}`)
  console.log('zombie-wave-smoke: deferred spawn left counters pending for retry')

  let previousMaximumId = 0
  const waveResults = []
  for (let waveNumber = 1; waveNumber <= 3; waveNumber += 1) {
    await waitForExpression(`
      window.__nightBreachTest.snapshot().wave.currentWave === ${waveNumber}
        && window.__nightBreachTest.snapshot().wave.status === 'active'
    `, 20_000)

    const observed = new Map()
    const spawnDeadline = Date.now() + 20_000
    let completedSpawnSnapshot
    while (Date.now() < spawnDeadline) {
      const snapshot = await evaluate('window.__nightBreachTest.snapshot()')
      const waveZombies = snapshot.zombies.filter((zombie) =>
        zombie.id > previousMaximumId && !zombie.disposed && zombie.state !== 'dead')
      for (const zombie of waveZombies) {
        assert(zombie.hasPlayerTarget,
          `Wave ${waveNumber} zombie ${zombie.id} spawned without a player target.`)
        assert(zombie.state === 'chasing' || zombie.state === 'attacking',
          `Wave ${waveNumber} zombie ${zombie.id} spawned in ${zombie.state}.`)
        if (!observed.has(zombie.id)) {
          observed.set(zombie.id, { ...zombie.position })
        }
      }
      if (snapshot.wave.spawnedZombies === snapshot.wave.scheduledZombies) {
        completedSpawnSnapshot = snapshot
        break
      }
      await delay(40)
    }
    assert(completedSpawnSnapshot,
      `Wave ${waveNumber} did not finish spawning within the test deadline.`)
    assert(observed.size === completedSpawnSnapshot.wave.scheduledZombies,
      `Wave ${waveNumber} observed ${observed.size}/${completedSpawnSnapshot.wave.scheduledZombies} spawns.`)

    const farSpawnIds = [...observed].filter(([, position]) =>
      horizontalDistance(position, completedSpawnSnapshot.cameraPosition) > 28)
      .map(([id]) => id)
    assert(farSpawnIds.length > 0,
      `Wave ${waveNumber} did not produce a spawn beyond the former detection radius.`)

    await delay(700)
    const movedSnapshot = await evaluate('window.__nightBreachTest.snapshot()')
    for (const [zombieId, spawnPosition] of observed) {
      const zombie = movedSnapshot.zombies.find((candidate) => candidate.id === zombieId)
      assert(zombie && zombie.hasPlayerTarget,
        `Wave ${waveNumber} zombie ${zombieId} lost its player target.`)
      const displacement = horizontalDistance(spawnPosition, zombie.position)
      assert(displacement > 0.05,
        `Wave ${waveNumber} zombie ${zombieId} stayed idle (${displacement.toFixed(3)} moved).`)
    }

    waveResults.push({
      farSpawnIds,
      scheduled: completedSpawnSnapshot.wave.scheduledZombies,
      wave: waveNumber,
    })
    previousMaximumId = Math.max(...observed.keys())
    const eliminated = await evaluate('window.__nightBreachTest.eliminateLivingZombies()')
    assert(eliminated === completedSpawnSnapshot.wave.scheduledZombies,
      `Wave ${waveNumber} eliminated ${eliminated}/${completedSpawnSnapshot.wave.scheduledZombies}.`)
    await waitForExpression(`
      window.__nightBreachTest.snapshot().wave.currentWave > ${waveNumber}
        || window.__nightBreachTest.snapshot().wave.status === 'complete'
    `)
  }

  console.log(`zombie-wave-smoke: passed ${JSON.stringify(waveResults)}`)
} catch (error) {
  if (firefoxDiagnostics) console.error(firefoxDiagnostics)
  throw error
} finally {
  bidi?.socket.close()
  firefoxProcess.kill()
  serverProcess.kill()
  try {
    rmSync(profilePath, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 })
  } catch (error) {
    console.warn(`zombie-wave-smoke: temporary profile cleanup deferred (${error.message})`)
  }
}
