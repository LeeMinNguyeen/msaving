import Button from '@mui/material/Button'
import Dialog from '@mui/material/Dialog'
import DialogContent from '@mui/material/DialogContent'
import DialogContentText from '@mui/material/DialogContentText'
import DialogTitle from '@mui/material/DialogTitle'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { signOut } from '../auth/signOut'
import { idleNotice, idleState } from '../lib/idle'
import { DialogFooter } from './DialogFooter'

// Tabs of this browser tell each other about activity here; nothing is stored.
const CHANNEL = 'waterflow.activity'
const ACTIVITY = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const
const TELL_EVERY = 5_000 // ms: another tab hears about activity at most this often

// Signs out after the user's minutes with no activity in any tab, with a
// warning first. Mounted while signed in; nothing happens when it's off.
export function IdleSignOut({ minutes }: { minutes: number | null }) {
  const { t } = useTranslation()
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null)
  const stay = useRef(() => {})

  useEffect(() => idleNotice.set(null), []) // signed in again: the sign-in page's notice is done

  useEffect(() => {
    if (!minutes) return
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL)
    let last = Date.now()
    let told = 0
    let gone = false
    const note = () => {
      last = Date.now()
      if (last - told >= TELL_EVERY) {
        told = last
        channel?.postMessage({ activity: last })
      }
    }
    const tick = () => {
      const state = idleState(last, Date.now(), minutes)
      setSecondsLeft(state.secondsLeft)
      if (state.due && !gone) {
        gone = true
        channel?.postMessage({ signedOut: minutes })
        idleNotice.set(minutes)
        void signOut()
      }
    }
    stay.current = () => {
      told = 0
      note()
      tick()
    }
    if (channel) {
      channel.onmessage = (e: MessageEvent) => {
        if (typeof e.data?.activity === 'number') last = Math.max(last, e.data.activity)
        // Another tab signed out: the session goes here too (it's this browser's), so only the notice is left.
        if (typeof e.data?.signedOut === 'number') {
          gone = true
          idleNotice.set(e.data.signedOut)
        }
      }
    }
    ACTIVITY.forEach((type) => window.addEventListener(type, note, { passive: true, capture: true }))
    document.addEventListener('visibilitychange', tick) // a device waking up: check at once
    const timer = setInterval(tick, 1000)
    return () => {
      clearInterval(timer)
      ACTIVITY.forEach((type) => window.removeEventListener(type, note, { capture: true }))
      document.removeEventListener('visibilitychange', tick)
      channel?.close()
      setSecondsLeft(null)
    }
  }, [minutes])

  return (
    <Dialog open={secondsLeft !== null} onClose={() => stay.current()} maxWidth="xs">
      <DialogTitle>{t('idle.title')}</DialogTitle>
      <DialogContent>
        <DialogContentText>{t('idle.warning', { seconds: secondsLeft ?? 0 })}</DialogContentText>
      </DialogContent>
      <DialogFooter>
        <Button variant="contained" onClick={() => stay.current()}>{t('idle.stay')}</Button>
      </DialogFooter>
    </Dialog>
  )
}
