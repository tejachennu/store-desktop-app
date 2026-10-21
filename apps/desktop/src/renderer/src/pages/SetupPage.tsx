import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  MenuItem,
  Paper,
  Stack,
  Step,
  StepLabel,
  Stepper,
  TextField,
  Typography,
} from '@mui/material';
import StorefrontIcon from '@mui/icons-material/Storefront';
import type { LocationRow } from '@store/shared';
import { call, errorMessage } from '../lib/api';
import { useApp } from '../AppState';

/** First-run wizard: connect to the central server and register this PC to one location. */
export function SetupPage() {
  const { refresh } = useApp();
  const [step, setStep] = useState(0);
  const [serverUrl, setServerUrl] = useState('http://localhost:4000');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [locationId, setLocationId] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await call('setup.connect', { serverUrl, username, password });
      setServerUrl(r.serverUrl);
      setToken(r.token);
      setLocations(r.locations);
      setPassword('');
      setStep(1);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const register = async () => {
    setBusy(true);
    setError(null);
    setStep(2);
    try {
      await call('setup.register', { serverUrl, token, locationId, deviceName });
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
      await refresh(); // registration may have succeeded even if the first download failed
      setStep(1);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'linear-gradient(135deg, #1565c0 0%, #42a5f5 100%)' }}>
      <Paper sx={{ p: 4, width: 560 }}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center', mb: 1 }}>
          <StorefrontIcon color="primary" fontSize="large" />
          <Typography variant="h5">Set up this computer</Typography>
        </Stack>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Each warehouse or branch PC keeps its own offline database and is registered to exactly one location. A company administrator must
          complete this once.
        </Typography>
        <Stepper activeStep={step} sx={{ mb: 3 }}>
          <Step>
            <StepLabel>Connect</StepLabel>
          </Step>
          <Step>
            <StepLabel>Choose location</StepLabel>
          </Step>
          <Step>
            <StepLabel>Download data</StepLabel>
          </Step>
        </Stepper>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        {step === 0 && (
          <Stack spacing={2}>
            <TextField label="Central server address" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} helperText="Provided by your IT administrator, e.g. https://store-api.yourcompany.in" />
            <TextField label="Administrator username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
            <TextField label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void connect()} />
            <Button variant="contained" size="large" onClick={connect} disabled={busy || !serverUrl || !username || !password}>
              {busy ? <CircularProgress size={22} color="inherit" /> : 'Connect'}
            </Button>
          </Stack>
        )}
        {step === 1 && (
          <Stack spacing={2}>
            <TextField select label="This computer belongs to" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              {locations.map((l) => (
                <MenuItem key={l.id} value={l.id}>
                  {l.type === 'WAREHOUSE' ? 'Warehouse' : 'Branch'} — {l.name} ({l.code})
                </MenuItem>
              ))}
            </TextField>
            <TextField label="Computer name" placeholder="e.g. Counter 1, Receiving desk" value={deviceName} onChange={(e) => setDeviceName(e.target.value)} />
            <Button variant="contained" size="large" onClick={register} disabled={busy || !locationId || deviceName.trim().length < 2}>
              Register this computer
            </Button>
            <Button onClick={() => setStep(0)}>Back</Button>
          </Stack>
        )}
        {step === 2 && (
          <Stack spacing={2} sx={{ alignItems: 'center', py: 3 }}>
            <CircularProgress />
            <Typography>Registering and downloading products, users and stock…</Typography>
          </Stack>
        )}
      </Paper>
    </Box>
  );
}
