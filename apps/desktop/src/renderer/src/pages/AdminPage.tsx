import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  FormGroup,
  Grid,
  MenuItem,
  Paper,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import {
  companySettingsSchema,
  locationInputSchema,
  ROLE_LABELS,
  ROLES,
  STATE_CODES,
  type CompanySettings,
  type LocationRow,
  type Role,
  type UserRow,
} from '@store/shared';
import { useApp } from '../AppState';
import { central, errorMessage } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { dateTime, relative } from '../lib/format';
import { DataTable } from '../components/DataTable';
import { ConfirmDialog, ErrorAlert, OnlineRequired, PageHeader } from '../components/common';

const zodMessage = (issues: { path: PropertyKey[]; message: string }[]) => issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');

export function AdminPage() {
  const { info, can } = useApp();
  const [tab, setTab] = useState(0);
  const online = !!info?.session?.online;
  if (!can('users.manage')) return <Alert severity="warning">Administration is available to company administrators only.</Alert>;
  return (
    <Box>
      <PageHeader title="Administration" subtitle="Company-wide settings, warehouses & branches, users and registered computers (central server)." />
      <OnlineRequired online={online}>
        <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ mb: 2 }}>
          <Tab label="Company & GST" />
          <Tab label="Warehouses & branches" />
          <Tab label="Users & roles" />
          <Tab label="Registered computers" />
        </Tabs>
        {tab === 0 && <CompanySettingsTab />}
        {tab === 1 && <LocationsTab />}
        {tab === 2 && <UsersTab />}
        {tab === 3 && <DevicesTab />}
      </OnlineRequired>
    </Box>
  );
}

function CompanySettingsTab() {
  const { notify, refresh } = useApp();
  const data = useAsync(() => central<CompanySettings>('GET', '/api/settings'), []);
  const [f, setF] = useState<CompanySettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setF(data.data), [data.data]);
  if (!f) return <ErrorAlert error={data.error} />;
  const set = (k: keyof CompanySettings, v: unknown) => setF({ ...f, [k]: v });
  const save = async () => {
    const body = { ...f, gstin: f.gstin || null, address: f.address || null, phone: f.phone || null, receiptFooter: f.receiptFooter || null };
    const check = companySettingsSchema.safeParse(body);
    if (!check.success) return setError(zodMessage(check.error.issues));
    try {
      await central('PUT', '/api/settings', body);
      setError(null);
      notify('Settings saved — all computers receive them on their next sync');
      void refresh();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Paper sx={{ p: 3, maxWidth: 900 }}>
      <Grid container spacing={2}>
        <Grid size={8}>
          <TextField fullWidth label="Company name" value={f.name} onChange={(e) => set('name', e.target.value)} />
        </Grid>
        <Grid size={4}>
          <TextField fullWidth label="Company GSTIN" value={f.gstin ?? ''} onChange={(e) => set('gstin', e.target.value)} />
        </Grid>
        <Grid size={4}>
          <TextField fullWidth select label="Registered state" value={f.stateCode} onChange={(e) => set('stateCode', e.target.value)}>
            {Object.entries(STATE_CODES).map(([c, n]) => (
              <MenuItem key={c} value={c}>
                {c} — {n}
              </MenuItem>
            ))}
          </TextField>
        </Grid>
        <Grid size={4}>
          <TextField fullWidth label="Phone" value={f.phone ?? ''} onChange={(e) => set('phone', e.target.value)} />
        </Grid>
        <Grid size={4}>
          <TextField fullWidth label="Default low-stock level" value={f.defaultLowStockLevel} onChange={(e) => set('defaultLowStockLevel', Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
        </Grid>
        <Grid size={12}>
          <TextField fullWidth label="Address" value={f.address ?? ''} onChange={(e) => set('address', e.target.value)} />
        </Grid>
        <Grid size={12}>
          <TextField fullWidth label="Receipt footer" value={f.receiptFooter ?? ''} onChange={(e) => set('receiptFooter', e.target.value)} />
        </Grid>
        <Grid size={12}>
          <Typography variant="subtitle2" sx={{ mt: 1 }}>
            Business rules
          </Typography>
          <FormGroup>
            <FormControlLabel control={<Switch checked={f.branchToBranchEnabled} onChange={(e) => set('branchToBranchEnabled', e.target.checked)} />} label="Allow branch-to-branch transfers" />
            <FormControlLabel control={<Switch checked={f.branchToWarehouseEnabled} onChange={(e) => set('branchToWarehouseEnabled', e.target.checked)} />} label="Allow branches to return stock to warehouses" />
            <FormControlLabel control={<Switch checked={f.roundToRupee} onChange={(e) => set('roundToRupee', e.target.checked)} />} label="Round invoice totals to the nearest rupee" />
            <FormControlLabel
              control={<Switch checked={f.allowNegativeStock} onChange={(e) => set('allowNegativeStock', e.target.checked)} />}
              label="Allow selling / dispatching beyond recorded stock (not recommended)"
            />
          </FormGroup>
        </Grid>
      </Grid>
      {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
      <Button variant="contained" onClick={save} sx={{ mt: 2 }}>
        Save settings
      </Button>
    </Paper>
  );
}

function LocationsTab() {
  const data = useAsync(() => central<LocationRow[]>('GET', '/api/locations'), []);
  const [editing, setEditing] = useState<LocationRow | 'new' | null>(null);
  return (
    <>
      <DataTable
        rows={data.data ?? []}
        loading={data.loading}
        rowKey={(r) => r.id}
        onRowClick={(r) => setEditing(r)}
        toolbar={
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => setEditing('new')}>
            Add warehouse / branch
          </Button>
        }
        columns={[
          { key: 'code', label: 'Code' },
          { key: 'name', label: 'Name' },
          { key: 'type', label: 'Type', render: (r) => <Chip size="small" label={r.type === 'WAREHOUSE' ? 'Warehouse (gudovun)' : 'Selling branch'} color={r.type === 'WAREHOUSE' ? 'primary' : 'secondary'} /> },
          { key: 'stateCode', label: 'State', render: (r) => STATE_CODES[r.stateCode] ?? r.stateCode },
          { key: 'gstin', label: 'GSTIN' },
          { key: 'invoicePrefix', label: 'Invoice prefix' },
          { key: 'canReceivePurchases', label: 'Receives purchases', render: (r) => (r.canReceivePurchases ? 'Yes' : 'No') },
          { key: 'isActive', label: 'Status', render: (r) => (r.isActive ? <Chip size="small" color="success" label="Active" /> : <Chip size="small" label="Inactive" />) },
        ]}
      />
      {editing && <LocationDialog location={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), void data.reload())} />}
    </>
  );
}

function LocationDialog({ location, onClose, onSaved }: { location: LocationRow | null; onClose: () => void; onSaved: () => void }) {
  const { notify } = useApp();
  const [f, setF] = useState({
    code: location?.code ?? '',
    name: location?.name ?? '',
    type: location?.type ?? 'BRANCH',
    address: location?.address ?? '',
    stateCode: location?.stateCode ?? '36',
    gstin: location?.gstin ?? '',
    phone: location?.phone ?? '',
    invoicePrefix: location?.invoicePrefix ?? '',
    canReceivePurchases: location?.canReceivePurchases ?? true,
    isActive: location?.isActive ?? true,
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    const body = { ...f, address: f.address || null, gstin: f.gstin || null, phone: f.phone || null };
    const check = locationInputSchema.safeParse(body);
    if (!check.success) return setError(zodMessage(check.error.issues));
    try {
      if (location) await central('PUT', `/api/locations/${location.id}`, body);
      else await central('POST', '/api/locations', body);
      notify('Location saved');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{location ? `Edit ${location.name}` : 'New warehouse or branch'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Stack direction="row" spacing={2}>
            <TextField select label="Type" value={f.type} onChange={set('type')} sx={{ width: 220 }}>
              <MenuItem value="WAREHOUSE">Warehouse (gudovun)</MenuItem>
              <MenuItem value="BRANCH">Selling branch</MenuItem>
            </TextField>
            <TextField label="Code" value={f.code} onChange={set('code')} helperText="2-6 letters/digits" />
            <TextField label="Invoice prefix" value={f.invoicePrefix} onChange={set('invoicePrefix')} helperText="Keep ≤ 3 chars for GST 16-char limit" />
          </Stack>
          <TextField label="Name" value={f.name} onChange={set('name')} />
          <TextField label="Address" value={f.address} onChange={set('address')} />
          <Stack direction="row" spacing={2}>
            <TextField select label="State" value={f.stateCode} onChange={set('stateCode')} fullWidth>
              {Object.entries(STATE_CODES).map(([c, n]) => (
                <MenuItem key={c} value={c}>
                  {c} — {n}
                </MenuItem>
              ))}
            </TextField>
            <TextField label="GSTIN" value={f.gstin} onChange={set('gstin')} fullWidth />
            <TextField label="Phone" value={f.phone} onChange={set('phone')} fullWidth />
          </Stack>
          <FormControlLabel control={<Switch checked={f.canReceivePurchases} onChange={(e) => setF({ ...f, canReceivePurchases: e.target.checked })} />} label="Authorised to receive supplier purchases" />
          <FormControlLabel control={<Switch checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />} label="Active" />
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={save}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

type AdminUser = UserRow & { lastLoginAt: string | null; lockedUntil: string | null };

function UsersTab() {
  const users = useAsync(() => central<AdminUser[]>('GET', '/api/users'), []);
  const locations = useAsync(() => central<LocationRow[]>('GET', '/api/locations'), []);
  const [editing, setEditing] = useState<AdminUser | 'new' | null>(null);
  const locName = (id: string) => locations.data?.find((l) => l.id === id)?.name ?? id;
  return (
    <>
      <DataTable
        rows={users.data ?? []}
        loading={users.loading}
        rowKey={(r) => r.id}
        onRowClick={(r) => setEditing(r)}
        toolbar={
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => setEditing('new')}>
            New user
          </Button>
        }
        columns={[
          { key: 'fullName', label: 'Name' },
          { key: 'username', label: 'Username' },
          { key: 'role', label: 'Role', render: (r) => ROLE_LABELS[r.role] },
          { key: 'locations', label: 'Locations', value: (r) => (r.allLocations ? 'All' : r.locationIds.map(locName).join(', ')) },
          { key: 'lastLoginAt', label: 'Last sign-in', render: (r) => relative(r.lastLoginAt) },
          { key: 'isActive', label: 'Status', render: (r) => (!r.isActive ? <Chip size="small" label="Inactive" /> : r.lockedUntil && new Date(r.lockedUntil) > new Date() ? <Chip size="small" color="warning" label="Locked" /> : <Chip size="small" color="success" label="Active" />) },
        ]}
      />
      {editing && (
        <UserDialog user={editing === 'new' ? null : editing} locations={locations.data ?? []} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), void users.reload())} />
      )}
    </>
  );
}

function UserDialog({ user, locations, onClose, onSaved }: { user: AdminUser | null; locations: LocationRow[]; onClose: () => void; onSaved: () => void }) {
  const { notify } = useApp();
  const [f, setF] = useState({
    username: user?.username ?? '',
    fullName: user?.fullName ?? '',
    password: '',
    role: (user?.role ?? 'SALES_STAFF') as Role,
    allLocations: user?.allLocations ?? false,
    locationIds: user?.locationIds ?? [],
    isActive: user?.isActive ?? true,
  });
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      const body: Record<string, unknown> = { fullName: f.fullName, role: f.role, allLocations: f.role === 'COMPANY_ADMIN' ? true : f.allLocations, locationIds: f.locationIds, isActive: f.isActive };
      if (user) {
        if (f.password) body.password = f.password;
        await central('PUT', `/api/users/${user.id}`, body);
      } else {
        await central('POST', '/api/users', { ...body, username: f.username, password: f.password });
      }
      notify('User saved');
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const toggleLoc = (id: string) => setF({ ...f, locationIds: f.locationIds.includes(id) ? f.locationIds.filter((x) => x !== id) : [...f.locationIds, id] });
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{user ? `Edit ${user.fullName}` : 'New user'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Stack direction="row" spacing={2}>
            <TextField label="Username" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} disabled={!!user} fullWidth />
            <TextField label="Full name" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} fullWidth />
          </Stack>
          <TextField
            type="password"
            label={user ? 'Reset password (leave blank to keep)' : 'Password'}
            helperText="At least 8 characters with letters and digits. Resetting signs the user out everywhere."
            value={f.password}
            onChange={(e) => setF({ ...f, password: e.target.value })}
          />
          <TextField select label="Role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })}>
            {ROLES.map((r) => (
              <MenuItem key={r} value={r}>
                {ROLE_LABELS[r]}
              </MenuItem>
            ))}
          </TextField>
          {f.role !== 'COMPANY_ADMIN' && (
            <>
              <FormControlLabel control={<Switch checked={f.allLocations} onChange={(e) => setF({ ...f, allLocations: e.target.checked })} />} label="Access to all locations" />
              {!f.allLocations && (
                <Paper sx={{ p: 1.5 }}>
                  <Typography variant="subtitle2">Assigned locations</Typography>
                  <FormGroup>
                    {locations.map((l) => (
                      <FormControlLabel key={l.id} control={<Checkbox checked={f.locationIds.includes(l.id)} onChange={() => toggleLoc(l.id)} />} label={`${l.type === 'WAREHOUSE' ? 'Warehouse' : 'Branch'} — ${l.name}`} />
                    ))}
                  </FormGroup>
                </Paper>
              )}
            </>
          )}
          <FormControlLabel control={<Switch checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />} label="Active" />
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={save}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function DevicesTab() {
  const { notify } = useApp();
  const devices = useAsync(() => central<any[]>('GET', '/api/devices'), []);
  const [toggle, setToggle] = useState<any | null>(null);
  return (
    <>
      <Alert severity="info" sx={{ mb: 2 }}>
        Each computer is registered to one warehouse or branch and syncs with its own device key. Disable a lost or retired computer to block it immediately.
      </Alert>
      <DataTable
        rows={devices.data ?? []}
        loading={devices.loading}
        rowKey={(r) => r.id}
        columns={[
          { key: 'locationName', label: 'Location' },
          { key: 'name', label: 'Computer' },
          { key: 'deviceNo', label: 'No.', align: 'right' },
          { key: 'createdAt', label: 'Registered', render: (r) => dateTime(r.createdAt) },
          { key: 'lastSeenAt', label: 'Last seen', render: (r) => relative(r.lastSeenAt) },
          { key: 'pendingReported', label: 'Pending', align: 'right' },
          { key: 'appVersion', label: 'Version' },
          {
            key: 'isActive',
            label: 'Status',
            render: (r) => (
              <Button size="small" color={r.isActive ? 'error' : 'success'} onClick={() => setToggle(r)}>
                {r.isActive ? 'Disable' : 'Enable'}
              </Button>
            ),
          },
        ]}
      />
      <ConfirmDialog
        open={!!toggle}
        title={toggle?.isActive ? 'Disable this computer?' : 'Enable this computer?'}
        message={toggle?.isActive ? `${toggle?.name} will no longer be able to synchronise. Unsynced transactions on it stay on that computer.` : `${toggle?.name} will be able to synchronise again.`}
        danger={toggle?.isActive}
        onClose={() => setToggle(null)}
        onConfirm={async () => {
          await central('PUT', `/api/devices/${toggle.id}`, { isActive: !toggle.isActive });
          notify('Updated');
          void devices.reload();
        }}
      />
    </>
  );
}
