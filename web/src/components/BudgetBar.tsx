import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlined'
import Box from '@mui/material/Box'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import { useTranslation } from 'react-i18next'
import { useChartColors } from './charts/palette'

type Props = { spent: number; budget: number; percent: number; label?: string; format: (minor: number) => string }

// Spent against a limit. Past the limit the bar turns to the error colour and
// says "over" with an icon, so the state never rests on colour alone.
export function BudgetBar({ spent, budget, percent, label, format }: Props) {
  const { t } = useTranslation()
  const colors = useChartColors()
  const over = spent > budget
  return (
    <Box>
      <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 1, mb: 0.5 }}>
        <Typography variant="body2" noWrap>{label}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
          {t('budget.progress', { spent: format(spent), budget: format(budget) })}
        </Typography>
      </Stack>
      <Box sx={{ height: 8, borderRadius: '4px', bgcolor: 'action.hover' }}>
        <Box sx={{ height: 8, borderRadius: '4px', width: `${Math.min(100, percent)}%`, bgcolor: over ? 'error.main' : colors.magnitude }} />
      </Box>
      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', mt: 0.5 }}>
        {over && <ErrorOutlineIcon color="error" sx={{ fontSize: 16 }} />}
        <Typography variant="caption" color={over ? 'error' : 'text.secondary'} sx={{ fontVariantNumeric: 'tabular-nums' }}>
          {over ? t('budget.over', { amount: format(spent - budget) }) : t('budget.left', { amount: format(budget - spent) })}
        </Typography>
      </Stack>
    </Box>
  )
}
