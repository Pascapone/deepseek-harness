import { createContext, useContext } from 'react'

/** The browser document hosting an externally floated tab and its overlays. */
export const PortalDocument = createContext<Document | undefined>(undefined)

export function usePortalDocument(): Document {
  return useContext(PortalDocument) ?? document
}
