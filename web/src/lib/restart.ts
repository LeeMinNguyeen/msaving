// After a restore the server stops and starts again: resolves once it answers after having been away, or after
// two minutes of answering (a restart quicker than the first look).
export async function waitForServer(): Promise<void> {
  let away = false
  for (let i = 0; ; i++) {
    await new Promise((r) => setTimeout(r, 3000))
    try {
      const r = await fetch('/v1/health', { cache: 'no-store' })
      if (r.ok && (away || i >= 40)) return
      if (!r.ok) away = true
    } catch {
      away = true
    }
  }
}
