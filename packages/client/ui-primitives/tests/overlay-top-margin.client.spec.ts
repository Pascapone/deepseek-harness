// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { overlayTopMargin } from '../src/overlay-top-margin.ts'

it('fits detached overlays to their own frame clearance and fullscreen state', () => {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  const popup = frame.contentDocument!
  document.documentElement.style.setProperty('--dsh-frame-top-clearance', '200px')
  popup.documentElement.style.setProperty('--dsh-frame-top-clearance', '50px')
  try {
    expect(overlayTopMargin(12)).toBe(220)
    expect(overlayTopMargin(12, popup)).toBe(70)
    popup.documentElement.setAttribute('data-fullscreen', '')
    expect(overlayTopMargin(12, popup)).toBe(20)
    popup.documentElement.style.removeProperty('--dsh-frame-top-clearance')
    expect(overlayTopMargin(12, popup)).toBe(12)
  } finally {
    document.documentElement.style.removeProperty('--dsh-frame-top-clearance')
    frame.remove()
  }
})
