/**
 * Outside-pointer dismissal for trigger-owned popovers (jobs list, Cordis
 * panel): while the surface is open, a pointerdown outside the root closes it.
 */
import { useEffect } from 'react'
import type { RefObject } from 'react'

/**
 * Close an open popover when a pointerdown lands outside its root element.
 * @param root - element containing both the trigger and the open surface.
 * @param open - whether the surface is showing; false detaches the listener.
 * @param setOpen - state setter invoked with false on an outside pointerdown.
 * @param portal - surface portaled outside the root (a `document.body` dialog)
 * that also counts as inside; omit when the root contains the whole popover.
 */
export function useDismissOnOutsidePointer(
  root: RefObject<HTMLElement | null>,
  open: boolean,
  setOpen: (open: boolean) => void,
  portal?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!open) return
    const doc = root.current?.ownerDocument ?? document
    const closeOutside = (event: PointerEvent): void => {
      if (event.target !== null && 'nodeType' in event.target
        && root.current?.contains(event.target as Node) !== true
        && portal?.current?.contains(event.target as Node) !== true) {
        setOpen(false)
      }
    }
    doc.addEventListener('pointerdown', closeOutside)
    return () => { doc.removeEventListener('pointerdown', closeOutside) }
  }, [root, open, setOpen, portal])
}
