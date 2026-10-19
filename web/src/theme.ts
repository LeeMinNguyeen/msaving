import { createTheme } from '@mui/material/styles'

// Follows the device's light or dark setting. Colours and type are MUI's
// defaults until there's a design.
export const theme = createTheme({
  colorSchemes: { light: true, dark: true },
  shape: { borderRadius: 10 },
  components: {
    MuiTextField: { defaultProps: { fullWidth: true } },
    MuiButton: { defaultProps: { disableElevation: true } },
  },
})
