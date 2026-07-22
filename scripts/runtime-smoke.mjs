import { spawn } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const forceRifleFallback = process.env.NIGHTBREACH_FORCE_RIFLE_FALLBACK === '1'
const forceZombieFallback = process.env.NIGHTBREACH_FORCE_ZOMBIE_FALLBACK === '1'
const expectedWeaponSource = forceRifleFallback ? 'procedural' : 'glb'
const expectedZombieSource = forceZombieFallback ? 'procedural' : 'glb'
const screenshotPath = process.env.NIGHTBREACH_SCREENSHOT_PATH
const viewportWidth = Number(process.env.NIGHTBREACH_VIEWPORT_WIDTH ?? 844)
const viewportHeight = Number(process.env.NIGHTBREACH_VIEWPORT_HEIGHT ?? 390)
const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean)
const chromePath = chromeCandidates.find((candidate) => existsSync(candidate))

if (!chromePath) {
  throw new Error('Chrome or Edge was not found. Set CHROME_PATH to run the runtime smoke test.')
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
      // The local server is still starting.
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
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`)
      const targets = await response.json()
      page = targets.find((target) => target.type === 'page')
      if (page) break
    } catch {
      // Chrome is still starting.
    }
    await delay(100)
  }
  if (!page) throw new Error('Timed out waiting for the Chrome DevTools endpoint.')

  const socket = new WebSocket(page.webSocketDebuggerUrl)
  socket.binaryType = 'arraybuffer'
  await new Promise((resolveSocket, rejectSocket) => {
    socket.addEventListener('open', resolveSocket, { once: true })
    socket.addEventListener('error', () => {
      rejectSocket(new Error(`Could not open ${page.webSocketDebuggerUrl}`))
    }, { once: true })
  })

  let commandId = 0
  const pending = new Map()
  const consoleErrors = []

  socket.addEventListener('message', async (event) => {
    let rawMessage = event.data
    if (rawMessage instanceof Blob) rawMessage = await rawMessage.text()
    else if (rawMessage instanceof ArrayBuffer) {
      rawMessage = new TextDecoder().decode(rawMessage)
    }
    const message = JSON.parse(String(rawMessage))
    if (message.id) {
      const command = pending.get(message.id)
      if (!command) return
      pending.delete(message.id)
      clearTimeout(command.timeoutId)
      if (message.error) command.reject(new Error(message.error.message))
      else command.resolve(message.result)
      return
    }

    if (message.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(message.params.exceptionDetails.text)
    } else if (message.method === 'Runtime.consoleAPICalled'
      && message.params.type === 'error') {
      consoleErrors.push(message.params.args.map((argument) =>
        argument.value ?? argument.description ?? '').join(' '))
    } else if (message.method === 'Log.entryAdded'
      && message.params.entry.level === 'error') {
      consoleErrors.push(message.params.entry.text)
    }
  })
  socket.addEventListener('close', () => {
    for (const command of pending.values()) {
      clearTimeout(command.timeoutId)
      command.reject(new Error('The Chrome DevTools socket closed unexpectedly.'))
    }
    pending.clear()
  })

  function send(method, params = {}) {
    commandId += 1
    const id = commandId
    return new Promise((resolveCommand, rejectCommand) => {
      const timeoutId = setTimeout(() => {
        pending.delete(id)
        rejectCommand(new Error(`CDP command timed out: ${method}`))
      }, 30_000)
      pending.set(id, { reject: rejectCommand, resolve: resolveCommand, timeoutId })
      socket.send(JSON.stringify({ id, method, params }))
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

  async function waitForExpression(expression, timeout = 10_000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return
      await delay(50)
    }
    throw new Error(`Timed out waiting for expression: ${expression}`)
  }

  return { consoleErrors, evaluate, send, socket, waitForExpression }
}

const pointerHelpers = `
  const emit = (selector, type, pointerId, x, y) => {
    const element = document.querySelector(selector);
    element.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      isPrimary: pointerId === 11,
      pointerId,
      pointerType: 'touch',
    }));
  };
  const center = (selector) => {
    const bounds = document.querySelector(selector).getBoundingClientRect();
    return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
  };
`

const serverPort = await getFreePort()
const debugPort = await getFreePort()
const profilePath = join(tmpdir(), `nightbreach-smoke-${process.pid}`)
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
  '--no-first-run',
  '--no-default-browser-check',
  '--enable-unsafe-swiftshader',
  '--remote-allow-origins=*',
  '--use-angle=swiftshader',
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${profilePath}`,
  `--window-size=${viewportWidth},${viewportHeight}`,
  'about:blank',
], {
  stdio: ['ignore', 'ignore', 'pipe'],
  windowsHide: true,
})
let chromeDiagnostics = ''
chromeProcess.stderr.on('data', (chunk) => {
  chromeDiagnostics += String(chunk)
})

let cdp
try {
  const gameUrl = `http://127.0.0.1:${serverPort}`
  console.log('runtime-smoke: starting local browser session')
  await waitForHttp(gameUrl)
  cdp = await connectCdp(debugPort)
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')
  await cdp.send('Page.enable')
  if (forceRifleFallback || forceZombieFallback) {
    await cdp.send('Network.enable')
    const blockedUrls = []
    if (forceRifleFallback) blockedUrls.push('*assets/weapons/ak74m_fps.glb*')
    if (forceZombieFallback) blockedUrls.push('*assets/zombies/zombie_basic.glb*')
    await cdp.send('Network.setBlockedURLs', {
      urls: blockedUrls,
    })
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    deviceScaleFactor: 2,
    height: viewportHeight,
    mobile: true,
    screenHeight: viewportHeight,
    screenWidth: viewportWidth,
    width: viewportWidth,
  })
  await cdp.send('Emulation.setTouchEmulationEnabled', {
    enabled: true,
    maxTouchPoints: 5,
  })
  await cdp.send('Page.navigate', { url: gameUrl })
  try {
    await cdp.waitForExpression(`
      Boolean(window.__nightBreachTest)
        && document.querySelector('#renderCanvas')?.dataset.sceneReady === 'true'
        && document.querySelector('#renderCanvas')?.dataset.mapReady === 'true'
        && document.querySelector('#renderCanvas')?.dataset.firstFrameRendered === 'true'
        && document.querySelector('#renderCanvas')?.dataset.renderLoop === 'running'
        && document.querySelector('#renderCanvas')?.dataset.weaponSource === '${expectedWeaponSource}'
        && document.querySelector('#renderCanvas')?.dataset.rifleReady === '${expectedWeaponSource}'
        && document.querySelector('#renderCanvas')?.dataset.zombieSource === '${expectedZombieSource}'
        && window.__nightBreachTest.snapshot().zombies.length === 3
    `, 60_000)
  } catch (error) {
    const readiness = await cdp.evaluate(`({
      canvas: { ...document.querySelector('#renderCanvas')?.dataset },
      snapshot: window.__nightBreachTest?.snapshot?.(),
    })`)
    console.error(`runtime-smoke: readiness diagnostics ${JSON.stringify(readiness)}`)
    throw error
  }
  console.log('runtime-smoke: scene and assets ready')

  const startup = await cdp.evaluate(`({
    active: document.querySelector('#renderCanvas').dataset.activeZombieCount,
    firstFrame: document.querySelector('#renderCanvas').dataset.firstFrameRendered,
    limit: document.querySelector('#renderCanvas').dataset.zombieLimit,
    mapReady: document.querySelector('#renderCanvas').dataset.mapReady,
    performanceTier: document.querySelector('#renderCanvas').dataset.performanceTier,
    renderLoop: document.querySelector('#renderCanvas').dataset.renderLoop,
    rifleReady: document.querySelector('#renderCanvas').dataset.rifleReady,
    sharing: document.querySelector('#renderCanvas').dataset.zombieSharing,
    source: document.querySelector('#renderCanvas').dataset.zombieSource,
    state: window.__nightBreachTest.snapshot(),
    weaponSource: document.querySelector('#renderCanvas').dataset.weaponSource,
  })`)
  assert(startup.source === expectedZombieSource,
    `Zombie source did not resolve to ${expectedZombieSource}: ${startup.source}.`)
  assert(startup.limit === '3' && startup.active === '3', 'The active zombie cap is not three.')
  assert(startup.performanceTier.startsWith('mobile'), 'Mobile emulation did not select a mobile tier.')
  assert(startup.mapReady === 'true' && startup.firstFrame === 'true',
    'The procedural map or first rendered frame was not ready.')
  assert(startup.renderLoop === 'running', 'The render loop did not start immediately.')
  assert(startup.weaponSource === expectedWeaponSource
    && startup.rifleReady === expectedWeaponSource,
  forceRifleFallback
    ? 'A failed rifle request did not preserve the procedural fallback.'
    : 'The validated local rifle did not replace its procedural fallback.')
  assert(startup.state.visibleRifleHierarchies === 1,
    'The scene does not contain exactly one visible rifle hierarchy.')
  if (forceRifleFallback) {
    assert(startup.state.weaponActiveAnimation === 'procedural',
      'The procedural fallback did not remain active after blocking the GLB.')
  } else {
    const expectedClips = [
      'Repose', 'Idle', 'Shot', 'Draw', 'Not_Draw', 'Start_Jump', 'Loop_Jump',
      'Stop_Jump', 'Start_Walk', 'Walk', 'Stop_Walk', 'Reload_Fast', 'Reload_Complete',
    ]
    assert(startup.state.weaponSkeletonCount === 1 && startup.state.weaponBoneCount === 59,
      `The imported FPS rig changed: ${startup.state.weaponSkeletonCount} skeletons/${startup.state.weaponBoneCount} bones.`)
    assert(startup.state.weaponMeshCount === 4
      && startup.state.weaponSkinnedMeshCount === 4
      && startup.state.weaponHierarchyNodeCount >= 72,
    `The complete rifle hierarchy was not preserved: ${startup.state.weaponMeshCount} meshes/${startup.state.weaponSkinnedMeshCount} skinned/${startup.state.weaponHierarchyNodeCount} nodes.`)
    assert(startup.state.weaponClipNames.split(',').join('|') === expectedClips.join('|'),
      `The imported animation clips changed: ${startup.state.weaponClipNames}`)
    assert(startup.state.weaponActiveAnimation === 'Idle',
      `The imported rifle did not start its idle clip: ${startup.state.weaponActiveAnimation}`)
    assert(await cdp.evaluate(`document.querySelector('#renderCanvas').dataset.proceduralRifle === 'disposed'`),
      'The procedural rifle was not removed after the AK-74M rendered successfully.')
  }
  if (forceZombieFallback) {
    assert(startup.sharing === 'shared-geometry-materials',
      'Procedural sharing metadata is incorrect.')
    assert(await cdp.evaluate(`window.__nightBreachTest.verifyProceduralSharing()`),
      'Procedural zombie geometry or materials were not actually shared.')
  } else {
    assert(startup.sharing === 'cloned-skeletons-shared-geometry-materials-textures',
      `Imported zombie clone metadata is incorrect: ${startup.sharing}.`)
    assert(startup.state.zombieSkeletonCount === 1 && startup.state.zombieBoneCount === 34,
      `The zombie rig changed: ${startup.state.zombieSkeletonCount} skeletons/${startup.state.zombieBoneCount} bones.`)
    assert(startup.state.zombieMeshCount === 5 && startup.state.zombieSkinnedMeshCount === 5,
      `The zombie skin changed: ${startup.state.zombieMeshCount} meshes/${startup.state.zombieSkinnedMeshCount} skinned.`)
    assert(startup.state.zombieClipNames === 'Attack1.001,Idle,Walk1',
      `The zombie clips changed: ${startup.state.zombieClipNames}.`)
    assert(startup.state.zombieAnimationMapping
      === 'idle:Idle,walk:Walk1,run:Walk1,attack:Attack1.001,hit:hit-root-fallback,death:death-root-fallback',
    `The zombie animation mapping changed: ${startup.state.zombieAnimationMapping}.`)
    assert(startup.state.zombieFinalRotation === '0.000000,0.000000,0.000000'
      && Math.abs(startup.state.zombieFinalScale - 1.387821) < 0.00001,
    `The zombie parent transform changed: scale=${startup.state.zombieFinalScale}, rotation=${startup.state.zombieFinalRotation}.`)
    assert(startup.state.zombies.every((zombie) => zombie.animation.endsWith('_Idle')),
      `Imported zombies did not start independent Idle clips: ${JSON.stringify(startup.state.zombies)}.`)
    assert(await cdp.evaluate(`window.__nightBreachTest.verifyZombieCloneIsolation()`),
      'Zombie instances did not preserve independent skeletons with shared render resources.')
    console.log(`runtime-smoke: zombie rig ${JSON.stringify({
      animations: startup.state.zombieAnimationMapping,
      clips: startup.state.zombieClipNames,
      rotation: startup.state.zombieFinalRotation,
      scale: startup.state.zombieFinalScale,
    })}`)
  }
  assert(startup.state.health === 100, 'Player health did not start at 100.')
  if (screenshotPath) {
    const screenshot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
    })
    writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  }

  await cdp.evaluate(`document.querySelector('#instructions').click()`)
  const beforeMovement = await cdp.evaluate(`window.__nightBreachTest.snapshot()`)
  assert(beforeMovement.deployed && beforeMovement.renderLoop === 'running',
    'Click to deploy did not activate gameplay while keeping the render loop active.')
  assert(await cdp.evaluate(`document.querySelector('#instructions') === null`),
    'The deploy overlay was not removed after activation.')
  if (screenshotPath) {
    await delay(150)
    const deployedScreenshot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
    })
    writeFileSync(`${screenshotPath}.deployed.png`, Buffer.from(deployedScreenshot.data, 'base64'))
  }
  await cdp.evaluate(`(() => {
    ${pointerHelpers}
    const movement = center('#movementControl');
    emit('#movementControl', 'pointerdown', 11, movement.x, movement.y);
    emit('#movementControl', 'pointermove', 11, movement.x + 28, movement.y - 20);
    emit('#lookArea', 'pointerdown', 12, 610, 190);
    emit('#lookArea', 'pointermove', 12, 662, 168);
  })()`)
  console.log('runtime-smoke: simultaneous joystick and swipe passed')
  const simultaneousInput = await cdp.evaluate(`window.__nightBreachTest.snapshot()`)
  assert(simultaneousInput.movementPointerId === 11 && simultaneousInput.aimPointerId === 12,
    'Joystick and swipe aiming were not active simultaneously.')
  assert(Math.abs(simultaneousInput.moveInputX) + Math.abs(simultaneousInput.moveInputY) > 0.1,
    'Joystick movement did not produce movement input.')
  assert(Math.abs(simultaneousInput.cameraYaw - beforeMovement.cameraYaw) > 0.05,
    'Swipe aiming did not rotate the camera.')
  await cdp.evaluate(`(() => {
    ${pointerHelpers}
    emit('#lookArea', 'pointerup', 12, 662, 168);
  })()`)
  const joystickStillHeld = await cdp.evaluate(`window.__nightBreachTest.snapshot()`)
  assert(joystickStillHeld.movementPointerId === 11 && joystickStillHeld.aimPointerId === null,
    'Ending swipe aim incorrectly cancelled the joystick.')
  await cdp.evaluate(`(() => {
    ${pointerHelpers}
    const movement = center('#movementControl');
    emit('#movementControl', 'pointerup', 11, movement.x + 28, movement.y - 20);
  })()`)

  await cdp.evaluate(`(() => {
    ${pointerHelpers}
    const ads = center('#adsButton');
    const fire = center('#fireButton');
    emit('#adsButton', 'pointerdown', 21, ads.x, ads.y);
    emit('#fireButton', 'pointerdown', 22, fire.x, fire.y);
  })()`)
  await cdp.waitForExpression(
    `Number(window.__nightBreachTest.snapshot().ammo.split('/')[0]) <= 28`,
    5_000,
  )
  const heldFire = await cdp.evaluate(`window.__nightBreachTest.snapshot()`)
  assert(heldFire.adsHeld && heldFire.automaticFireHeld, 'ADS and hold-to-fire did not remain active together.')
  assert(Number(heldFire.ammo.split('/')[0]) <= 28, 'Hold-to-fire did not fire repeatedly.')
  await cdp.evaluate(`(() => {
    ${pointerHelpers}
    const ads = center('#adsButton');
    const fire = center('#fireButton');
    emit('#fireButton', 'pointerup', 22, fire.x, fire.y);
    emit('#adsButton', 'pointerup', 21, ads.x, ads.y);
    const reload = center('#reloadButton');
    emit('#reloadButton', 'pointerdown', 23, reload.x, reload.y);
  })()`)
  await cdp.waitForExpression(`
    window.__nightBreachTest.snapshot().ammo.startsWith('30/')
      && window.__nightBreachTest.snapshot().reloadElapsed < 0
  `, 10_000)
  const reloaded = await cdp.evaluate(`window.__nightBreachTest.snapshot()`)
  assert(reloaded.ammo.startsWith('30/'), 'Reload did not restore the magazine.')
  assert(Number(reloaded.ammo.split('/')[1]) < 120, 'Reload did not consume reserve ammunition.')
  console.log('runtime-smoke: hold-fire, ADS, and reload passed')

  const initialPositions = startup.state.zombies.map((zombie) => zombie.position)
  await delay(500)
  const chasing = await cdp.evaluate(`window.__nightBreachTest.snapshot()`)
  assert(chasing.zombies.some((zombie) => zombie.state === 'chasing' || zombie.state === 'attacking'),
    'No zombie detected and pursued the player.')
  assert(chasing.zombies.some((zombie, index) =>
    Math.abs(zombie.position.x - initialPositions[index].x)
      + Math.abs(zombie.position.z - initialPositions[index].z) > 0.05),
  'Zombie chasing did not change a zombie position.')
  if (!forceZombieFallback) {
    assert(chasing.zombies.some((zombie) => zombie.animation.endsWith('_Walk1')),
      `Zombie chase did not select Walk1: ${JSON.stringify(chasing.zombies)}.`)
    assert(await cdp.evaluate(`window.__nightBreachTest.zombieFacingDot(2) > 0.8`),
      'The imported zombie visual did not face the player while chasing.')
  }
  console.log('runtime-smoke: detection and chase passed')

  await cdp.evaluate(`(() => {
    const api = window.__nightBreachTest;
    api.setPlayerPosition(8, 2);
    api.setZombiePosition(0, 8, -7);
    api.setZombiePosition(1, -23, -23);
    api.setZombiePosition(2, 23, -23);
  })()`)
  await delay(1_800)
  const avoidedObstacle = await cdp.evaluate(`window.__nightBreachTest.snapshot()`)
  assert(Math.abs(avoidedObstacle.zombies[0].position.x - 8) > 0.04,
    'Zombie obstacle steering did not produce lateral avoidance.')
  console.log('runtime-smoke: obstacle avoidance passed')

  const healthBeforeAttack = avoidedObstacle.health
  await cdp.evaluate(`(() => {
    const api = window.__nightBreachTest;
    api.setPlayerPosition(0, 0);
    api.setZombiePosition(0, -23, 23);
    api.setZombiePosition(1, 0, 1.3);
    api.setZombiePosition(2, 23, 23);
  })()`)
  await cdp.waitForExpression(
    `window.__nightBreachTest.snapshot().health < ${healthBeforeAttack}`,
    7_000,
  )
  const firstAttack = await cdp.evaluate(`(() => {
    const snapshot = window.__nightBreachTest.snapshot();
    const facingDot = window.__nightBreachTest.zombieFacingDot(1);
    window.__nightBreachTest.setZombiePosition(1, -23, 23);
    return { snapshot, facingDot };
  })()`)
  const attackDamage = healthBeforeAttack - firstAttack.snapshot.health
  assert(attackDamage >= 14 && attackDamage % 14 === 0,
    `A zombie attack did not apply configured 14-point damage: ${attackDamage}.`)
  if (!forceZombieFallback) {
    assert(firstAttack.snapshot.zombies[1].animation.endsWith('_Attack1.001'),
      `Zombie attack did not select Attack1.001: ${JSON.stringify(firstAttack.snapshot.zombies[1])}.`)
    assert(firstAttack.facingDot > 0.95,
      'The imported zombie visual did not face the player while attacking.')
  }
  await delay(200)
  const afterDamageWindow = await cdp.evaluate(`window.__nightBreachTest.snapshot()`)
  assert(afterDamageWindow.health === firstAttack.snapshot.health,
    'One zombie swing applied damage more than once.')
  console.log('runtime-smoke: attack timing and damage window passed')

  await cdp.evaluate(`(() => {
    const api = window.__nightBreachTest;
    api.setPlayerPosition(0, -10);
    api.setZombiePosition(0, 0, -5);
    api.setZombiePosition(1, -23, 23);
    api.setZombiePosition(2, 23, 23);
    api.setCameraRotation(0.2, 0);
  })()`)
  const bodyProbe = await cdp.evaluate(`window.__nightBreachTest.probeAim()`)
  assert(bodyProbe.zone === 'torso', `Body-shot aim probe missed the torso: ${JSON.stringify(bodyProbe)}`)
  if (screenshotPath) {
    const zombieScreenshot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
    })
    writeFileSync(`${screenshotPath}.zombie.png`, Buffer.from(zombieScreenshot.data, 'base64'))
  }
  const bodyHitMarkerVisible = await cdp.evaluate(`(() => {
    window.__nightBreachTest.hitZombie(0, 'torso');
    return document.querySelector('#hitMarker').classList.contains('visible');
  })()`)
  assert(bodyHitMarkerVisible,
    'Body shot did not display the hit marker.')
  const bodyHit = await cdp.evaluate(`window.__nightBreachTest.snapshot()`)
  assert(bodyHit.zombies[0].health === 66 && bodyHit.zombies[0].state === 'hit',
    `Body-shot damage or hit reaction failed: ${JSON.stringify({ ammo: bodyHit.ammo, zombie: bodyHit.zombies[0] })}`)
  if (!forceZombieFallback) {
    assert(bodyHit.zombies[0].animation === 'hit-root-fallback',
      `Zombie hit did not select the parent-root fallback: ${JSON.stringify(bodyHit.zombies[0])}.`)
  }
  console.log('runtime-smoke: body shot and hit reaction passed')

  await delay(250)
  const headshotIndicatorVisible = await cdp.evaluate(`(() => {
    const api = window.__nightBreachTest;
    api.setZombiePosition(0, 0, -5);
    api.setCameraRotation(0.015, 0);
    api.hitZombie(0, 'head');
    return document.querySelector('#headshotIndicator').classList.contains('visible');
  })()`)
  assert(headshotIndicatorVisible,
    'Headshot indicator was not shown.')
  const headHit = await cdp.evaluate(`window.__nightBreachTest.snapshot()`)
  assert(headHit.zombies[0].health === 1, 'Headshot damage failed.')
  console.log('runtime-smoke: headshot passed')

  await delay(250)
  await cdp.evaluate(`(() => {
    const api = window.__nightBreachTest;
    api.setZombiePosition(0, 0, -5);
    api.setCameraRotation(0.2, 0);
    api.hitZombie(0, 'torso');
  })()`)
  const deadZombie = await cdp.evaluate(`window.__nightBreachTest.snapshot()`)
  assert(deadZombie.zombies[0].health === 0 && deadZombie.zombies[0].state === 'dead',
    'Zombie death did not follow lethal damage.')
  if (!forceZombieFallback) {
    assert(deadZombie.zombies[0].animation === 'death-root-fallback',
      `Zombie death did not select the parent-root fallback: ${JSON.stringify(deadZombie.zombies[0])}.`)
  }
  await cdp.waitForExpression(`
    window.__nightBreachTest.snapshot().activeZombieCount === 2
      && window.__nightBreachTest.snapshot().zombies[0].disposed
  `, 20_000)
  const cleanedUp = await cdp.evaluate(`window.__nightBreachTest.snapshot()`)
  assert(cleanedUp.activeZombieCount === 2 && cleanedUp.zombies[0].disposed,
    'Dead zombie cleanup did not release the zombie visual and collider.')
  console.log('runtime-smoke: death and cleanup passed')

  await cdp.evaluate(`window.__nightBreachTest.damagePlayer(100, 1)`)
  const playerDeath = await cdp.evaluate(`window.__nightBreachTest.snapshot()`)
  assert(playerDeath.health === 0 && playerDeath.gameOver, 'Player death state failed.')
  assert(await cdp.evaluate(`document.body.classList.contains('game-over')`),
    'Retry overlay did not open after player death.')
  await cdp.evaluate(`document.querySelector('#retryButton').click()`)
  try {
    await cdp.waitForExpression(`(() => {
      const state = window.__nightBreachTest.snapshot();
      return state.health === 100
        && state.ammo === '30/120'
        && !state.gameOver
        && state.activeZombieCount === 3
        && state.zombies.length === 3;
    })()`, 10_000)
  } catch (error) {
    const retrySnapshot = await cdp.evaluate(`window.__nightBreachTest.snapshot()`)
    console.error(`runtime-smoke: retry diagnostics ${JSON.stringify({
      consoleErrors: cdp.consoleErrors,
      snapshot: retrySnapshot,
    })}`)
    throw error
  }
  const retried = await cdp.evaluate(`window.__nightBreachTest.snapshot()`)
  assert(retried.health === 100 && retried.ammo === '30/120' && !retried.gameOver,
    'Retry did not reset player health and ammunition.')
  assert(retried.activeZombieCount === 3
    && retried.zombies.length === 3
    && retried.zombies.every((zombie) => zombie.health === 100 && !zombie.disposed),
  'Retry did not restore all zombie states.')
  console.log('runtime-smoke: player death and retry reset passed')

  await cdp.evaluate(`window.dispatchEvent(new Event('blur'))`)
  const mobileBlur = await cdp.evaluate(`window.__nightBreachTest.snapshot()`)
  assert(mobileBlur.webViewActive,
    'A visible mobile page was incorrectly paused by a browser-chrome blur.')
  await cdp.evaluate(`window.dispatchEvent(new PageTransitionEvent('pagehide'))`)
  const inactive = await cdp.evaluate(`window.__nightBreachTest.snapshot()`)
  assert(!inactive.webViewActive, 'Page hide did not pause the WebView lifecycle.')
  await cdp.evaluate(`window.dispatchEvent(new PageTransitionEvent('pageshow'))`)
  const activeAgain = await cdp.evaluate(`window.__nightBreachTest.snapshot()`)
  assert(activeAgain.webViewActive, 'Page show did not resume the WebView lifecycle.')
  console.log('runtime-smoke: inactive WebView pause/resume passed')

  assert(cdp.consoleErrors.length === 0,
    `Browser console errors were reported: ${cdp.consoleErrors.join(' | ')}`)

  console.log(JSON.stringify({
    browserConsoleErrors: cdp.consoleErrors.length,
    zombie: startup.source,
    multitouch: 'joystick + swipe + ADS + hold-fire passed',
    performanceTier: startup.performanceTier,
    rifle: startup.weaponSource,
    startup: 'map + first frame + render loop + deploy passed',
    sharing: startup.sharing,
    zombieCombat: 'detection, chase, avoidance, attack, hit zones, death, cleanup passed',
    playerLoop: 'damage, death, retry, health/ammo/zombie reset passed',
  }, null, 2))
} catch (error) {
  if (chromeDiagnostics) console.error(chromeDiagnostics)
  throw error
} finally {
  cdp?.socket.close()
  chromeProcess.kill()
  serverProcess.kill()
  await delay(150)
  try {
    rmSync(profilePath, {
      force: true,
      maxRetries: 10,
      recursive: true,
      retryDelay: 100,
    })
  } catch (error) {
    // A Chrome crashpad helper can briefly retain a profile file after the
    // browser exits. Test success must not be converted into a false failure
    // by best-effort temporary-directory cleanup.
    console.warn(`runtime-smoke: temporary profile cleanup deferred (${error.message})`)
  }
}
