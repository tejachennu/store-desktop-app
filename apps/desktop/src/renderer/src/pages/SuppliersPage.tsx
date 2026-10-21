import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { STATE_CODES, supplierInputSchema, type SupplierRow } from '@store/shared';
import { useApp } from '../AppState';
import { call, central, errorMessage } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { date, money } from '../lib/format';
import { DataTable } from '../components/DataTable';
import { PageHeader } from '../components/common';

export function SuppliersPage() {
  const { can, info } = useApp();
  const online = !!info?.session?.online;
  const suppliers = useAsync(() => call('catalog.suppliers', {}), []);
  const [editing, setEditing] = useState<SupplierRow | 'new' | null>(null);
  const [ledger, setLedger] = useState<SupplierRow | null>(null);
  return (
    <Box>
      <PageHeader
        title="Suppliers"
        actions={
          can('suppliers.manage') && (
            <Button variant="contained" startIcon={<AddIcon />} disabled={!online} onClick={() => setEditing('new')}>
              New supplier
            </Button>
          )
        }
      />
      <DataTable
        rows={suppliers.data ?? []}
        loading={suppliers.loading}
        rowKey={(r) => r.id}
        onRowClick={(r) => (can('suppliers.manage') && online ? setEditing(r) : setLedger(r))}
        columns={[
          { key: 'name', label: 'Name' },
          { key: 'gstin', label: 'GSTIN' },
          { key: 'stateCode', label: 'State', render: (r) => (r.stateCode ? STATE_CODES[r.stateCode] ?? r.stateCode : '') },
          { key: 'phone', label: 'Phone' },
          { key: 'email', label: 'Email' },
          { key: 'isActive', label: 'Status', render: (r) => (r.isActive ? <Chip size="small" color="success" label="Active" /> : <Chip size="small" label="Inactive" />) },
          {
            key: 'ledger',
            label: '',
            sortable: false,
            render: (r) => (
              <Button size="small" disabled={!online} onClick={(e) => (e.stopPropagation(), setLedger(r))}>
                Ledger
              </Button>
            ),
          },
        ]}
      />
      {editing && <SupplierDialog supplier={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), void call('sync.now').finally(() => void suppliers.reload()))} />}
      {ledger && <LedgerDialog supplier={ledger} onClose={() => setLedger(null)} />}
    </Box>
  );
}

function SupplierDialog({ supplier, onClose, onSaved }: { supplier: SupplierRow | null; onClose: () => void; onSaved: () => void }) {
  const { notify } = useApp();
  const [f, setF] = useState({
    name: supplier?.name ?? '',
    gstin: supplier?.gstin ?? '',
    stateCode: supplier?.stateCode ?? '',
    phone: supplier?.phone ?? '',
    email: supplier?.email ?? '',
    address: supplier?.address ?? '',
    isActive: supplier?.isActive ?? true,
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    const body = { ...f, gstin: f.gstin || null, stateCode: f.stateCode || (f.gstin ? f.gstin.slice(0, 2) : null), phone: f.phone || null, email: f.email || null, address: f.address || null };
    const check = supplierInputSchema.safeParse(body);
    if (!check.success) return setError(check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    try {
      if (supplier) await central('PUT', `/api/suppliers/${supplier.id}`, body);
      else await central('POST', '/api/suppliers', body);
      notify('Supplier saved');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{supplier ? 'Edit supplier' : 'New supplier'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField label="Name" value={f.name} onChange={set('name')} autoFocus />
          <Stack direction="row" spacing={2}>
            <TextField label="GSTIN" value={f.gstin} onChange={set('gstin')} fullWidth />
            <TextField select slotProps={{ select: { displayEmpty: true }, inputLabel: { shrink: true } }} label="State" value={f.stateCode} onChange={set('stateCode')} fullWidth>
              <MenuItem value="">—</MenuItem>
              {Object.entries(STATE_CODES).map(([c, n]) => (
                <MenuItem key={c} value={c}>
                  {c} — {n}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
          <Stack direction="row" spacing={2}>
            <TextField label="Phone" value={f.phone} onChange={set('phone')} fullWidth />
            <TextField label="Email" value={f.email} onChange={set('email')} fullWidth />
          </Stack>
          <TextField label="Address" value={f.address} onChange={set('address')} multiline minRows={2} />
          <FormControlLabel control={<Switch checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />} label="Active" />
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={save} disabled={!f.name.trim()}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function LedgerDialog({ supplier, onClose }: { supplier: SupplierRow; onClose: () => void }) {
  const ledger = useAsync(() => central<any>('GET', `/api/suppliers/${supplier.id}/ledger`), [supplier.id]);
  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Ledger — {supplier.name}</DialogTitle>
      <DialogContent>
        {ledger.error && <Alert severity="error">{ledger.error}</Alert>}
        {ledger.data && (
          <>
            <Typography variant="h6" sx={{ mb: 1 }}>
              Balance payable: {money(ledger.data.balanceDue)}
            </Typography>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Date</TableCell>
                  <TableCell>Type</TableCell>
                  <TableCell>Document</TableCell>
                  <TableCell>Location</TableCell>
                  <TableCell align="right">Purchases</TableCell>
                  <TableCell align="right">Paid / returned</TableCell>
                  <TableCell align="right">Balance</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {ledger.data.entries.map((e: any) => (
                  <TableRow key={`${e.kind}-${e.id}`}>
                    <TableCell>{date(e.date)}</TableCell>
                    <TableCell>{e.kind.replace('_', ' ').toLowerCase()}</TableCell>
                    <TableCell>
                      {e.docNo} {e.reference ? `· ${e.reference}` : ''}
                    </TableCell>
                    <TableCell>{e.locationName}</TableCell>
                    <TableCell align="right">{Number(e.credit) ? money(e.credit) : ''}</TableCell>
                    <TableCell align="right">{Number(e.debit) ? money(e.debit) : ''}</TableCell>
                    <TableCell align="right">{money(e.balance)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
