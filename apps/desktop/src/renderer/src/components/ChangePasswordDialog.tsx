import { useState } from 'react';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField } from '@mui/material';
import { passwordSchema } from '@store/shared';
import { call, errorMessage } from '../lib/api';
import { useApp } from '../AppState';

export function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { notify } = useApp();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => {
    setCurrent('');
    setNext('');
    setConfirm('');
    setError(null);
    onClose();
  };
  const submit = async () => {
    const check = passwordSchema.safeParse(next);
    if (!check.success) return setError(check.error.issues[0].message);
    if (next !== confirm) return setError('The new passwords do not match');
    setBusy(true);
    try {
      await call('auth.changePassword', { currentPassword: current, newPassword: next });
      notify('Password changed');
      close();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={close} maxWidth="xs" fullWidth>
      <DialogTitle>Change password</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField type="password" label="Current password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus />
          <TextField type="password" label="New password" helperText="At least 8 characters with letters and digits" value={next} onChange={(e) => setNext(e.target.value)} />
          <TextField type="password" label="Confirm new password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>Cancel</Button>
        <Button variant="contained" onClick={submit} disabled={busy || !current || !next}>
          Change password
        </Button>
      </DialogActions>
    </Dialog>
  );
}
