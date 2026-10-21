import { useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, Paper, Stack, TextField, Typography } from '@mui/material';
import StorefrontIcon from '@mui/icons-material/Storefront';
import { call, errorMessage } from '../lib/api';
import { useApp } from '../AppState';

export function LoginPage() {
  const { info, sync, refresh } = useApp();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await call('auth.login', { username, password });
      setPassword('');
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const offline = sync?.state === 'offline';
  return (
    <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'linear-gradient(135deg, #1565c0 0%, #42a5f5 100%)' }}>
      <Paper sx={{ p: 4, width: 420 }}>
        <Stack spacing={2.5}>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
            <StorefrontIcon color="primary" fontSize="large" />
            <Box>
              <Typography variant="h5">{info?.settings.name}</Typography>
              <Typography variant="body2" color="text.secondary">
                {info?.location?.type === 'WAREHOUSE' ? 'Warehouse' : 'Branch'}: {info?.location?.name}
              </Typography>
            </Box>
          </Stack>
          {offline && (
            <Alert severity="warning" icon={false}>
              <Chip size="small" color="warning" label="Offline" sx={{ mr: 1 }} />
              The central server is unreachable. You can sign in if you have signed in on this computer before.
            </Alert>
          )}
          <TextField label="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
          <TextField label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} />
          {error && <Alert severity="error">{error}</Alert>}
          <Button variant="contained" size="large" onClick={submit} disabled={busy || !username || !password}>
            {busy ? <CircularProgress size={22} color="inherit" /> : 'Sign in'}
          </Button>
        </Stack>
      </Paper>
    </Box>
  );
}
