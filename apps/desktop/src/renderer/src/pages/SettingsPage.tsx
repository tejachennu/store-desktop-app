import { useEffect, useState } from 'react';
import { Alert, Box, Button, FormControlLabel, Grid, MenuItem, Paper, Stack, Switch, TextField, Typography } from '@mui/material';
import BackupIcon from '@mui/icons-material/Backup';
import RestoreIcon from '@mui/icons-material/Restore';
import FolderOpenIcon from '@mui/icons-material/FolderOpen';
import { useApp } from '../AppState';
import { call, errorMessage } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { dateTime } from '../lib/format';
import { DataTable } from '../components/DataTable';
import { ConfirmDialog, PageHeader } from '../components/common';

type Prefs = Awaited<ReturnType<typeof loadPrefs>>;
const loadPrefs = () => call('prefs.get');

export function SettingsPage() {
  const { can, notify, sync } = useApp();
  const backups = useAsync(() => call('backup.list'), []);
  const printers = useAsync(() => call('print.printers'), []);
  const version = useAsync(() => call('app.version'), []);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [restore, setRestore] = useState<{ file: string; info: Awaited<ReturnType<typeof verify>> } | null>(null);
  const [busy, setBusy] = useState(false);
  const verify = (file: string) => call('backup.verify', { file });

  useEffect(() => {
    void loadPrefs().then(setPrefs);
  }, []);

  const savePrefs = async (patch: Partial<Prefs>) => {
    try {
      setPrefs(await call('prefs.set', patch));
      notify('Preferences saved');
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
  };

  const backupNow = async () => {
    setBusy(true);
    try {
      const b = await call('backup.now');
      notify(`Backup created: ${b.name}`);
      void backups.reload();
    } catch (err) {
      notify(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const pickRestore = async (file?: string) => {
    try {
      const chosen = file ?? (await call('backup.chooseFile'));
      if (!chosen) return;
      setRestore({ file: chosen, info: await verify(chosen) });
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
  };

  return (
    <Box>
      <PageHeader title="Settings & backup" subtitle="Preferences for this computer. Company-wide settings are under Administration." />
      <Grid container spacing={2}>
        <Grid size={{ xs: 12, lg: 6 }}>
          <Paper sx={{ p: 2 }}>
            <Typography variant="h6" sx={{ mb: 2 }}>
              Receipt printer
            </Typography>
            {prefs && (
              <Stack spacing={2}>
                <TextField select label="Printer" value={prefs.receiptPrinter ?? ''} onChange={(e) => savePrefs({ receiptPrinter: e.target.value || null })}>
                  <MenuItem value="">System default</MenuItem>
                  {(printers.data ?? []).map((p) => (
                    <MenuItem key={p.name} value={p.name}>
                      {p.name}
                      {p.isDefault ? ' (default)' : ''}
                    </MenuItem>
                  ))}
                </TextField>
                <TextField select label="Paper width" value={prefs.receiptWidthMm} onChange={(e) => savePrefs({ receiptWidthMm: Number(e.target.value) as 58 | 80 })}>
                  <MenuItem value={80}>80 mm thermal</MenuItem>
                  <MenuItem value={58}>58 mm thermal</MenuItem>
                </TextField>
                <FormControlLabel control={<Switch checked={prefs.silentPrint} onChange={(e) => savePrefs({ silentPrint: e.target.checked })} />} label="Print receipts without showing the print dialog" />
              </Stack>
            )}
          </Paper>
          <Paper sx={{ p: 2, mt: 2 }}>
            <Typography variant="h6" sx={{ mb: 2 }}>
              Synchronisation & backups
            </Typography>
            {prefs && (
              <Stack direction="row" spacing={2}>
                <TextField label="Sync every (seconds)" defaultValue={prefs.syncIntervalSec} onBlur={(e) => savePrefs({ syncIntervalSec: Math.max(10, Number(e.target.value) || 30) })} helperText="Applies after restart" />
                <TextField label="Automatic backup every (hours)" defaultValue={prefs.autoBackupHours} onBlur={(e) => savePrefs({ autoBackupHours: Math.max(1, Number(e.target.value) || 24) })} />
                <TextField label="Keep automatic backups" defaultValue={prefs.backupRetention} onBlur={(e) => savePrefs({ backupRetention: Math.max(1, Number(e.target.value) || 14) })} />
              </Stack>
            )}
          </Paper>
          <Paper sx={{ p: 2, mt: 2 }}>
            <Typography variant="h6">About</Typography>
            <Typography variant="body2">Store Manager {version.data?.version} (Electron {version.data?.electron})</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
              Data folder: {version.data?.dataDir}
            </Typography>
            <Button startIcon={<FolderOpenIcon />} sx={{ mt: 1 }} onClick={() => call('app.openDataDir')}>
              Open data folder
            </Button>
          </Paper>
        </Grid>
        <Grid size={{ xs: 12, lg: 6 }}>
          <Paper sx={{ p: 2 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
              <Typography variant="h6" sx={{ flex: 1 }}>
                Local database backups
              </Typography>
              <Button variant="contained" startIcon={<BackupIcon />} onClick={backupNow} disabled={busy}>
                Back up now
              </Button>
              {can('settings.manage') && (
                <Button startIcon={<RestoreIcon />} onClick={() => pickRestore()}>
                  Restore from file…
                </Button>
              )}
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Backups are verified (SQLite integrity check) when created and before restoring. All transactions are also stored centrally once synchronised.
            </Typography>
            <DataTable
              rows={backups.data ?? []}
              loading={backups.loading}
              searchable={false}
              rowKey={(r) => r.file}
              columns={[
                { key: 'name', label: 'Backup' },
                { key: 'createdAt', label: 'Created', render: (r) => dateTime(r.createdAt) },
                { key: 'sizeBytes', label: 'Size', align: 'right', render: (r) => `${(r.sizeBytes / 1024 / 1024).toFixed(1)} MB` },
                {
                  key: 'act',
                  label: '',
                  sortable: false,
                  render: (r) =>
                    can('settings.manage') && (
                      <Button size="small" onClick={() => pickRestore(r.file)}>
                        Restore
                      </Button>
                    ),
                },
              ]}
            />
          </Paper>
        </Grid>
      </Grid>
      <ConfirmDialog
        open={!!restore}
        title="Restore this backup?"
        danger
        confirmLabel="Restore"
        message={
          restore && (
            <Stack spacing={1}>
              <span>{restore.file}</span>
              <Alert severity="success">Integrity check passed · {restore.info.sales} sales in backup</Alert>
              {(sync?.pending ?? 0) > 0 && (
                <Alert severity="error">
                  {sync?.pending} transaction(s) on this computer have not been uploaded yet and would be lost. Sync first; the restore is blocked until then.
                </Alert>
              )}
              <span>
                The current database is kept as a "pre-restore" backup. Transactions synchronised after this backup was taken are downloaded again from the
                central server so stock stays correct.
              </span>
            </Stack>
          )
        }
        onClose={() => setRestore(null)}
        onConfirm={async () => {
          const r = await call('backup.restore', { file: restore!.file, confirm: true });
          notify(`Restored. Previous database saved as ${r.preRestoreFile}`);
          void backups.reload();
        }}
      />
    </Box>
  );
}
