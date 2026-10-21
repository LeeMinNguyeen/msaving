import { createContext, useContext } from 'react'

export const ToastContext = createContext<(text: string) => void>(() => {})

export const useToast = () => useContext(ToastContext)
