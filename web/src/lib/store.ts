// The web app is designed for desktop. Phones get the
// mobile app's store page instead, once it's published; until then they use
// the web app as it is. Tablets stay on the web app.
export function storeUrlFor(
  userAgent: string,
  stores: { appStoreUrl?: string; playStoreUrl?: string },
): string | undefined {
  if (/iPhone|iPod/.test(userAgent)) return stores.appStoreUrl
  if (/Android/.test(userAgent) && /Mobile/.test(userAgent)) return stores.playStoreUrl
  return undefined
}
