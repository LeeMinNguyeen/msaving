import useMediaQuery from '@mui/material/useMediaQuery'

// Chart colours (dataviz reference palette, validated for both modes): income
// is categorical slot 1, spending slot 2; magnitudes use the blue ramp.
const LIGHT = { income: '#2a78d6', spent: '#eb6834', magnitude: '#2a78d6', grid: '#e7e6e2' }
const DARK = { income: '#3987e5', spent: '#d95926', magnitude: '#3987e5', grid: '#33332f' }

export function useChartColors() {
  return useMediaQuery('(prefers-color-scheme: dark)') ? DARK : LIGHT
}
