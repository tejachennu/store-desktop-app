import { useEffect, useState } from 'react';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Stack, TextField } from '@mui/material';
import { STATE_CODES, type CustomerRow } from '@store/shared';
import { call, errorMessage } from '../lib/api';

/** Create or edit a customer. Works offline; the record syncs to the central server later. */
export function CustomerDialog({
  open,
  initial,
  onClose,
  onSaved,
}: {
  open: boolean;
  initial?: Partial<CustomerRow> | null;
  onClose: () => void;
  onSaved: (c: CustomerRow) => void;
}) {
  const [form, setForm] = useState({ name: '', phone: '', email: '', gstin: '', stateCode: '', address: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open)
      setForm({
        name: initial?.name ?? '',
        phone: initial?.phone ?? '',
        email: initial?.email ?? '',
        gstin: initial?.gstin ?? '',
        stateCode: initial?.stateCode ?? '',
        address: initial?.address ?? '',
      });
    setError(null);
  }, [open, initial]);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const gstin = form.gstin.trim().toUpperCase();
      const saved = await call('customers.save', {
        id: initial?.id,
        name: form.name,
        phone: form.phone || null,
        email: form.email || null,
        gstin: gstin || null,
        // GSTIN starts with the state code; use it when no state was chosen.
        stateCode: form.stateCode || (gstin ? gstin.slice(0, 2) : null),
        address: form.address || null,
      });
      onSaved(saved);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{initial?.id ? 'Edit customer' : 'New customer'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField label="Name" value={form.name} onChange={set('name')} autoFocus required />
          <Stack direction="row" spacing={2}>
            <TextField label="Phone" value={form.phone} onChange={set('phone')} fullWidth />
            <TextField label="Email" value={form.email} onChange={set('email')} fullWidth />
          </Stack>
          <Stack direction="row" spacing={2}>
            <TextField label="GSTIN (for B2B invoices)" value={form.gstin} onChange={set('gstin')} fullWidth />
            <TextField select label="State (place of supply)" value={form.stateCode} onChange={set('stateCode')} fullWidth>
              <MenuItem value="">Same as branch</MenuItem>
              {Object.entries(STATE_CODES).map(([code, name]) => (
                <MenuItem key={code} value={code}>
                  {code} — {name}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
          <TextField label="Address" value={form.address} onChange={set('address')} multiline minRows={2} />
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={save} disabled={busy || !form.name.trim()}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
