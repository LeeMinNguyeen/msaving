import { createTheme } from '@mui/material/styles'

declare module '@mui/material/styles' {
  interface TypeBackground {
    sidebar: string // one shade darker than the page, so the sidebar stands apart from the content
  }
}

// Follows the device's light or dark setting. Colours and type are MUI's
// defaults until there's a design.
export const theme = createTheme({
  colorSchemes: {
    light: { palette: { background: { sidebar: '#f3f4f6' } } },
    dark: { palette: { background: { sidebar: '#0b0b0b' } } },
  },
  shape: { borderRadius: 10 },
  components: {
    MuiTextField: { defaultProps: { fullWidth: true } },
    MuiButton: { defaultProps: { disableElevation: true } },
  },
})
