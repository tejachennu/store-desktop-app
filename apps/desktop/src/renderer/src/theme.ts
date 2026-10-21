import { createTheme } from '@mui/material/styles';

export const theme = createTheme({
  palette: {
    mode: 'light',
    primary: { main: '#1565c0', light: '#5e92f3', dark: '#003c8f', contrastText: '#ffffff' },
    secondary: { main: '#0288d1' },
    background: { default: '#f4f7fb', paper: '#ffffff' },
    success: { main: '#2e7d32' },
    warning: { main: '#ed6c02' },
    error: { main: '#c62828' },
  },
  shape: { borderRadius: 8 },
  typography: {
    fontFamily: '"Segoe UI", "Roboto", "Helvetica Neue", Arial, sans-serif',
    h5: { fontWeight: 600 },
    h6: { fontWeight: 600 },
    button: { textTransform: 'none', fontWeight: 600 },
  },
  components: {
    MuiAppBar: { defaultProps: { elevation: 0 } },
    MuiPaper: { defaultProps: { elevation: 0 }, styleOverrides: { root: { border: '1px solid #e3e8f0' } } },
    MuiButton: { defaultProps: { disableElevation: true } },
    MuiTableCell: { styleOverrides: { head: { fontWeight: 600, backgroundColor: '#f0f4fa' } } },
    MuiTextField: { defaultProps: { size: 'small' } },
    MuiSelect: { defaultProps: { size: 'small' } },
  },
});
