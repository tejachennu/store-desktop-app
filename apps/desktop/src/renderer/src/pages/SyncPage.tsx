import { useState } from 'react';
import { Alert, Box, Button, Chip, Grid, Stack, Tab, Tabs, Tooltip, Typography } from '@mui/material';
import SyncIcon from '@mui/icons-material/Sync';
import ReplayIcon from '@mui/icons-material/Replay';
import { useApp } from '../AppState';
import { call, central, errorMessage } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { dateTime, relative } from '../lib/format';
import { DataTable } from '../components/DataTable';
import { ErrorAlert, OnlineRequired, PageHeader, StatCard, SyncChip } from '../components/common';

export function SyncPage() {
  const { sync, can, info, notify } = useApp();
  const [tab, setTab] = useState(0);
  const [busy, setBusy] = useState(false);
  const status = (['PENDING', 'FAILED', 'SYNCED'] as const)[tab];
  const outbox = useAsync(() => (tab < 3 ? (call('sync.outbox', { status }) as Promise<any[]>) : Promise.resolve([])), [tab, sync?.pending, sync?.failed]);
  const log = useAsync(() => (tab === 3 ? (call('sync.log') as Promise<any[]>) : Promise.resolve([])), [tab]);

  const syncNow = async () => {
    setBusy(true);
    try {
      const s = await call('sync.now');
      notify(s.state === 'idle' ? 'Synchronised with the central server' : `Sync incomplete: ${s.lastError ?? s.state}`, s.state === 'idle' ? 'success' : 'warning');
    } catch (err) {
      notify(errorMessage(err), 'error');
    } finally {
      setBusy(false);
      void outbox.reload();
    }
  };

  return (
    <Box>
      <PageHeader
        title="Synchronisation"
        subtitle="Transactions are saved on this computer first and uploaded in order. Each has a unique id, so retries never create duplicates."
        actions={
          <Button variant="contained" startIcon={<SyncIcon />} onClick={syncNow} disabled={busy}>
            Sync now
          </Button>
        }
      />
      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard label="Connection" value={sync?.state === 'offline' ? 'Offline' : sync?.state === 'syncing' ? 'Syncing' : sync?.online ? 'Online' : sync?.state ?? '—'} hint={sync?.nextRetryAt ? `next retry ${dateTime(sync.nextRetryAt)}` : undefined} />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard label="Waiting to upload" value={sync?.pending ?? 0} />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard label="Failed (needs attention)" value={sync?.failed ?? 0} color="#c62828" />
        </Grid>
        <Grid size={{ xs: 6, md: 3 }}>
          <StatCard label="Last successful sync" value={relative(sync?.lastSyncAt)} hint={sync?.lastSyncAt ? dateTime(sync.lastSyncAt) : undefined} />
        </Grid>
      </Grid>
      {sync?.lastError && <Alert severity={sync.state === 'offline' ? 'warning' : 'error'} sx={{ mb: 2 }}>{sync.lastError}</Alert>}
      {(sync?.failed ?? 0) > 0 && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Failed transactions were refused by the central server (for example a transfer that was cancelled elsewhere, or a permission change). They remain stored here.
          An administrator can fix the cause and retry them; the server also lists them under Administration → Sync inbox.
        </Alert>
      )}
      <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab label={`Pending (${sync?.pending ?? 0})`} />
        <Tab label={`Failed (${sync?.failed ?? 0})`} />
        <Tab label="Synced" />
        <Tab label="Sync log" />
        <Tab label="Stock check vs central" />
      </Tabs>
      {tab < 3 && (
        <DataTable
          rows={outbox.data ?? []}
          loading={outbox.loading}
          rowKey={(r) => r.id}
          toolbar={
            tab === 1 &&
            can('sync.admin') && (
              <Button
                startIcon={<ReplayIcon />}
                onClick={async () => {
                  const r = await call('sync.retry', {});
                  notify(`${r.requeued} transaction(s) queued for retry`);
                  void outbox.reload();
                }}
              >
                Retry all failed
              </Button>
            )
          }
          columns={[
            { key: 'seq', label: '#', align: 'right' },
            { key: 'type', label: 'Transaction', render: (r) => r.type.replace('.', ' · ').replace(/_/g, ' ') },
            { key: 'doc', label: 'Document', value: (r) => r.payload.invoiceNo ?? r.payload.returnNo ?? r.payload.grnNo ?? r.payload.transferNo ?? r.payload.adjustmentNo ?? r.payload.name ?? r.payload.transferId ?? '' },
            { key: 'createdAt', label: 'Created', render: (r) => dateTime(r.createdAt) },
            { key: 'attempts', label: 'Attempts', align: 'right' },
            { key: 'status', label: 'Status', render: (r) => <SyncChip status={r.status} /> },
            { key: 'lastError', label: 'Last error', render: (r) => (r.lastError ? <Tooltip title={r.lastError}><Typography variant="body2" color="error" noWrap sx={{ maxWidth: 360 }}>{r.lastError}</Typography></Tooltip> : '') },
            {
              key: 'act',
              label: '',
              sortable: false,
              render: (r) =>
                r.status === 'FAILED' && can('sync.admin') ? (
                  <Button size="small" onClick={async () => (await call('sync.retry', { ids: [r.id] }), void outbox.reload())}>
                    Retry
                  </Button>
                ) : null,
            },
          ]}
        />
      )}
      {tab === 3 && (
        <DataTable
          rows={log.data ?? []}
          loading={log.loading}
          rowKey={(r) => String(r.id)}
          columns={[
            { key: 'at', label: 'Time', render: (r) => dateTime(r.at) },
            { key: 'level', label: 'Level', render: (r) => <Chip size="small" label={r.level} color={r.level === 'error' ? 'error' : r.level === 'warn' ? 'warning' : 'default'} /> },
            { key: 'kind', label: 'Area' },
            { key: 'message', label: 'Message' },
          ]}
        />
      )}
      {tab === 4 && <StockReconcile online={!!info?.session?.online} />}
      {can('sync.admin') && <ServerInbox online={!!info?.session?.online} />}
    </Box>
  );
}

/** Compare this location's local stock with the central ledger (differences are expected only while events are pending). */
function StockReconcile({ online }: { online: boolean }) {
  const data = useAsync(async () => (online ? call('sync.stockReconcile') : null), [online]);
  return (
    <OnlineRequired online={online}>
      <ErrorAlert error={data.error} onRetry={data.reload} />
      {data.data && (
        <>
          <Alert severity={data.data.rows.length === 0 ? 'success' : data.data.pendingEvents > 0 ? 'info' : 'warning'} sx={{ mb: 2 }}>
            {data.data.rows.length === 0
              ? 'Local stock matches the central ledger for every product.'
              : data.data.pendingEvents > 0
                ? `${data.data.rows.length} product(s) differ — ${data.data.pendingEvents} transaction(s) are still waiting to upload. Sync and check again.`
                : `${data.data.rows.length} product(s) differ although everything is synchronised. Review failed transactions, then correct with a stock adjustment after a physical count.`}
          </Alert>
          <DataTable
            rows={data.data.rows}
            rowKey={(r) => r.productId}
            columns={[
              { key: 'sku', label: 'SKU' },
              { key: 'name', label: 'Product' },
              { key: 'local', label: 'This computer', align: 'right' },
              { key: 'central', label: 'Central', align: 'right' },
              { key: 'diff', label: 'Difference', align: 'right', value: (r) => r.local - r.central },
            ]}
          />
        </>
      )}
    </OnlineRequired>
  );
}

function ServerInbox({ online }: { online: boolean }) {
  const inbox = useAsync(async () => (online ? central<any[]>('GET', '/api/sync/inbox?status=REJECTED') : []), [online]);
  const devices = useAsync(async () => (online ? central<any[]>('GET', '/api/devices') : []), [online]);
  if (!online) return null;
  return (
    <Box sx={{ mt: 4 }}>
      <Typography variant="h6" sx={{ mb: 1 }}>
        Company-wide sync health
      </Typography>
      <Stack spacing={2}>
        <DataTable
          rows={devices.data ?? []}
          loading={devices.loading}
          rowKey={(r) => r.id}
          searchable={false}
          columns={[
            { key: 'locationName', label: 'Location' },
            { key: 'name', label: 'Computer' },
            { key: 'deviceNo', label: '#', align: 'right' },
            { key: 'lastSeenAt', label: 'Last seen', render: (r) => relative(r.lastSeenAt) },
            { key: 'lastPushAt', label: 'Last upload', render: (r) => relative(r.lastPushAt) },
            { key: 'pendingReported', label: 'Pending', align: 'right' },
            { key: 'rejectedEvents', label: 'Rejected', align: 'right' },
            { key: 'appVersion', label: 'Version' },
            { key: 'isActive', label: 'Status', render: (r) => (r.isActive ? <Chip size="small" color="success" label="Active" /> : <Chip size="small" label="Disabled" />) },
          ]}
        />
        <DataTable
          rows={inbox.data ?? []}
          loading={inbox.loading}
          rowKey={(r) => r.id}
          searchPlaceholder="Search rejected events…"
          empty="No rejected events on the server"
          columns={[
            { key: 'receivedAt', label: 'Received', render: (r) => dateTime(r.receivedAt) },
            { key: 'locationName', label: 'Location' },
            { key: 'deviceName', label: 'Computer' },
            { key: 'eventType', label: 'Type' },
            { key: 'userName', label: 'User' },
            { key: 'attempts', label: 'Attempts', align: 'right' },
            { key: 'error', label: 'Reason' },
          ]}
        />
      </Stack>
    </Box>
  );
}
