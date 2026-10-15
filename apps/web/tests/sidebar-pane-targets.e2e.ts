/** Native Files routing and complete detached panes in the shipped Web composition. */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Locator, type Page } from 'playwright'
import { expect, it, onTestFailed } from 'vitest'
import { acknowledgeReloadConnectionLoss, captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession, watchConsole, webSnapshotMode } from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const STACK = process.env.DSH_PANE_TEST_PLUGIN_STACK
const EXPECTED = fileURLToPath(new URL('./expected/sidebar-pane-targets/', import.meta.url))

async function drag(page: Page, source: Locator, target: Locator, fraction = 0.5): Promise<void> {
  const from = await source.boundingBox(), to = await target.boundingBox()
  if (!from || !to) throw new Error('The native tab drag needs visible source and destination')
  await page.mouse.move(from.x + 6, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + to.width * fraction, to.y + to.height / 2, { steps: 16 })
  await page.mouse.up()
}

function tab(page: Page, name: string): Locator {
  return page.locator('[data-dockkit-tab]').filter({ has: page.locator('[data-dockkit-tab-title]', { hasText: name }) })
}

it('routes native Files clicks to a picked pane and retains the complete pane across popup lifecycle', async ({ skip }) => {
  if (STACK === undefined) {
    skip('Set DSH_PANE_TEST_PLUGIN_STACK to the external Better Web, File Targets and Markdown plugin stack')
    return
  }
  if (webSnapshotMode() === 'refresh') await mkdir(EXPECTED, { recursive: true })
  const configDir = await mkdtemp(join(tmpdir(), 'dsh-pane-target-config-'))
  const overlay = join(configDir, 'cordis.patch.yml')
  const email = join(configDir, 'email.txt')
  await writeFile(email, 'fixture@example.invalid\n')
  await writeFile(overlay, '- insert:\n    - id: pane-test-markdown\n      name: \'@pascapone/dsh-markdown\'\n')
  const scaffold = await launchWebScaffold({
    extraOverlayPath: [fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)), overlay],
    extraInstallAnchors: ['dsh-better-web', 'dsh-file-targets', 'dsh-markdown'].map(name => join(STACK, name, 'package.json')),
  }).catch(async (error: unknown) => {
    await rm(configDir, { recursive: true, force: true })
    throw error
  })
  try {
    const betterWebEntryId = await scaffold.ctx.loader.create({ name: '@pascapone/dsh-better-web', config: { publicOrigin: 'https://pane-fixture.invalid', allowedEmailFile: email } })
    const fileTargetsEntryId = await scaffold.ctx.loader.create({ name: '@pascapone/dsh-file-targets' })
    await writeFile(join(scaffold.workspaceCwd, 'alpha.md'), '# Alpha native preview\n')
    await writeFile(join(scaffold.workspaceCwd, 'beta.md'), '# Beta native preview\n')
    await writeFile(join(scaffold.workspaceCwd, 'gamma.txt'), 'Gamma native text preview\n')
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const history = await readFile(fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url)), 'utf8')
    const sessionId = await seedSession(scaffold, history, 'pane-target-browser')
    await workspace.attachSession(sessionId)
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'Pane target source' })
    const otherId = await seedSession(scaffold, history, 'pane-target-other')
    await workspace.attachSession(otherId)
    await scaffold.ctx.sessionController.rename({ sessionId: otherId, title: 'Pane target other' })
    const browser = await chromium.launch(existsSync(chromium.executablePath()) ? {} : { channel: 'chrome' })
    try {
      const context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: 'en-US' })
      const page = await context.newPage()
      const tripwire = watchConsole(page)
      onTestFailed(() => saveFailureShot(page, 'sidebar-pane-targets'))
      await page.addInitScript((id) => { localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id })) }, sessionId)
      await page.goto(scaffold.authenticatedUrl)
      await page.locator('[data-sidebar-right-expand]').click()
      await page.locator('[data-sidebar-right-guide-entry="files"]').click()
      const source = page.locator('[data-file-targets-trigger]')
      await source.waitFor()
      await expect.poll(() => source.isEnabled()).toBe(true)
      const openFile = async (name: string) => {
        await page.locator('[data-files-entry="file"]').getByRole('button', { name, exact: true }).click()
      }
      await openFile('alpha.md')
      await tab(page, 'alpha.md').waitFor()
      await tab(page, 'Files').click()
      await openFile('beta.md')
      await tab(page, 'beta.md').waitFor()
      await tab(page, 'Files').click()
      await page.locator('[data-dockkit-split-button]').first().click()
      const destination = page.locator('[data-dockkit-pane][data-dockkit-column="1"]').first()
      await destination.waitFor()
      await drag(page, tab(page, 'alpha.md'), destination.locator('[data-dockkit-strip]'))
      await tab(page, 'Files').click()
      const paneId = await destination.getAttribute('data-dockkit-pane')
      expect(paneId).toBeTruthy()
      await source.click()
      await compareOrRefreshGolden(join(EXPECTED, 'desktop-picker.expected.md'), await captureStableAria(page, '[data-file-targets-picker]', scaffold.workspaceCwd), webSnapshotMode())
      const choice = page.locator(`[data-file-targets-choice="${paneId}"]`)
      await choice.hover()
      expect(await page.locator(`[data-file-targets-pane="${paneId}"]`).getAttribute('data-highlight')).toBe('true')
      await choice.click()
      expect(await source.evaluate(node => node.ownerDocument.activeElement === node)).toBe(true)
      const warningsBeforeReload = tripwire.warnings.length
      await page.reload()
      await source.waitFor()
      await expect.poll(() => source.getAttribute('data-file-targets-target')).toBe(paneId)
      acknowledgeReloadConnectionLoss(tripwire, warningsBeforeReload)
      await openFile('gamma.txt')
      await expect.poll(() => destination.locator('[data-dockkit-tab-title]').allInnerTexts()).toContain('gamma.txt')
      expect(await source.isVisible()).toBe(true)
      const composer = page.locator('[data-composer-input][contenteditable="true"]').first()
      await composer.fill('Unsent native composer draft')
      for (const name of ['beta.md', 'gamma.txt']) {
        const chip = tab(page, name)
        await chip.hover()
        await chip.locator('[data-dockkit-tab-close]').click()
      }

      await tab(page, 'alpha.md').click({ button: 'right' })
      const popupReady = context.waitForEvent('page')
      await page.getByRole('menuitem', { name: 'Open in new window', exact: true }).click()
      let popup = await popupReady
      await popup.locator('[data-dockkit-float]').waitFor()
      await expect.poll(() => popup.locator('[data-dockkit-tab-title]').allInnerTexts()).toEqual(['alpha.md'])
      const popupPane = await popup.locator('[data-dockkit-float]').getAttribute('data-dockkit-float')
      await tab(popup, 'alpha.md').click({ button: 'right' })
      await popup.getByRole('menu').waitFor()
      expect(await page.getByRole('menu').count()).toBe(0)
      await compareOrRefreshGolden(join(EXPECTED, 'popup-tab-menu.expected.md'), await captureStableAria(popup, '[role="menu"]', scaffold.workspaceCwd), webSnapshotMode())
      await popup.keyboard.press('Escape')
      await tab(popup, 'alpha.md').click()
      await popup.getByRole('heading', { name: 'Alpha native preview' }).waitFor()
      await source.click()
      await expect.poll(() => popup.locator('[data-file-targets-pane]').count()).toBe(1)
      await compareOrRefreshGolden(join(EXPECTED, 'popup-picker.expected.md'), await captureStableAria(page, '[data-file-targets-picker]', scaffold.workspaceCwd), webSnapshotMode())
      await page.locator(`[data-file-targets-choice="${popupPane}"]`).hover()
      expect(await popup.locator('[data-file-targets-pane]').getAttribute('data-highlight')).toBe('true')
      await popup.locator('[data-file-targets-pane]').click()
      expect(await source.evaluate(node => node.ownerDocument.activeElement === node)).toBe(true)
      await openFile('beta.md')
      await openFile('gamma.txt')
      await expect.poll(() => popup.locator('[data-dockkit-tab-title]').allInnerTexts()).toEqual(['alpha.md', 'beta.md', 'gamma.txt'])
      await tab(popup, 'alpha.md').hover()
      await popup.locator('[data-dockkit-tab]').filter({ hasText: 'alpha.md' }).locator('[data-dockkit-tab-close]').click()
      expect(popup.isClosed()).toBe(false)
      await expect.poll(() => popup.locator('[data-dockkit-tab-title]').allInnerTexts()).toEqual(['beta.md', 'gamma.txt'])
      await drag(popup, tab(popup, 'gamma.txt'), tab(popup, 'beta.md'), 0.05)
      await expect.poll(() => popup.locator('[data-dockkit-tab-title]').allInnerTexts()).toEqual(['gamma.txt', 'beta.md'])
      await tab(popup, 'beta.md').click()
      await popup.getByRole('button', { name: 'Edit', exact: true }).click()
      await popup.getByRole('button', { name: 'Source', exact: true }).click()
      await popup.locator('textarea.dm-source').fill('# Beta native preview\n\nRetained unsaved pane draft\n')
      await page.getByRole('treeitem').filter({ hasText: 'Pane target other' }).click()
      await expect.poll(() => popup.isClosed()).toBe(true)
      const restoredPopup = context.waitForEvent('page')
      await page.getByRole('treeitem').filter({ hasText: 'Pane target source' }).click()
      popup = await restoredPopup
      await popup.locator('textarea.dm-source').waitFor()
      expect(await popup.locator('textarea.dm-source').inputValue()).toContain('Retained unsaved pane draft')
      expect(await readFile(join(scaffold.workspaceCwd, 'beta.md'), 'utf8')).toBe('# Beta native preview\n')
      await popup.locator('[data-dockkit-float-dock]').click()
      await expect.poll(() => popup.isClosed()).toBe(true)
      await expect.poll(() => page.locator('[data-dockkit-tab-title]').allInnerTexts()).toEqual(['Files', 'gamma.txt', 'beta.md', 'Start'])
      expect(await composer.innerText()).toBe('Unsent native composer draft')
      expect(await page.locator('textarea.dm-source').inputValue()).toContain('Retained unsaved pane draft')

      await tab(page, 'Files').click()
      await page.setViewportSize({ width: 420, height: 800 })
      await source.click()
      await compareOrRefreshGolden(join(EXPECTED, 'mobile-picker.expected.md'), await captureStableAria(page, '[data-file-targets-picker]', scaffold.workspaceCwd), webSnapshotMode())
      const bounds = await page.locator('[data-file-targets-picker]').boundingBox()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(420)
      await page.locator('[data-file-targets-cancel]').click()
      expect(await source.evaluate(node => node.ownerDocument.activeElement === node)).toBe(true)
      await page.setViewportSize({ width: 1680, height: 1000 })
      const beforeBlocked = await page.locator('[data-dockkit-tab-title]').allInnerTexts()
      const originalOpen = await page.evaluateHandle(() => window.open)
      await page.evaluate(() => { window.open = () => null })
      try {
        await tab(page, 'gamma.txt').click({ button: 'right' })
        await page.getByRole('menuitem', { name: 'Open in new window', exact: true }).click()
        expect(await page.locator('[data-dockkit-tab-title]').allInnerTexts()).toEqual(beforeBlocked)
      } finally {
        await page.evaluate((original) => { window.open = original }, originalOpen)
        await originalOpen.dispose()
      }
      const retryReady = context.waitForEvent('page')
      await tab(page, 'gamma.txt').click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Open in new window', exact: true }).click()
      const retry = await retryReady
      await retry.locator('[data-dockkit-float]').waitFor()
      const closingPane = await retry.locator('[data-dockkit-float]').getAttribute('data-dockkit-float')
      await source.click()
      await page.locator(`[data-file-targets-choice="${closingPane}"]`).click()
      expect(await source.getAttribute('data-file-targets-target')).toBe(closingPane)
      await retry.close()
      await expect.poll(() => source.getAttribute('data-file-targets-target')).toBeNull()
      await expect.poll(() => tab(page, 'gamma.txt').count()).toBe(0)
      scaffold.ctx.loader.remove(fileTargetsEntryId)
      await expect.poll(() => scaffold.ctx.clientModules.graph().entries.some(entry => entry.id === '@pascapone/dsh-file-targets'), { timeout: 10_000 }).toBe(false)
      await expect.poll(() => page.locator('[data-file-targets-trigger]').count(), { timeout: 10_000 }).toBe(0)
      const unloadPopupReady = context.waitForEvent('page')
      await tab(page, 'beta.md').click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Open in new window', exact: true }).click()
      const unloadPopup = await unloadPopupReady
      await unloadPopup.locator('textarea.dm-source').waitFor()
      scaffold.ctx.loader.remove(betterWebEntryId)
      await expect.poll(() => unloadPopup.isClosed(), { timeout: 10_000 }).toBe(true)
      await expect.poll(() => page.locator('[data-dockkit-float] textarea.dm-source').inputValue()).toContain('Retained unsaved pane draft')
      expect(tripwire.pageErrors).toEqual([])
    } finally { await browser.close() }
  } finally {
    try { await scaffold.close() }
    finally { await rm(configDir, { recursive: true, force: true }) }
  }
}, 180_000)
