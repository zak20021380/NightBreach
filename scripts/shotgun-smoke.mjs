// Focused runtime validation for the pump-action shotgun combat phase.
// Shares the CDP scaffolding style of runtime-smoke.mjs and drives the game
// twice: a desktop pass (keys 1/2/R + mouse fire) covering ammo, pellets,
// falloff, walls, knockback, reload, interruption, leak and restart rules, and
// a mobile pass covering the touch fire/reload/switch buttons.
import { spawn } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const screenshotDirectory = process.env.NIGHTBREACH_SHOTGUN_SCREENSHOT_DIR
const chromeCandidates = [
  process.env.CHROME_PATH,
  '/opt/pw-browsers/chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean)
const chromePath = chromeCandidates.find((candidate) => existsSync(candidate))
if (!chromePath) {
  throw new Error('Chrome/Chromium was not found. Set CHROME_PATH to run the shotgun smoke test.')
}

const SHOT_CLIP = 'Armature|SG_FPS_Shot'
const IDLE_CLIP = 'Armature|SG_FPS_Idle'
const WALK_CLIP = 'Armature|SG_FPS_Walk'
const RELOAD_CLIP = 'Armature|SG_FPS_Reload'

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

async function waitForHttp(url, timeout = 20_000) {
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
  const deadline = Date.now() + 20_000
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
      }, 45_000)
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

  async function waitForExpression(expression, timeout = 15_000, label = expression) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return
      await delay(50)
    }
    throw new Error(`Timed out waiting for: ${label}`)
  }

  return { consoleErrors, evaluate, send, socket, waitForExpression }
}

async function launchSession({ mobile }) {
  const serverPort = await getFreePort()
  const debugPort = await getFreePort()
  const profilePath = join(tmpdir(), `nightbreach-shotgun-${process.pid}-${mobile ? 'mobile' : 'desktop'}`)
  const vitePath = join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js')
  const serverProcess = spawn(process.execPath, [
    vitePath,
    '--host', '127.0.0.1',
    '--port', String(serverPort),
    '--strictPort',
  ], { cwd: projectRoot, stdio: 'ignore', windowsHide: true })
  const chromeArguments = [
    '--headless=new',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--enable-unsafe-swiftshader',
    '--remote-allow-origins=*',
    '--use-angle=swiftshader',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profilePath}`,
    '--window-size=1280,720',
  ]
  if (!mobile) {
    // Headless Chromium reports no hover-capable fine pointer, which the game
    // reads as "not a desktop" and disables its key/click bindings. These
    // blink settings restore a mouse-class pointing device.
    chromeArguments.push(
      '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4',
    )
  }
  chromeArguments.push('about:blank')
  const chromeProcess = spawn(chromePath, chromeArguments,
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  let chromeDiagnostics = ''
  chromeProcess.stderr.on('data', (chunk) => {
    chromeDiagnostics += String(chunk)
  })

  const gameUrl = `http://127.0.0.1:${serverPort}`
  await waitForHttp(gameUrl)
  const cdp = await connectCdp(debugPort)
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')
  await cdp.send('Page.enable')
  if (mobile) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      deviceScaleFactor: 2,
      height: 390,
      mobile: true,
      screenHeight: 390,
      screenWidth: 844,
      width: 844,
    })
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  } else {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      deviceScaleFactor: 1,
      height: 720,
      mobile: false,
      screenHeight: 720,
      screenWidth: 1280,
      width: 1280,
    })
    // Desktop keyboard/mouse input is gated on webViewActive, and a headless
    // page starts blurred, which the game treats as a backgrounded desktop
    // browser. Focus emulation keeps the page "focused" for the whole pass.
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  }
  await cdp.send('Page.navigate', { url: gameUrl })
  await cdp.waitForExpression(`
    Boolean(window.__nightBreachTest)
      && document.querySelector('#renderCanvas')?.dataset.sceneReady === 'true'
      && document.querySelector('#renderCanvas')?.dataset.firstFrameRendered === 'true'
      && document.querySelector('#renderCanvas')?.dataset.weaponSource === 'glb'
      && document.querySelector('#renderCanvas')?.dataset.shotgunReady === 'glb'
      && document.querySelector('#renderCanvas')?.dataset.zombieSource === 'glb'
  `, 120_000, 'scene + rifle + shotgun ready')

  async function screenshot(name) {
    if (!screenshotDirectory) return
    const image = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    writeFileSync(join(screenshotDirectory, name), Buffer.from(image.data, 'base64'))
  }

  return {
    cdp,
    screenshot,
    dispose() {
      cdp.socket.close()
      chromeProcess.kill()
      serverProcess.kill()
      try {
        rmSync(profilePath, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 })
      } catch (error) {
        console.warn(`shotgun-smoke: profile cleanup deferred (${error.message})`)
      }
    },
    get chromeDiagnostics() {
      return chromeDiagnostics
    },
  }
}

const snapshotExpression = 'window.__nightBreachTest.snapshot()'

async function snapshot(cdp) {
  return cdp.evaluate(snapshotExpression)
}

// Parks every non-disposed zombie far outside the 28-unit detection range so a
// scenario can stage exactly the zombie it needs.
async function parkAllZombies(cdp) {
  await cdp.evaluate(`(() => {
    const api = window.__nightBreachTest
    const state = api.snapshot()
    const corners = [[-23, 23], [23, 23], [-23, -23], [23, -23]]
    for (let index = 0; index < state.zombies.length; index += 1) {
      if (state.zombies[index].disposed || state.zombies[index].state === 'dead') continue
      const corner = corners[index % corners.length]
      api.setZombiePosition(index, corner[0], corner[1])
    }
  })()`)
}

async function fireDesktop(cdp) {
  await cdp.evaluate(`document.querySelector('#renderCanvas').dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 7, pointerType: 'mouse' }),
  )`)
}

async function pressKey(cdp, code) {
  await cdp.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { code: '${code}' }))`)
}

async function waitForPumpCycleComplete(cdp) {
  await cdp.waitForExpression(
    `${snapshotExpression}.shotgunShotElapsed < 0`,
    20_000,
    'pump cycle completion',
  )
}

async function runDesktopPass() {
  console.log('shotgun-smoke: desktop pass starting')
  const session = await launchSession({ mobile: false })
  const { cdp } = session
  try {
    // -- Boot state -------------------------------------------------------
    const boot = await snapshot(cdp)
    assert(boot.activeWeapon === 'rifle', `Game did not start with the AK: ${boot.activeWeapon}.`)
    assert(boot.shotgunResolvedClips === 'idle,walk,shot,reload',
      `Authored shotgun clips were not all resolved: ${boot.shotgunResolvedClips}.`)
    assert(Math.abs(boot.shotgunShotDuration - 0.9833) < 0.02,
      `SG_FPS_Shot duration was not detected from the clip: ${boot.shotgunShotDuration}.`)
    assert(Math.abs(boot.shotgunReloadDuration - 6.8167) < 0.03,
      `SG_FPS_Reload duration was not detected from the clip: ${boot.shotgunReloadDuration}.`)
    assert(boot.shotgunAmmo === '8/32', `Shotgun did not boot at 8/32: ${boot.shotgunAmmo}.`)
    assert(boot.ammo === '30/120', `AK did not boot at 30/120: ${boot.ammo}.`)
    const muzzle = await cdp.evaluate('window.__nightBreachTest.measureShotgunMuzzle()')
    assert(muzzle, 'The shotgun muzzle could not be measured.')
    console.log(`shotgun-smoke: muzzle measured=(${muzzle.measured.x.toFixed(3)}, ${muzzle.measured.y.toFixed(3)}, ${muzzle.measured.z.toFixed(3)}) configured=(${muzzle.configured.x}, ${muzzle.configured.y}, ${muzzle.configured.z})`)
    assert(Math.abs(muzzle.measured.x - muzzle.configured.x) < 0.06
      && Math.abs(muzzle.measured.y - muzzle.configured.y) < 0.06
      && Math.abs(muzzle.measured.z - muzzle.configured.z) < 0.08,
    `Configured muzzle offset drifted from the measured barrel tip: measured (${muzzle.measured.x.toFixed(3)}, ${muzzle.measured.y.toFixed(3)}, ${muzzle.measured.z.toFixed(3)}).`)

    // -- Deploy and AK sanity --------------------------------------------
    await cdp.evaluate(`document.querySelector('#instructions').click()`)
    await cdp.waitForExpression(`${snapshotExpression}.deployed`, 10_000, 'deploy')
    // The first wave spawns after deploy; the combat scenarios need at least
    // two living zombies to stage.
    await cdp.waitForExpression(`${snapshotExpression}.zombies.length >= 2`, 60_000, 'wave spawns')
    await parkAllZombies(cdp)
    await fireDesktop(cdp)
    await cdp.waitForExpression(`${snapshotExpression}.ammo === '29/120'`, 5_000, 'AK shot')
    await pressKey(cdp, 'KeyR')
    await cdp.waitForExpression(`${snapshotExpression}.reloadElapsed >= 0`, 5_000, 'AK reload start')
    await cdp.waitForExpression(
      `${snapshotExpression}.reloadElapsed < 0 && ${snapshotExpression}.ammo === '30/119'`,
      20_000,
      'AK reload completion',
    )
    const akState = await snapshot(cdp)
    assert(akState.hudAmmoText === '30/119', `HUD did not show AK ammo: ${akState.hudAmmoText}.`)
    console.log('shotgun-smoke: AK fire + reload passed')

    // -- Select the shotgun with key 2 -----------------------------------
    await pressKey(cdp, 'Digit2')
    const selected = await snapshot(cdp)
    assert(selected.activeWeapon === 'shotgun', 'Key 2 did not select the shotgun.')
    assert(selected.hudAmmoText === '8/32', `HUD did not show shotgun ammo: ${selected.hudAmmoText}.`)
    assert(selected.shotgunActiveAnimation === IDLE_CLIP,
      `The shotgun did not resume its authored idle: ${selected.shotgunActiveAnimation}.`)
    assert(selected.weaponActiveAnimation === 'stopped',
      `The AK animations were not stopped by the switch: ${selected.weaponActiveAnimation}.`)
    assert(selected.visibleWeaponHierarchies === 1,
      'More than one weapon hierarchy was visible after the switch.')
    await session.screenshot('desktop-shotgun-idle.png')

    // -- Close-range blast: damage, knockback, stagger, pump gate --------
    await parkAllZombies(cdp)
    await cdp.evaluate(`(() => {
      const api = window.__nightBreachTest
      api.setPlayerPosition(0, -10)
      api.setZombiePosition(0, 0, -5)
      api.setCameraRotation(0.2, 0)
    })()`)
    const beforeBlast = await snapshot(cdp)
    await fireDesktop(cdp)
    await fireDesktop(cdp) // second click inside the same cycle must be swallowed
    const blast = await snapshot(cdp)
    assert(blast.shotgunAmmo === '7/32',
      `One trigger pull did not consume exactly one shell: ${blast.shotgunAmmo}.`)
    assert(blast.lastShotgunBlast?.pelletRaysCast === 8,
      `The blast did not cast exactly 8 pellet rays: ${JSON.stringify(blast.lastShotgunBlast)}.`)
    assert(blast.lastShotgunBlast.zombiesHit === 1
      && blast.lastShotgunBlast.zombiesDamaged === 1,
    `The close blast did not damage exactly the staged zombie: ${JSON.stringify(blast.lastShotgunBlast)}.`)
    assert(blast.lastShotgunBlast.pelletsIntoZombies >= 4,
      `Too few pellets landed at close range: ${blast.lastShotgunBlast.pelletsIntoZombies}.`)
    assert(blast.lastShotgunBlast.pelletsIntoZombies > 1,
      'Multiple pellets did not damage a single zombie.')
    assert(blast.lastShotgunBlast.averageFalloff === 1,
      `Close-range pellets were not at full damage: ${blast.lastShotgunBlast.averageFalloff}.`)
    assert(blast.zombies[0].health < beforeBlast.zombies[0].health,
      'The close blast did not reduce zombie health.')
    const blastDamage = beforeBlast.zombies[0].health - blast.zombies[0].health
    assert(Math.abs(blastDamage - blast.lastShotgunBlast.totalDamage) < 0.001,
      `Aggregated damage mismatch: health dropped ${blastDamage}, blast reported ${blast.lastShotgunBlast.totalDamage}.`)
    assert(blast.zombies[0].state === 'hit' || blast.zombies[0].state === 'dead',
      `The blast did not stagger the zombie: ${blast.zombies[0].state}.`)
    assert(blast.zombies[0].knockback > 0 || blast.zombies[0].state === 'dead',
      'A close-range blast did not apply knockback.')
    assert(blast.lastShotgunBlast.maxKnockbackImpulse <= 11.5 + 0.0001,
      `Knockback exceeded its cap: ${blast.lastShotgunBlast.maxKnockbackImpulse}.`)
    assert(blast.zombies[0].upperBodyPush > 0.001 || blast.zombies[0].state === 'dead',
      'The blast did not displace the upper-body impact layer.')
    assert(blast.blood.particleCount > 0, 'The blast did not spawn pooled blood.')
    assert(await cdp.evaluate(`document.querySelector('#hitMarker').classList.contains('visible')`),
      'The blast did not display the hit marker.')
    assert(blast.shotgunActiveAnimation === SHOT_CLIP,
      `SG_FPS_Shot was not playing after the trigger pull: ${blast.shotgunActiveAnimation}.`)
    assert(blast.shotgunShotElapsed >= 0, 'The pump-cycle gate was not armed by the shot.')
    await session.screenshot('desktop-shotgun-muzzle-flash.png')

    // Four to eight close pellets must visibly throw the zombie several steps
    // away from the player (toward +Z), with no chase movement fighting the
    // controlled impulse.
    const knockbackStartZ = blast.zombies[0].position.z
    if (blast.zombies[0].state !== 'dead') {
      await cdp.waitForExpression(
        `${snapshotExpression}.zombies[0].position.z > ${knockbackStartZ + 2.5}`,
        5_000,
        'knockback displacement',
      )
      const displaced = await snapshot(cdp)
      const knockbackDisplacement = displaced.zombies[0].position.z - knockbackStartZ
      assert(displaced.zombies[0].state === 'hit',
        'Normal zombie AI resumed before the close-range knockback ended.')
      console.log(
        `shotgun-smoke: ${blast.lastShotgunBlast.pelletsIntoZombies} close pellets `
        + `displaced zombie ${knockbackDisplacement.toFixed(3)} units`,
      )
      await cdp.waitForExpression(
        `${snapshotExpression}.zombies[0].knockback === 0`,
        6_000,
        'knockback decay',
      )
      await cdp.waitForExpression(
        `['chasing', 'attacking', 'idle'].includes(${snapshotExpression}.zombies[0].state)`,
        6_000,
        'AI recovery after stagger',
      )
    }
    console.log('shotgun-smoke: close-range blast, knockback and stagger passed')

    // -- Pump cycle: a second shot only after SG_FPS_Shot completes ------
    assert((await snapshot(cdp)).shotgunAmmo === '7/32',
      'A shot fired before the pump cycle completed.')
    await waitForPumpCycleComplete(cdp)
    const cycled = await snapshot(cdp)
    assert(cycled.shotgunActiveAnimation === IDLE_CLIP || cycled.shotgunActiveAnimation === WALK_CLIP,
      `The rest loop did not resume after the pump cycle: ${cycled.shotgunActiveAnimation}.`)

    // -- Kill loop: repeat close blasts; corpse rules --------------------
    let killBlasts = 0
    while (killBlasts < 5) {
      const current = await snapshot(cdp)
      if (current.zombies[0].state === 'dead' || current.zombies[0].disposed) break
      await cdp.evaluate(`(() => {
        const api = window.__nightBreachTest
        api.setPlayerPosition(0, -10)
        api.setZombiePosition(0, 0, -5)
        api.setCameraRotation(0.2, 0)
      })()`)
      await fireDesktop(cdp)
      killBlasts += 1
      await waitForPumpCycleComplete(cdp)
    }
    const killed = await snapshot(cdp)
    assert(killed.zombies[0].state === 'dead', 'Repeated close blasts did not kill the zombie.')
    assert(killed.zombies[0].knockback === 0, 'A corpse retained knockback velocity.')
    const corpsePosition = killed.zombies[0].position
    await cdp.evaluate(`window.__nightBreachTest.setCameraRotation(0.2, 0)`)
    await fireDesktop(cdp)
    const corpseBlast = await snapshot(cdp)
    assert(corpseBlast.lastShotgunBlast.zombiesDamaged === 0,
      'A blast damaged an already-dead zombie.')
    await waitForPumpCycleComplete(cdp)
    const corpseAfter = await snapshot(cdp)
    assert(Math.hypot(
      corpseAfter.zombies[0].position.x - corpsePosition.x,
      corpseAfter.zombies[0].position.z - corpsePosition.z,
    ) < 0.001, 'A blast moved a corpse.')
    console.log('shotgun-smoke: kill, corpse protection and pump pacing passed')

    // -- Reload after the kill loop --------------------------------------
    await parkAllZombies(cdp)
    const beforeReload = await snapshot(cdp)
    const [loadedBefore, reserveBefore] = beforeReload.shotgunAmmo.split('/').map(Number)
    assert(loadedBefore < 8, 'Test order error: magazine unexpectedly full before reload test.')
    await pressKey(cdp, 'KeyR')
    await cdp.waitForExpression(`${snapshotExpression}.shotgunReloadElapsed >= 0`, 5_000, 'shotgun reload start')
    const reloading = await snapshot(cdp)
    assert(reloading.shotgunActiveAnimation === RELOAD_CLIP,
      `SG_FPS_Reload was not playing: ${reloading.shotgunActiveAnimation}.`)
    assert(reloading.shotgunAmmo === beforeReload.shotgunAmmo,
      'Reload transferred shells before completion.')
    await fireDesktop(cdp) // firing must be blocked during the reload
    const blockedFire = await snapshot(cdp)
    assert(blockedFire.shotgunAmmo === beforeReload.shotgunAmmo
      && blockedFire.shotgunShotElapsed < 0
      && blockedFire.shotgunActiveAnimation === RELOAD_CLIP,
    'Firing was not blocked during the shotgun reload.')
    await cdp.waitForExpression(
      `${snapshotExpression}.shotgunReloadElapsed < 0`,
      40_000,
      'shotgun reload completion',
    )
    const reloaded = await snapshot(cdp)
    const expectedLoaded = Math.min(8 - loadedBefore, reserveBefore)
    assert(reloaded.shotgunAmmo === `${loadedBefore + expectedLoaded}/${reserveBefore - expectedLoaded}`,
      `Reload transferred the wrong shell count: ${reloaded.shotgunAmmo} from ${beforeReload.shotgunAmmo}.`)
    assert(reloaded.shotgunActiveAnimation === IDLE_CLIP
      || reloaded.shotgunActiveAnimation === WALK_CLIP,
    `The rest loop did not resume after the reload: ${reloaded.shotgunActiveAnimation}.`)
    await pressKey(cdp, 'KeyR')
    await delay(250)
    assert((await snapshot(cdp)).shotgunReloadElapsed < 0,
      'Reload started with a full magazine.')
    console.log('shotgun-smoke: full reload and completion transfer passed')

    // -- Reload interruption by weapon switch ----------------------------
    await parkAllZombies(cdp)
    await fireDesktop(cdp)
    await waitForPumpCycleComplete(cdp)
    const beforeCancel = await snapshot(cdp)
    await pressKey(cdp, 'KeyR')
    await cdp.waitForExpression(`${snapshotExpression}.shotgunReloadElapsed >= 0.4`, 10_000, 'reload progress before cancel')
    await pressKey(cdp, 'Digit1')
    const cancelled = await snapshot(cdp)
    assert(cancelled.activeWeapon === 'rifle', 'Key 1 did not return to the AK during the reload.')
    assert(cancelled.shotgunReloadElapsed < 0, 'The interrupted reload kept running.')
    assert(cancelled.shotgunAmmo === beforeCancel.shotgunAmmo,
      `An interrupted reload moved shells: ${cancelled.shotgunAmmo} from ${beforeCancel.shotgunAmmo}.`)
    assert(cancelled.shotgunActiveAnimation === 'stopped',
      `Switching away did not stop the shotgun clips: ${cancelled.shotgunActiveAnimation}.`)
    assert(cancelled.hudAmmoText === cancelled.ammo,
      `HUD did not return to AK ammo after the switch: ${cancelled.hudAmmoText}.`)
    await pressKey(cdp, 'Digit2')
    const reselected = await snapshot(cdp)
    assert(reselected.shotgunActiveAnimation === IDLE_CLIP,
      `Reselecting the shotgun did not restore idle: ${reselected.shotgunActiveAnimation}.`)
    assert(reselected.hudAmmoText === reselected.shotgunAmmo,
      'HUD did not show shotgun ammo after reselection.')
    await pressKey(cdp, 'KeyR')
    await cdp.waitForExpression(`${snapshotExpression}.shotgunReloadElapsed < 0 && ${snapshotExpression}.shotgunAmmo.startsWith('8/')`, 40_000, 'reload after cancel')
    console.log('shotgun-smoke: reload interruption via weapon switch passed')

    // -- Distance falloff -------------------------------------------------
    await parkAllZombies(cdp)
    let farBlast = null
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const state = await snapshot(cdp)
      const [loaded] = state.shotgunAmmo.split('/').map(Number)
      if (loaded === 0) {
        await pressKey(cdp, 'KeyR')
        await cdp.waitForExpression(`${snapshotExpression}.shotgunReloadElapsed < 0 && Number(${snapshotExpression}.shotgunAmmo.split('/')[0]) > 0`, 40_000, 'refill during falloff test')
      }
      const livingIndex = await cdp.evaluate(`(() => {
        const zombies = ${snapshotExpression}.zombies
        for (let index = 0; index < zombies.length; index += 1) {
          if (!zombies[index].disposed && zombies[index].state !== 'dead') return index
        }
        return -1
      })()`)
      assert(livingIndex >= 0, 'No living zombie was available for the falloff test.')
      await cdp.evaluate(`(() => {
        const api = window.__nightBreachTest
        api.setPlayerPosition(0, -24)
        api.setZombiePosition(${livingIndex}, 0, -2)
        api.setCameraRotation(0.032, 0)
      })()`)
      await fireDesktop(cdp)
      const result = await snapshot(cdp)
      await cdp.evaluate(`window.__nightBreachTest.setZombiePosition(${livingIndex}, 23, 23)`)
      await waitForPumpCycleComplete(cdp)
      if (result.lastShotgunBlast.pelletsIntoZombies > 0) {
        farBlast = result.lastShotgunBlast
        break
      }
    }
    assert(farBlast, 'No far pellet connected across six attempts; falloff could not be sampled.')
    assert(farBlast.averageFalloff < 0.75 && farBlast.averageFalloff >= 0.35,
      `22-unit pellets did not land in the falloff band: ${farBlast.averageFalloff}.`)
    console.log(`shotgun-smoke: distance falloff passed (average multiplier ${farBlast.averageFalloff.toFixed(3)} at ~22 units)`)

    // -- Walls block pellets ----------------------------------------------
    await parkAllZombies(cdp)
    const wallSubject = await cdp.evaluate(`(() => {
      const zombies = ${snapshotExpression}.zombies
      for (let index = 0; index < zombies.length; index += 1) {
        if (!zombies[index].disposed && zombies[index].state !== 'dead') return index
      }
      return -1
    })()`)
    assert(wallSubject >= 0, 'No living zombie was available for the wall test.')
    await cdp.evaluate(`(() => {
      const api = window.__nightBreachTest
      api.setPlayerPosition(8, -10)
      api.setZombiePosition(${wallSubject}, 8, 1)
      api.setCameraRotation(0.037, 0)
    })()`)
    const beforeWall = await snapshot(cdp)
    await fireDesktop(cdp)
    const wallBlast = await snapshot(cdp)
    assert(wallBlast.lastShotgunBlast.blockedPellets === 8
      && wallBlast.lastShotgunBlast.zombiesHit === 0,
    `Pellets were not all absorbed by the crate: ${JSON.stringify(wallBlast.lastShotgunBlast)}.`)
    assert(wallBlast.zombies[wallSubject].health === beforeWall.zombies[wallSubject].health,
      'A zombie behind cover took pellet damage.')
    await waitForPumpCycleComplete(cdp)
    console.log('shotgun-smoke: wall blocking passed')

    // -- Knockback cannot push a zombie through a wall --------------------
    await parkAllZombies(cdp)
    const pinnedSubject = await cdp.evaluate(`(() => {
      const zombies = ${snapshotExpression}.zombies
      for (let index = 0; index < zombies.length; index += 1) {
        if (!zombies[index].disposed && zombies[index].state !== 'dead') return index
      }
      return -1
    })()`)
    assert(pinnedSubject >= 0, 'No living zombie was available for the wall-pin test.')
    await cdp.evaluate(`(() => {
      const api = window.__nightBreachTest
      api.setPlayerPosition(0, 20)
      api.setZombiePosition(${pinnedSubject}, 0, 24.6)
      api.setCameraRotation(0.2, 0)
    })()`)
    await fireDesktop(cdp)
    await waitForPumpCycleComplete(cdp)
    await delay(500)
    const pinned = await snapshot(cdp)
    assert(pinned.zombies[pinnedSubject].position.z < 25.4,
      `Knockback pushed a zombie into the north wall: z=${pinned.zombies[pinnedSubject].position.z}.`)
    await cdp.evaluate(`window.__nightBreachTest.setPlayerPosition(0, -10)`)
    console.log('shotgun-smoke: knockback wall containment passed')

    // -- Headshot ----------------------------------------------------------
    await parkAllZombies(cdp)
    const headSubject = await cdp.evaluate(`(() => {
      const zombies = ${snapshotExpression}.zombies
      for (let index = 0; index < zombies.length; index += 1) {
        if (!zombies[index].disposed && zombies[index].state !== 'dead') return index
      }
      return -1
    })()`)
    assert(headSubject >= 0, 'No living zombie was available for the headshot test.')
    await cdp.evaluate(`(() => {
      const api = window.__nightBreachTest
      api.setPlayerPosition(0, -10)
      api.setZombiePosition(${headSubject}, 0, -5)
      api.setCameraRotation(0.015, 0)
    })()`)
    await fireDesktop(cdp)
    const headBlast = await snapshot(cdp)
    assert(headBlast.lastShotgunBlast.headshot, 'An aimed head blast did not register a headshot.')
    assert(await cdp.evaluate(`document.querySelector('#headshotIndicator').classList.contains('visible')`),
      'The headshot indicator was not shown for a shotgun headshot.')
    assert(headBlast.blood.headshot, 'Headshot blood did not use the stronger burst.')
    await waitForPumpCycleComplete(cdp)
    console.log('shotgun-smoke: headshot rules passed')

    // -- Repeated switching leaks nothing ---------------------------------
    const baseline = await snapshot(cdp)
    for (let cycle = 0; cycle < 6; cycle += 1) {
      await pressKey(cdp, 'Digit1')
      await pressKey(cdp, 'Digit2')
    }
    const churned = await snapshot(cdp)
    assert(churned.sceneMeshCount === baseline.sceneMeshCount
      && churned.sceneAnimationGroupCount === baseline.sceneAnimationGroupCount
      && churned.sceneTransformNodeCount === baseline.sceneTransformNodeCount
      && churned.sceneSkeletonCount === baseline.sceneSkeletonCount,
    `Repeated switching changed scene totals: ${JSON.stringify({
      before: {
        meshes: baseline.sceneMeshCount,
        groups: baseline.sceneAnimationGroupCount,
        nodes: baseline.sceneTransformNodeCount,
        skeletons: baseline.sceneSkeletonCount,
      },
      after: {
        meshes: churned.sceneMeshCount,
        groups: churned.sceneAnimationGroupCount,
        nodes: churned.sceneTransformNodeCount,
        skeletons: churned.sceneSkeletonCount,
      },
    })}.`)
    assert(Object.values(churned.shotgunEndObserverCounts).every((count) => count === 1),
      `Shotgun clip observers were duplicated: ${JSON.stringify(churned.shotgunEndObserverCounts)}.`)
    assert(churned.reloadEndObserverCount === baseline.reloadEndObserverCount,
      'Rifle reload observers were duplicated by switching.')
    assert(churned.activeWeapon === 'shotgun'
      && churned.shotgunActiveAnimation === IDLE_CLIP
      && churned.visibleWeaponHierarchies === 1,
    'Rapid switching did not settle on a valid shotgun idle state.')
    console.log('shotgun-smoke: repeated switching stability passed')

    // -- Empty weapon behaviour -------------------------------------------
    await parkAllZombies(cdp)
    for (let safety = 0; safety < 12; safety += 1) {
      const state = await snapshot(cdp)
      if (Number(state.shotgunAmmo.split('/')[0]) === 0) break
      await fireDesktop(cdp)
      await waitForPumpCycleComplete(cdp)
    }
    const emptyBefore = await snapshot(cdp)
    assert(emptyBefore.shotgunAmmo.startsWith('0/'),
      `The magazine could not be emptied: ${emptyBefore.shotgunAmmo}.`)
    await delay(400)
    await fireDesktop(cdp)
    await delay(150)
    const emptyAfter = await snapshot(cdp)
    assert(emptyAfter.shotgunAmmo === emptyBefore.shotgunAmmo,
      'An empty trigger pull changed ammunition.')
    assert(emptyAfter.shotgunShotElapsed < 0, 'An empty trigger pull started a shot cycle.')
    assert(JSON.stringify(emptyAfter.lastShotgunBlast) === JSON.stringify(emptyBefore.lastShotgunBlast),
      'An empty trigger pull produced pellets.')
    assert(emptyAfter.shotgunActiveAnimation === IDLE_CLIP
      || emptyAfter.shotgunActiveAnimation === WALK_CLIP,
    `An empty trigger pull played a shot animation: ${emptyAfter.shotgunActiveAnimation}.`)
    await pressKey(cdp, 'KeyR')
    await cdp.waitForExpression(
      `${snapshotExpression}.shotgunReloadElapsed < 0 && ${snapshotExpression}.shotgunAmmo.startsWith('8/')`,
      40_000,
      'reload from empty',
    )
    console.log('shotgun-smoke: empty-weapon behaviour passed')

    // -- Death during reload, then restart --------------------------------
    await parkAllZombies(cdp)
    await fireDesktop(cdp)
    await waitForPumpCycleComplete(cdp)
    const beforeDeath = await snapshot(cdp)
    await pressKey(cdp, 'KeyR')
    await cdp.waitForExpression(`${snapshotExpression}.shotgunReloadElapsed >= 0.3`, 10_000, 'reload before death')
    const attackerIndex = await cdp.evaluate(`(() => {
      const zombies = ${snapshotExpression}.zombies
      for (let index = 0; index < zombies.length; index += 1) {
        if (!zombies[index].disposed) return index
      }
      return 0
    })()`)
    await cdp.evaluate(`window.__nightBreachTest.damagePlayer(100, ${attackerIndex})`)
    const dead = await snapshot(cdp)
    assert(dead.gameOver, 'Lethal damage did not end the run.')
    assert(dead.shotgunReloadElapsed < 0, 'Player death did not cancel the shotgun reload.')
    assert(dead.shotgunAmmo === beforeDeath.shotgunAmmo,
      'A death-interrupted reload transferred shells.')
    await cdp.evaluate(`document.querySelector('#retryButton').click()`)
    await cdp.waitForExpression(`(() => {
      const state = ${snapshotExpression}
      return !state.gameOver && state.health === 100
    })()`, 15_000, 'restart')
    const restarted = await snapshot(cdp)
    assert(restarted.activeWeapon === 'rifle', 'Restart did not hand the AK back.')
    assert(restarted.ammo === '30/120', `Restart did not reset AK ammo: ${restarted.ammo}.`)
    assert(restarted.shotgunAmmo === '8/32', `Restart did not reset shotgun ammo: ${restarted.shotgunAmmo}.`)
    assert(restarted.hudAmmoText === '30/120', `Restart HUD mismatch: ${restarted.hudAmmoText}.`)
    assert(restarted.shotgunReloadElapsed < 0 && restarted.shotgunShotElapsed < 0,
      'Restart left a shotgun cycle in flight.')
    await pressKey(cdp, 'Digit2')
    assert((await snapshot(cdp)).hudAmmoText === '8/32',
      'The restarted shotgun did not present 8/32.')
    await fireDesktop(cdp)
    assert((await snapshot(cdp)).shotgunAmmo === '7/32',
      'The restarted shotgun could not fire.')
    await waitForPumpCycleComplete(cdp)
    console.log('shotgun-smoke: death, restart and post-restart integrity passed')

    assert(cdp.consoleErrors.length === 0,
      `Browser console errors were reported: ${cdp.consoleErrors.join(' | ')}`)
    console.log('shotgun-smoke: desktop pass passed')
  } catch (error) {
    if (session.chromeDiagnostics) console.error(session.chromeDiagnostics)
    const diagnostics = await snapshot(cdp).catch(() => null)
    if (diagnostics) {
      console.error(`shotgun-smoke: failure diagnostics ${JSON.stringify({
        activeWeapon: diagnostics.activeWeapon,
        ammo: diagnostics.ammo,
        hud: diagnostics.hudAmmoText,
        lastShotgunBlast: diagnostics.lastShotgunBlast,
        shotgunActiveAnimation: diagnostics.shotgunActiveAnimation,
        shotgunAmmo: diagnostics.shotgunAmmo,
        shotgunReloadElapsed: diagnostics.shotgunReloadElapsed,
        shotgunShotElapsed: diagnostics.shotgunShotElapsed,
        zombies: diagnostics.zombies,
      })}`)
    }
    throw error
  } finally {
    session.dispose()
    await delay(150)
  }
}

async function runMobilePass() {
  console.log('shotgun-smoke: mobile pass starting')
  const session = await launchSession({ mobile: true })
  const { cdp } = session
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
  try {
    await cdp.evaluate(`document.querySelector('#instructions').click()`)
    await cdp.waitForExpression(`${snapshotExpression}.deployed`, 10_000, 'mobile deploy')
    await cdp.waitForExpression(`${snapshotExpression}.zombies.length >= 1`, 60_000, 'mobile wave spawns')
    await parkAllZombies(cdp)

    // Switch to the shotgun with the touch button.
    await cdp.evaluate(`(() => {
      ${pointerHelpers}
      const button = center('#weaponSwitchButton');
      emit('#weaponSwitchButton', 'pointerdown', 31, button.x, button.y);
    })()`)
    const switched = await snapshot(cdp)
    assert(switched.activeWeapon === 'shotgun', 'The mobile switch button did not select the shotgun.')
    assert(switched.hudAmmoText === '8/32', `Mobile HUD did not show shotgun ammo: ${switched.hudAmmoText}.`)
    await session.screenshot('mobile-shotgun-idle.png')

    // One tap, one shell, eight pellets.
    await cdp.evaluate(`(() => {
      const api = window.__nightBreachTest
      api.setPlayerPosition(0, -10)
      api.setZombiePosition(0, 0, -5)
      api.setCameraRotation(0.2, 0)
    })()`)
    await cdp.evaluate(`(() => {
      ${pointerHelpers}
      const fire = center('#fireButton');
      emit('#fireButton', 'pointerdown', 32, fire.x, fire.y);
      emit('#fireButton', 'pointerup', 32, fire.x, fire.y);
    })()`)
    const tapBlast = await snapshot(cdp)
    assert(tapBlast.shotgunAmmo === '7/32', `A fire tap did not consume one shell: ${tapBlast.shotgunAmmo}.`)
    assert(tapBlast.lastShotgunBlast?.pelletRaysCast === 8, 'The mobile tap did not cast 8 pellets.')
    assert(tapBlast.lastShotgunBlast.zombiesDamaged === 1, 'The mobile tap did not damage the staged zombie.')

    // Hold-to-fire respects the pump cycle: over a held burst the shotgun
    // fires again, but never faster than one shell per completed cycle.
    await cdp.evaluate(`(() => {
      ${pointerHelpers}
      const fire = center('#fireButton');
      emit('#fireButton', 'pointerdown', 33, fire.x, fire.y);
    })()`)
    await cdp.waitForExpression(
      `Number(${snapshotExpression}.shotgunAmmo.split('/')[0]) <= 5`,
      30_000,
      'held fire pumping',
    )
    await cdp.evaluate(`(() => {
      ${pointerHelpers}
      const fire = center('#fireButton');
      emit('#fireButton', 'pointerup', 33, fire.x, fire.y);
    })()`)
    console.log('shotgun-smoke: mobile fire tap and held pump-fire passed')

    // The mobile reload button runs the authored reload and transfers once.
    await cdp.waitForExpression(`${snapshotExpression}.shotgunShotElapsed < 0`, 20_000, 'cycle settle')
    await parkAllZombies(cdp)
    const beforeReload = await snapshot(cdp)
    const [loadedBefore, reserveBefore] = beforeReload.shotgunAmmo.split('/').map(Number)
    await cdp.evaluate(`(() => {
      ${pointerHelpers}
      const reload = center('#reloadButton');
      emit('#reloadButton', 'pointerdown', 34, reload.x, reload.y);
    })()`)
    await cdp.waitForExpression(`${snapshotExpression}.shotgunReloadElapsed >= 0`, 5_000, 'mobile reload start')
    await cdp.waitForExpression(`${snapshotExpression}.shotgunReloadElapsed < 0`, 40_000, 'mobile reload completion')
    const reloaded = await snapshot(cdp)
    const expectedLoaded = Math.min(8 - loadedBefore, reserveBefore)
    assert(reloaded.shotgunAmmo === `${loadedBefore + expectedLoaded}/${reserveBefore - expectedLoaded}`,
      `The mobile reload transferred the wrong count: ${reloaded.shotgunAmmo}.`)

    // Switching weapons mid-reload cancels cleanly from the touch button too.
    await parkAllZombies(cdp)
    await cdp.evaluate(`(() => {
      ${pointerHelpers}
      const fire = center('#fireButton');
      emit('#fireButton', 'pointerdown', 35, fire.x, fire.y);
      emit('#fireButton', 'pointerup', 35, fire.x, fire.y);
    })()`)
    await cdp.waitForExpression(`${snapshotExpression}.shotgunShotElapsed < 0`, 20_000, 'cycle settle 2')
    const beforeCancel = await snapshot(cdp)
    await cdp.evaluate(`(() => {
      ${pointerHelpers}
      const reload = center('#reloadButton');
      emit('#reloadButton', 'pointerdown', 36, reload.x, reload.y);
    })()`)
    await cdp.waitForExpression(`${snapshotExpression}.shotgunReloadElapsed >= 0.3`, 10_000, 'reload before mobile cancel')
    await cdp.evaluate(`(() => {
      ${pointerHelpers}
      const button = center('#weaponSwitchButton');
      emit('#weaponSwitchButton', 'pointerdown', 37, button.x, button.y);
    })()`)
    const cancelled = await snapshot(cdp)
    assert(cancelled.activeWeapon === 'rifle', 'The mobile switch did not return to the AK mid-reload.')
    assert(cancelled.shotgunReloadElapsed < 0, 'The mobile switch did not cancel the reload.')
    assert(cancelled.shotgunAmmo === beforeCancel.shotgunAmmo,
      'A cancelled mobile reload moved shells.')
    assert(cancelled.hudAmmoText === cancelled.ammo, 'Mobile HUD did not return to AK ammo.')
    await session.screenshot('mobile-ak-after-cancel.png')

    assert(cdp.consoleErrors.length === 0,
      `Browser console errors were reported: ${cdp.consoleErrors.join(' | ')}`)
    console.log('shotgun-smoke: mobile pass passed')
  } catch (error) {
    if (session.chromeDiagnostics) console.error(session.chromeDiagnostics)
    const diagnostics = await snapshot(cdp).catch(() => null)
    if (diagnostics) {
      console.error(`shotgun-smoke: mobile failure diagnostics ${JSON.stringify({
        activeWeapon: diagnostics.activeWeapon,
        hud: diagnostics.hudAmmoText,
        shotgunAmmo: diagnostics.shotgunAmmo,
        shotgunReloadElapsed: diagnostics.shotgunReloadElapsed,
        shotgunShotElapsed: diagnostics.shotgunShotElapsed,
        lastShotgunBlast: diagnostics.lastShotgunBlast,
      })}`)
    }
    throw error
  } finally {
    session.dispose()
    await delay(150)
  }
}

await runDesktopPass()
await runMobilePass()
console.log(JSON.stringify({
  desktop: 'boot, AK sanity, key selection, blast, knockback, pump gate, corpse, reload, cancel, falloff, walls, headshot, switching stability, empty weapon, death/restart passed',
  mobile: 'switch button, fire tap, held pump-fire, reload button, mid-reload switch cancel passed',
}, null, 2))
