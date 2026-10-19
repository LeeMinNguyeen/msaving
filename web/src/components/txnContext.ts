import { createContext, useContext } from 'react'
import type { Transaction } from '../lib/api'
import type { TxnDefaults } from './TxnDialog'

// Opens the add/edit transaction dialog from any screen inside a book.
export const TxnContext = createContext<(txn: Transaction | null, defaults?: TxnDefaults) => void>(() => {})
export const useOpenTxn = () => useContext(TxnContext)
