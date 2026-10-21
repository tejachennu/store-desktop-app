import { useMemo, useState } from 'react';
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
  IconButton,
  MenuItem,
  Stack,
  Switch,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  TextField,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import TuneIcon from '@mui/icons-material/Tune';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import { ADJUSTMENT_REASONS, type ProductRow } from '@store/shared';
import { useApp } from '../AppState';
import { call, central, errorMessage } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { dateTime, money, parseRupees, qty, rupeesText } from '../lib/format';
import { DataTable } from '../components/DataTable';
import { ErrorAlert, OnlineRequired, PageHeader } from '../components/common';
import { ProductPicker } from '../components/ProductPicker';

type StockRow = Awaited<ReturnType<typeof loadStock>>[number];
const loadStock = (lowOnly: boolean) => call('stock.list', { lowOnly });

export function StockPage() {
  const { can, info } = useApp();
  const [tab, setTab] = useState(0);
  const [lowOnly, setLowOnly] = useState(false);
  const [adjust, setAdjust] = useState<'ADJUSTMENT' | 'OPENING' | null>(null);
  const [productFilter, setProductFilter] = useState<{ id: string; name: string } | null>(null);
  const stock = useAsync(() => loadStock(lowOnly), [lowOnly]);
  const movements = useAsync(() => call('stock.movements', { productId: productFilter?.id }) as Promise<any[]>, [productFilter?.id, tab]);
  const adjustments = useAsync(() => call('stock.adjustments') as Promise<any[]>, [tab]);
  const totalValue = (stock.data ?? []).reduce((s, r) => s + r.value, 0);

  return (
    <Box>
      <PageHeader
        title="Inventory"
        subtitle={`Stock ledger for ${info?.location?.name}. Every change is recorded as a stock movement.`}
        actions={
          <>
            {can('stock.opening') && (
              <Button variant="outlined" startIcon={<AddIcon />} onClick={() => setAdjust('OPENING')}>
                Opening stock
              </Button>
            )}
            {can('stock.adjust') && (
              <Button variant="contained" startIcon={<TuneIcon />} onClick={() => setAdjust('ADJUSTMENT')}>
                Stock adjustment
              </Button>
            )}
          </>
        }
      />
      <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab label="Stock levels" />
        <Tab label="Movement history" />
        <Tab label="Adjustments" />
        <Tab label="All locations" />
      </Tabs>

      {tab === 0 && (
        <>
          <ErrorAlert error={stock.error} onRetry={stock.reload} />
          <DataTable<StockRow>
            rows={stock.data ?? []}
            loading={stock.loading}
            rowKey={(r) => r.productId}
            onRowClick={(r) => {
              setProductFilter({ id: r.productId, name: r.name });
              setTab(1);
            }}
            searchPlaceholder="Product, SKU, category…"
            toolbar={
              <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
                <FormControlLabel control={<Switch checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} />} label="Low stock only" />
                <Box sx={{ fontWeight: 600 }}>Value at cost {money(totalValue)}</Box>
              </Stack>
            }
            columns={[
              { key: 'sku', label: 'SKU' },
              { key: 'name', label: 'Product' },
              { key: 'categoryName', label: 'Category' },
              { key: 'qtyOnHand', label: 'On hand', align: 'right', render: (r) => qty(r.qtyOnHand) },
              { key: 'reserved', label: 'Reserved', align: 'right', render: (r) => (r.reserved ? qty(r.reserved) : '') },
              { key: 'available', label: 'Available', align: 'right', render: (r) => <b>{qty(r.available)}</b> },
              { key: 'reorderLevel', label: 'Reorder at', align: 'right' },
              { key: 'avgCost', label: 'Avg cost', align: 'right', render: (r) => money(r.avgCost) },
              { key: 'value', label: 'Value', align: 'right', render: (r) => money(r.value) },
              { key: 'low', label: '', render: (r) => (r.qtyOnHand < 0 ? <Chip size="small" color="error" label="Negative" /> : r.low ? <Chip size="small" color="warning" label="Low" /> : null), value: (r) => (r.low ? 1 : 0) },
            ]}
          />
        </>
      )}

      {tab === 1 && (
        <DataTable
          rows={movements.data ?? []}
          loading={movements.loading}
          rowKey={(r) => r.id}
          toolbar={productFilter && <Chip label={`Product: ${productFilter.name}`} onDelete={() => setProductFilter(null)} />}
          columns={[
            { key: 'occurredAt', label: 'Date', render: (r) => dateTime(r.occurredAt) },
            { key: 'productName', label: 'Product' },
            { key: 'movementType', label: 'Type', render: (r) => r.movementType.replace(/_/g, ' ').toLowerCase() },
            { key: 'docNo', label: 'Document' },
            { key: 'reason', label: 'Reason' },
            { key: 'qtyDelta', label: 'Qty', align: 'right', render: (r) => <Box sx={{ color: r.qtyDelta < 0 ? 'error.main' : 'success.main', fontWeight: 600 }}>{r.qtyDelta > 0 ? `+${r.qtyDelta}` : r.qtyDelta}</Box> },
            { key: 'unitCost', label: 'Unit cost', align: 'right', render: (r) => money(r.unitCost) },
            { key: 'userName', label: 'User', render: (r) => r.userName ?? (r.origin === 'REMOTE' ? 'Other terminal / admin' : '') },
          ]}
        />
      )}

      {tab === 2 && (
        <DataTable
          rows={adjustments.data ?? []}
          loading={adjustments.loading}
          rowKey={(r) => r.id}
          columns={[
            { key: 'adjustmentNo', label: 'No.' },
            { key: 'occurredAt', label: 'Date', render: (r) => dateTime(r.occurredAt) },
            { key: 'kind', label: 'Kind' },
            { key: 'reason', label: 'Reason' },
            { key: 'notes', label: 'Notes' },
            { key: 'lineCount', label: 'Lines', align: 'right' },
            { key: 'valueDelta', label: 'Value change', align: 'right', render: (r) => money(r.valueDelta) },
            { key: 'userName', label: 'By' },
          ]}
        />
      )}

      {tab === 3 && <AllLocationsStock />}

      {adjust && (
        <AdjustmentDialog
          kind={adjust}
          onClose={() => setAdjust(null)}
          onDone={() => {
            setAdjust(null);
            void stock.reload();
          }}
        />
      )}
    </Box>
  );
}

/** Read-only, server-side view of stock across every warehouse and branch (online). */
function AllLocationsStock() {
  const { info } = useApp();
  const online = !!info?.session?.online;
  const data = useAsync(async () => (online ? central<any[]>('GET', '/api/stock?limit=2000') : []), [online]);
  const { locations, rows } = useMemo(() => {
    const locs = new Map<string, string>();
    type PivotRow = { productId: string; sku: string; name: string; total: number; [locationId: string]: string | number };
    const prods = new Map<string, PivotRow>();
    for (const r of data.data ?? []) {
      locs.set(r.locationId, r.locationName);
      const p: PivotRow = prods.get(r.productId) ?? { productId: r.productId, sku: r.sku, name: r.name, total: 0 };
      p[r.locationId] = r.available;
      p.total += Number(r.qtyOnHand);
      prods.set(r.productId, p);
    }
    return { locations: [...locs.entries()], rows: [...prods.values()] };
  }, [data.data]);
  return (
    <OnlineRequired online={online}>
      <ErrorAlert error={data.error} onRetry={data.reload} />
      <Alert severity="info" sx={{ mb: 2 }}>
        Available quantity (on hand minus reserved) per location as known to the central server. Locations that are offline may have newer figures.
      </Alert>
      <DataTable
        rows={rows}
        loading={data.loading}
        rowKey={(r) => r.productId}
        columns={[
          { key: 'sku', label: 'SKU' },
          { key: 'name', label: 'Product' },
          ...locations.map(([id, name]) => ({ key: id, label: name, align: 'right' as const, value: (r: any) => Number(r[id] ?? 0), render: (r: any) => (r[id] === undefined ? '—' : qty(r[id])) })),
          { key: 'total', label: 'Total on hand', align: 'right', render: (r) => <b>{qty(r.total)}</b> },
        ]}
      />
    </OnlineRequired>
  );
}

interface AdjLine {
  product: ProductRow;
  direction: 1 | -1;
  qtyText: string;
  costText: string;
}

function AdjustmentDialog({ kind, onClose, onDone }: { kind: 'ADJUSTMENT' | 'OPENING'; onClose: () => void; onDone: () => void }) {
  const { notify } = useApp();
  const [reason, setReason] = useState<string>(kind === 'OPENING' ? 'OPENING' : 'DAMAGE');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<AdjLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const opening = kind === 'OPENING';

  const add = (p: ProductRow) =>
    setLines((ls) => (ls.some((l) => l.product.id === p.id) ? ls : [...ls, { product: p, direction: reason === 'FOUND' || opening ? 1 : -1, qtyText: '1', costText: rupeesText(p.purchasePrice) }]));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = lines.map((l) => {
        const q = Math.floor(Number(l.qtyText));
        if (!Number.isFinite(q) || q <= 0) throw new Error(`Enter a quantity for ${l.product.name}`);
        const cost = parseRupees(l.costText);
        return { productId: l.product.id, qtyDelta: q * l.direction, unitCost: l.direction > 0 && cost !== null ? cost : undefined };
      });
      const r = await call('stock.adjust', { kind, reason: reason as any, notes: notes || null, lines: payload });
      notify(`${opening ? 'Opening stock' : 'Adjustment'} ${r.adjustmentNo} saved`);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>{opening ? 'Enter opening stock' : 'Stock adjustment'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {!opening && (
            <Stack direction="row" spacing={2}>
              <TextField select label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} sx={{ width: 220 }}>
                {ADJUSTMENT_REASONS.map((r) => (
                  <MenuItem key={r} value={r}>
                    {r.replace(/_/g, ' ').toLowerCase()}
                  </MenuItem>
                ))}
              </TextField>
              <TextField label="Notes (required)" value={notes} onChange={(e) => setNotes(e.target.value)} fullWidth />
            </Stack>
          )}
          <ProductPicker onPick={(p) => add(p)} autoFocus />
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Product</TableCell>
                {!opening && <TableCell>Direction</TableCell>}
                <TableCell width={120}>Quantity</TableCell>
                <TableCell width={140}>Unit cost (₹)</TableCell>
                <TableCell width={40} />
              </TableRow>
            </TableHead>
            <TableBody>
              {lines.map((l, i) => (
                <TableRow key={l.product.id}>
                  <TableCell>{l.product.name}</TableCell>
                  {!opening && (
                    <TableCell>
                      <TextField select value={l.direction} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, direction: Number(e.target.value) as 1 | -1 } : x)))}>
                        <MenuItem value={-1}>Remove from stock</MenuItem>
                        <MenuItem value={1}>Add to stock</MenuItem>
                      </TextField>
                    </TableCell>
                  )}
                  <TableCell>
                    <TextField value={l.qtyText} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qtyText: e.target.value } : x)))} />
                  </TableCell>
                  <TableCell>
                    <TextField disabled={l.direction < 0} value={l.costText} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, costText: e.target.value } : x)))} />
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
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={submit} disabled={busy || lines.length === 0 || (!opening && notes.trim().length < 2)}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
