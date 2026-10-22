import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { renderApp } from '../test/render'
import { AmountField } from './AmountField'

function Field() {
  const [value, setValue] = useState('')
  return <AmountField label="Amount" value={value} onChange={setValue} minorUnit={0} />
}

describe('AmountField', () => {
  it('drops a leading zero as the user types on', async () => {
    await renderApp(<Field />)
    const input = screen.getByLabelText('Amount')
    await userEvent.type(input, '0')
    expect(input).toHaveValue('0')
    await userEvent.type(input, '99999')
    expect(input).toHaveValue('99,999')
  })
})
