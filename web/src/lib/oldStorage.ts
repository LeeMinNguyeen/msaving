// The app's former name was MSaving: this browser may keep the session and its choices under it. Imported first, in
// main.tsx, so the move is done before anything reads them.
const OLD = 'msaving.'
const NEW = 'waterflow.'

export function moveOldStorage(storage: Storage) {
  const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((k) => k?.startsWith(OLD)) as string[]
  for (const key of keys) {
    const name = NEW + key.slice(OLD.length)
    const value = storage.getItem(key)
    if (value !== null && storage.getItem(name) === null) storage.setItem(name, value)
    storage.removeItem(key)
  }
}

try {
  moveOldStorage(localStorage)
} catch {
  // storage blocked: nothing was kept
}
