// Node 26 ships its own `localStorage` global, inert unless the process was started with
// --localstorage-file. Vitest's jsdom environment copies a window property onto globalThis
// only when that name is either absent there or on its internal allow-list, and
// `localStorage` is on neither — so Node's inert version shadows jsdom's, and every module
// reading localStorage at import time (most stores and composables do) throws while being
// imported, failing the whole test file before a single assertion runs. `sessionStorage` is
// unaffected: Node does not define it, so jsdom's comes through normally.
// jsdom's own Storage is still reachable through the handle Vitest leaves on the window.
// Typed by the one property this needs rather than pulling in @types/jsdom for it.
type JsdomHandle = { window: { localStorage: Storage } }

const jsdomHandle = (globalThis as typeof globalThis & { jsdom?: JsdomHandle }).jsdom

if (jsdomHandle) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: jsdomHandle.window.localStorage,
    configurable: true,
  })
}
