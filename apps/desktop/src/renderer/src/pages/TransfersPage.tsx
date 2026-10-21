import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import SendIcon from '@mui/icons-material/Send';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import PrintIcon from '@mui/icons-material/Print';
import { checkTransferRoute, type LocationRow, type ProductRow, type TransferStatus } from '@store/shared';
import type { ApiResult } from '../../../core/api';
import { useApp } from '../AppState';
import { call, central, errorMessage } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { dateTime, qty } from '../lib/format';
import { DataTable } from '../components/DataTable';
import { ConfirmDialog, ErrorAlert, OnlineRequired, PageHeader, SyncChip, TransferStatusChip } from '../components/common';
import { ProductPicker } from '../components/ProductPicker';

type Detail = ApiResult<'transfers.get'>;
type ListRow = { id: string; transferNo: string; status: TransferStatus; createdAt: string; sourceName: string; destName: string; direction: string; qtyRequested: number; qtyDispatched: number; qtyReceived: number; pendingSync: number };

export function TransfersPage() {
  const { can, info } = useApp();
  const [params] = useSearchParams();
  const [tab, setTab] = useState(params.get('tab') === 'reconciliation' ? 4 : 0);
  const [creating, setCreating] = useState<'REQUEST' | 'DISPATCH' | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const filter = [{ openOnly: true }, { direction: 'INCOMING' as const }, { direction: 'OUTGOING' as const }, {}][tab] ?? {};
  const list = useAsync(() => call('transfers.list', filter) as Promise<ListRow[]>, [tab]);
  const isWarehouse = info?.location?.type === 'WAREHOUSE';

  return (
    <Box>
      <PageHeader
        title="Stock transfers"
        subtitle="Warehouse ↔ warehouse, warehouse → branch and (if enabled) branch ↔ branch. Each step is recorded at the location that performs it."
        actions={
          <>
            {can('transfers.request') && (
              <Button variant="outlined" startIcon={<AddIcon />} onClick={() => setCreating('REQUEST')}>
                Request stock
              </Button>
            )}
            {can('transfers.dispatch') && (
              <Button variant="contained" startIcon={<SendIcon />} onClick={() => setCreating('DISPATCH')}>
                {isWarehouse ? 'Send stock' : 'Send stock out'}
              </Button>
            )}
          </>
        }
      />
      <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab label="Open" />
        <Tab label="Incoming" />
        <Tab label="Outgoing" />
        <Tab label="All" />
        <Tab label="Discrepancies & conflicts" />
      </Tabs>
      {tab < 4 ? (
        <>
          <ErrorAlert error={list.error} onRetry={list.reload} />
          <DataTable
            rows={list.data ?? []}
            loading={list.loading}
            rowKey={(r) => r.id}
            onRowClick={(r) => setOpenId(r.id)}
            columns={[
              { key: 'transferNo', label: 'Transfer' },
              { key: 'createdAt', label: 'Created', render: (r) => dateTime(r.createdAt) },
              { key: 'direction', label: 'Direction', render: (r) => <Chip size="small" variant="outlined" label={r.direction === 'OUTGOING' ? 'Outgoing' : 'Incoming'} /> },
              { key: 'sourceName', label: 'From' },
              { key: 'destName', label: 'To' },
              { key: 'qtyRequested', label: 'Requested', align: 'right' },
              { key: 'qtyDispatched', label: 'Dispatched', align: 'right' },
              { key: 'qtyReceived', label: 'Received', align: 'right' },
              { key: 'status', label: 'Status', render: (r) => <TransferStatusChip status={r.status} /> },
              { key: 'pendingSync', label: '', render: (r) => (r.pendingSync ? <SyncChip status="PENDING" /> : null) },
            ]}
          />
        </>
      ) : (
        <ReconciliationTab />
      )}
      {creating && (
        <CreateTransferDialog
          mode={creating}
          onClose={() => setCreating(null)}
          onCreated={(id) => {
            setCreating(null);
            void list.reload();
            setOpenId(id);
          }}
        />
      )}
      {openId && <TransferDialog id={openId} onClose={() => setOpenId(null)} onChanged={() => void list.reload()} />}
    </Box>
  );
}

function CreateTransferDialog({ mode, onClose, onCreated }: { mode: 'REQUEST' | 'DISPATCH'; onClose: () => void; onCreated: (id: string) => void }) {
  const { info, notify } = useApp();
  const here = info!.location!;
  const locations = useAsync(() => call('catalog.locations'), []);
  const [other, setOther] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<{ product: ProductRow; qtyText: string; available?: number }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const online = !!info?.session?.online;

  const candidates = useMemo(
    () =>
      (locations.data ?? []).filter((l: LocationRow) => {
        if (l.id === here.id || !l.isActive) return false;
        const [src, dst] = mode === 'REQUEST' ? [l, here] : [here, l];
        return checkTransferRoute(src, dst, info!.settings).ok;
      }),
    [locations.data, here, mode, info],
  );

  // When requesting, show what the source has available (from the central server, if online).
  useEffect(() => {
    if (mode !== 'REQUEST' || !other || !online || lines.length === 0) return;
    void Promise.all(
      lines.map(async (l) => {
        const rows = await central<{ available: number }[]>('GET', `/api/stock?locationId=${other}&productId=${l.product.id}`).catch(() => []);
        return rows[0]?.available ?? 0;
      }),
    ).then((avail) => setLines((ls) => ls.map((l, i) => ({ ...l, available: avail[i] }))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [other, lines.length, mode, online]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = lines.map((l) => {
        const q = Math.floor(Number(l.qtyText));
        if (!Number.isFinite(q) || q <= 0) throw new Error(`Enter a quantity for ${l.product.name}`);
        return { productId: l.product.id, qty: q };
      });
      const r = await call('transfers.create', {
        sourceLocationId: mode === 'REQUEST' ? other : here.id,
        destLocationId: mode === 'REQUEST' ? here.id : other,
        notes: notes || null,
        lines: payload,
      });
      notify(mode === 'REQUEST' ? `Stock request ${r.transferNo} created` : `Transfer ${r.transferNo} created — dispatch it when the goods leave`);
      onCreated(r.id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>{mode === 'REQUEST' ? `Request stock for ${here.name}` : `Send stock from ${here.name}`}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField select label={mode === 'REQUEST' ? 'Request from' : 'Send to'} value={other} onChange={(e) => setOther(e.target.value)}>
            {candidates.map((l: LocationRow) => (
              <MenuItem key={l.id} value={l.id}>
                {l.type === 'WAREHOUSE' ? 'Warehouse' : 'Branch'} — {l.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <ProductPicker onPick={(p) => setLines((ls) => (ls.some((l) => l.product.id === p.id) ? ls : [...ls, { product: p, qtyText: '1' }]))} showStock={mode === 'DISPATCH'} />
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Product</TableCell>
                {mode === 'REQUEST' && <TableCell align="right">Available at source</TableCell>}
                {mode === 'DISPATCH' && <TableCell align="right">On hand here</TableCell>}
                <TableCell width={140}>Quantity</TableCell>
                <TableCell width={40} />
              </TableRow>
            </TableHead>
            <TableBody>
              {lines.map((l, i) => (
                <TableRow key={l.product.id}>
                  <TableCell>{l.product.name}</TableCell>
                  {mode === 'REQUEST' && <TableCell align="right">{online ? (l.available ?? '…') : 'offline'}</TableCell>}
                  {mode === 'DISPATCH' && <TableCell align="right">{qty((l.product as { qtyOnHand?: number }).qtyOnHand ?? 0)}</TableCell>}
                  <TableCell>
                    <TextField value={l.qtyText} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qtyText: e.target.value } : x)))} />
                  </TableCell>
                  <TableCell>
                    <IconButton size="small" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {mode === 'DISPATCH' && <Alert severity="info">The quantities are reserved now; stock leaves this location when you record the dispatch.</Alert>}
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={submit} disabled={busy || !other || lines.length === 0}>
          {mode === 'REQUEST' ? 'Send request' : 'Create transfer'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

type Action = 'APPROVE' | 'DISPATCH' | 'RECEIVE';

function TransferDialog({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { can, info, notify } = useApp();
  const t = useAsync(() => call('transfers.get', { id }), [id]);
  const [action, setAction] = useState<Action | null>(null);
  const [amounts, setAmounts] = useState<Record<string, { a: string; b: string }>>({});
  const [confirm, setConfirm] = useState<'REJECT' | 'CANCEL' | 'CLOSE' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const d = t.data;

  const begin = (a: Action) => {
    if (!d) return;
    const init: Record<string, { a: string; b: string }> = {};
    for (const l of d.lines) {
      if (a === 'APPROVE') init[l.id] = { a: String(Math.min(l.qtyRequested, Math.max(0, l.available ?? l.qtyRequested))), b: '' };
      if (a === 'DISPATCH') init[l.id] = { a: String(Math.max(0, Math.min(l.qtyApproved - l.qtyDispatched, l.available ?? Infinity))), b: '' };
      if (a === 'RECEIVE') init[l.id] = { a: String(l.qtyDispatched - l.qtyReceived - l.qtyDamaged), b: '0' };
    }
    setAmounts(init);
    setAction(a);
    setError(null);
  };

  const after = (updated: Detail, msg: string) => {
    t.setData(updated);
    setAction(null);
    notify(msg);
    onChanged();
  };

  const submit = async () => {
    if (!d || !action) return;
    setBusy(true);
    setError(null);
    try {
      const n = (s: string) => {
        const v = Math.floor(Number(s || 0));
        if (!Number.isFinite(v) || v < 0) throw new Error('Quantities must be whole numbers');
        return v;
      };
      if (action === 'APPROVE') after(await call('transfers.approve', { id, lines: d.lines.map((l) => ({ lineId: l.id, qtyApproved: n(amounts[l.id].a) })) }), 'Transfer approved — stock reserved');
      if (action === 'DISPATCH') after(await call('transfers.dispatch', { id, lines: d.lines.map((l) => ({ lineId: l.id, qty: n(amounts[l.id].a) })).filter((l) => l.qty > 0) }), 'Dispatch recorded');
      if (action === 'RECEIVE')
        after(await call('transfers.receive', { id, lines: d.lines.map((l) => ({ lineId: l.id, qtyReceived: n(amounts[l.id].a), qtyDamaged: n(amounts[l.id].b) })).filter((l) => l.qtyReceived + l.qtyDamaged > 0) }), 'Receipt recorded');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const printChallan = async () => {
    if (!d || !info) return;
    const rows = d.lines.map((l, i) => `<tr><td>${i + 1}</td><td>${l.productName}</td><td>${l.sku}</td><td style="text-align:right">${l.qtyApproved || l.qtyRequested}</td><td style="text-align:right">${l.qtyDispatched}</td><td></td></tr>`).join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:'Segoe UI',Arial;font-size:12px}table{width:100%;border-collapse:collapse}td,th{border:1px solid #999;padding:4px}h1{font-size:18px;color:#1565c0}</style></head><body>
      <h1>${info.settings.name}</h1><h2>Stock transfer / delivery challan</h2>
      <p><b>No:</b> ${d.transferNo} &nbsp; <b>Date:</b> ${new Date().toLocaleString('en-IN')}<br><b>From:</b> ${d.sourceName} &nbsp; <b>To:</b> ${d.destName}<br><b>Status:</b> ${d.status}</p>
      <table><thead><tr><th>#</th><th>Product</th><th>SKU</th><th>Approved</th><th>Dispatched</th><th>Received (sign)</th></tr></thead><tbody>${rows}</tbody></table>
      <p style="margin-top:40px">Dispatched by: ____________ &nbsp;&nbsp; Vehicle: ____________ &nbsp;&nbsp; Received by: ____________</p></body></html>`;
    await call('print.html', { html, silent: false });
  };

  if (!d) return null;
  const isSource = d.direction === 'OUTGOING';
  const s = d.status;
  const canApprove = isSource && s === 'REQUESTED' && can('transfers.approve');
  const canDispatch = isSource && ['APPROVED', 'PARTIALLY_DISPATCHED', 'PARTIALLY_RECEIVED'].includes(s) && d.lines.some((l) => l.qtyApproved > l.qtyDispatched) && can('transfers.dispatch');
  const canReceive = !isSource && ['DISPATCHED', 'PARTIALLY_DISPATCHED', 'PARTIALLY_RECEIVED'].includes(s) && d.lines.some((l) => l.qtyDispatched > l.qtyReceived + l.qtyDamaged) && can('transfers.receive');
  const canClose = !isSource && ['DISPATCHED', 'PARTIALLY_DISPATCHED', 'PARTIALLY_RECEIVED'].includes(s) && can('transfers.receive');
  const canCancel = ['REQUESTED', 'APPROVED'].includes(s) && (can('transfers.approve') || can('transfers.request'));
  const shortfall = d.lines.reduce((x, l) => x + Math.max(0, l.qtyDispatched - l.qtyReceived - l.qtyDamaged), 0);

  return (
    <Dialog open onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
        {d.transferNo} <TransferStatusChip status={d.status} />
        {d.pendingSync && <SyncChip status="PENDING" />}
        <Box sx={{ flex: 1 }} />
        <IconButton onClick={printChallan} title="Print delivery challan">
          <PrintIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        <Typography sx={{ mb: 1 }}>
          <b>{d.sourceName}</b> → <b>{d.destName}</b> · created {dateTime(d.createdAt)}
          {d.notes ? ` · ${d.notes}` : ''}
        </Typography>
        {d.statusReason && <Alert severity="info" sx={{ mb: 1 }}>{d.statusReason}</Alert>}
        <ErrorAlert error={t.error} />
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Product</TableCell>
              <TableCell align="right">Requested</TableCell>
              <TableCell align="right">Approved</TableCell>
              <TableCell align="right">Dispatched</TableCell>
              <TableCell align="right">Received</TableCell>
              <TableCell align="right">Damaged</TableCell>
              {isSource && <TableCell align="right">Available here</TableCell>}
              {action && <TableCell width={130}>{action === 'APPROVE' ? 'Approve qty' : action === 'DISPATCH' ? 'Dispatch now' : 'Good received'}</TableCell>}
              {action === 'RECEIVE' && <TableCell width={110}>Damaged</TableCell>}
            </TableRow>
          </TableHead>
          <TableBody>
            {d.lines.map((l) => (
              <TableRow key={l.id}>
                <TableCell>
                  {l.productName}
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                    {l.sku}
                  </Typography>
                </TableCell>
                <TableCell align="right">{l.qtyRequested}</TableCell>
                <TableCell align="right">{l.qtyApproved}</TableCell>
                <TableCell align="right">{l.qtyDispatched}</TableCell>
                <TableCell align="right">{l.qtyReceived}</TableCell>
                <TableCell align="right">{l.qtyDamaged || ''}</TableCell>
                {isSource && <TableCell align="right">{l.available ?? ''}</TableCell>}
                {action && (
                  <TableCell>
                    <TextField value={amounts[l.id]?.a ?? ''} onChange={(e) => setAmounts({ ...amounts, [l.id]: { ...amounts[l.id], a: e.target.value } })} />
                  </TableCell>
                )}
                {action === 'RECEIVE' && (
                  <TableCell>
                    <TextField value={amounts[l.id]?.b ?? ''} onChange={(e) => setAmounts({ ...amounts, [l.id]: { ...amounts[l.id], b: e.target.value } })} />
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
      </DialogContent>
      <DialogActions>
        {action ? (
          <>
            <Button onClick={() => setAction(null)}>Back</Button>
            <Button variant="contained" onClick={submit} disabled={busy}>
              Confirm {action.toLowerCase()}
            </Button>
          </>
        ) : (
          <>
            {canCancel && <Button color="error" onClick={() => setConfirm('CANCEL')}>Cancel transfer</Button>}
            {canApprove && <Button color="error" onClick={() => setConfirm('REJECT')}>Reject</Button>}
            <Box sx={{ flex: 1 }} />
            {canApprove && <Button variant="contained" onClick={() => begin('APPROVE')}>Approve</Button>}
            {canDispatch && <Button variant="contained" onClick={() => begin('DISPATCH')}>Dispatch</Button>}
            {canReceive && <Button variant="contained" onClick={() => begin('RECEIVE')}>Receive</Button>}
            {canClose && <Button variant="outlined" onClick={() => setConfirm('CLOSE')}>Close transfer</Button>}
            <Button onClick={onClose}>Close</Button>
          </>
        )}
      </DialogActions>
      <ConfirmDialog
        open={!!confirm}
        title={confirm === 'REJECT' ? 'Reject this request?' : confirm === 'CANCEL' ? 'Cancel this transfer?' : 'Close this transfer?'}
        message={
          confirm === 'CLOSE'
            ? shortfall > 0
              ? `${shortfall} unit(s) dispatched but not received will be recorded as missing for review by the administrator.`
              : 'No further receipts will be accepted for this transfer.'
            : 'This cannot be undone.'
        }
        requireReason={confirm === 'CLOSE' ? undefined : 'Reason'}
        danger={confirm !== 'CLOSE'}
        confirmLabel={confirm === 'REJECT' ? 'Reject' : confirm === 'CANCEL' ? 'Cancel transfer' : 'Close transfer'}
        onClose={() => setConfirm(null)}
        onConfirm={async (reason) => {
          if (confirm === 'REJECT') after(await call('transfers.reject', { id, reason }), 'Request rejected');
          if (confirm === 'CANCEL') after(await call('transfers.cancel', { id, reason }), 'Transfer cancelled');
          if (confirm === 'CLOSE') after(await call('transfers.close', { id }), 'Transfer closed');
        }}
      />
    </Dialog>
  );
}

/** Central review queue: shortages, damages, conflicts, negative stock, rejected events. */
function ReconciliationTab() {
  const { info, can, notify } = useApp();
  const online = !!info?.session?.online;
  const [status, setStatus] = useState<'OPEN' | 'RESOLVED'>('OPEN');
  const items = useAsync(async () => (online ? central<any[]>('GET', `/api/reconciliation?status=${status}`) : []), [online, status]);
  const [resolving, setResolving] = useState<any | null>(null);
  const [resolution, setResolution] = useState('WRITE_OFF');
  return (
    <OnlineRequired online={online}>
      <ErrorAlert error={items.error} onRetry={items.reload} />
      <DataTable
        rows={items.data ?? []}
        loading={items.loading}
        rowKey={(r) => r.id}
        onRowClick={status === 'OPEN' && can('transfers.resolve') ? (r) => (setResolving(r), setResolution(r.type === 'TRANSFER_DISCREPANCY' ? 'WRITE_OFF' : 'ACKNOWLEDGED')) : undefined}
        toolbar={
          <TextField select value={status} onChange={(e) => setStatus(e.target.value as 'OPEN' | 'RESOLVED')} sx={{ width: 140 }}>
            <MenuItem value="OPEN">Open</MenuItem>
            <MenuItem value="RESOLVED">Resolved</MenuItem>
          </TextField>
        }
        columns={[
          { key: 'createdAt', label: 'Raised', render: (r) => dateTime(r.createdAt) },
          { key: 'type', label: 'Type', render: (r) => r.type.replace(/_/g, ' ').toLowerCase() },
          { key: 'locationName', label: 'Location' },
          { key: 'transferNo', label: 'Transfer' },
          { key: 'productName', label: 'Product' },
          { key: 'qty', label: 'Qty', align: 'right' },
          { key: 'details', label: 'Details', render: (r) => r.details?.kind ?? r.details?.message ?? r.details?.error ?? '', value: (r) => JSON.stringify(r.details) },
          { key: 'resolution', label: 'Resolution', render: (r) => (r.resolution ? `${r.resolution} — ${r.resolutionNote}` : '') },
        ]}
      />
      <ConfirmDialog
        open={!!resolving}
        title="Resolve item"
        message={
          resolving && (
            <Stack spacing={2}>
              <span>
                {resolving.type.replace(/_/g, ' ').toLowerCase()} · {resolving.productName ?? ''} {resolving.qty ? `× ${resolving.qty}` : ''} {resolving.transferNo ? `(${resolving.transferNo})` : ''}
              </span>
              {resolving.type === 'TRANSFER_DISCREPANCY' ? (
                <TextField select label="Resolution" value={resolution} onChange={(e) => setResolution(e.target.value)}>
                  <MenuItem value="WRITE_OFF">Write off (lost / damaged in transit)</MenuItem>
                  <MenuItem value="RETURN_TO_SOURCE">Returned to source location (adds stock back at source)</MenuItem>
                  <MenuItem value="FOUND_AT_DESTINATION">Found at destination (adds stock at destination)</MenuItem>
                </TextField>
              ) : (
                <span>Acknowledge after correcting the cause (e.g. a stock count adjustment at the location).</span>
              )}
            </Stack>
          )
        }
        requireReason="Resolution note"
        confirmLabel="Resolve"
        onClose={() => setResolving(null)}
        onConfirm={async (note) => {
          await central('POST', `/api/reconciliation/${resolving.id}/resolve`, { resolution, note });
          notify('Resolved');
          void items.reload();
        }}
      />
    </OnlineRequired>
  );
}
