import { useEffect, useState } from 'react';
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
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import { GST_RATES_BP, mulDivRound, uuidv7, type ProductRow, type SupplierRow } from '@store/shared';
import { useApp } from '../AppState';
import { call, central, errorMessage } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { date, dateTime, money, parseRupees, rate, rupeesText, todayIso } from '../lib/format';
import { DataTable } from '../components/DataTable';
import { ErrorAlert, PageHeader } from '../components/common';
import { ProductPicker } from '../components/ProductPicker';

interface Line {
  product: ProductRow;
  qtyText: string;
  costText: string;
  gstRateBp: number;
  poLineId?: string | null;
  maxQty?: number;
}

const lineTotals = (lines: Line[]) =>
  lines.reduce(
    (t, l) => {
      const q = Math.max(0, Math.floor(Number(l.qtyText) || 0));
      const taxable = q * (parseRupees(l.costText) ?? 0);
      const tax = mulDivRound(taxable, l.gstRateBp, 10000);
      return { taxable: t.taxable + taxable, tax: t.tax + tax };
    },
    { taxable: 0, tax: 0 },
  );

function LinesEditor({ lines, setLines, showMax }: { lines: Line[]; setLines: (l: Line[]) => void; showMax?: boolean }) {
  const set = (i: number, patch: Partial<Line>) => setLines(lines.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const t = lineTotals(lines);
  return (
    <>
      <ProductPicker
        onPick={(p) => !lines.some((l) => l.product.id === p.id) && setLines([...lines, { product: p, qtyText: '1', costText: rupeesText(p.purchasePrice), gstRateBp: p.gstRateBp }])}
        showStock={false}
      />
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Product</TableCell>
            <TableCell width={110}>Qty</TableCell>
            <TableCell width={130}>Unit cost (₹, excl. GST)</TableCell>
            <TableCell width={110}>GST</TableCell>
            <TableCell align="right">Amount</TableCell>
            <TableCell width={40} />
          </TableRow>
        </TableHead>
        <TableBody>
          {lines.map((l, i) => {
            const q = Math.floor(Number(l.qtyText) || 0);
            const taxable = q * (parseRupees(l.costText) ?? 0);
            return (
              <TableRow key={l.product.id}>
                <TableCell>
                  {l.product.name}
                  {showMax && l.maxQty !== undefined && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                      Outstanding on order: {l.maxQty}
                    </Typography>
                  )}
                </TableCell>
                <TableCell>
                  <TextField value={l.qtyText} onChange={(e) => set(i, { qtyText: e.target.value })} />
                </TableCell>
                <TableCell>
                  <TextField value={l.costText} onChange={(e) => set(i, { costText: e.target.value })} />
                </TableCell>
                <TableCell>
                  <TextField select value={l.gstRateBp} onChange={(e) => set(i, { gstRateBp: Number(e.target.value) })}>
                    {GST_RATES_BP.map((r) => (
                      <MenuItem key={r} value={r}>
                        {rate(r)}
                      </MenuItem>
                    ))}
                  </TextField>
                </TableCell>
                <TableCell align="right">{money(taxable + mulDivRound(taxable, l.gstRateBp, 10000))}</TableCell>
                <TableCell>
                  <IconButton size="small" onClick={() => setLines(lines.filter((_, j) => j !== i))}>
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <Stack direction="row" spacing={3} sx={{ justifyContent: 'flex-end' }}>
        <Typography>Taxable {money(t.taxable)}</Typography>
        <Typography>GST {money(t.tax)}</Typography>
        <Typography variant="h6">Total {money(t.taxable + t.tax)}</Typography>
      </Stack>
    </>
  );
}

const toPayload = (lines: Line[]) =>
  lines.map((l) => {
    const qty = Math.floor(Number(l.qtyText));
    const unitCost = parseRupees(l.costText);
    if (!Number.isFinite(qty) || qty <= 0) throw new Error(`Enter a quantity for ${l.product.name}`);
    if (unitCost === null) throw new Error(`Enter a valid cost for ${l.product.name}`);
    return { productId: l.product.id, qty, unitCost, gstRateBp: l.gstRateBp, purchaseOrderLineId: l.poLineId ?? null };
  });

function SupplierSelect({ value, onChange, disabled }: { value: string; onChange: (id: string) => void; disabled?: boolean }) {
  const suppliers = useAsync(() => call('catalog.suppliers', {}), []);
  return (
    <TextField select label="Supplier" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} sx={{ minWidth: 260 }}>
      {(suppliers.data ?? []).filter((s: SupplierRow) => s.isActive || s.id === value).map((s: SupplierRow) => (
        <MenuItem key={s.id} value={s.id}>
          {s.name}
        </MenuItem>
      ))}
    </TextField>
  );
}

export function PurchasesPage() {
  const { can, info } = useApp();
  const [tab, setTab] = useState(0);
  const [newPo, setNewPo] = useState(false);
  const [grnFrom, setGrnFrom] = useState<{ poId?: string } | null>(null);
  const [newReturn, setNewReturn] = useState(false);
  const [newPayment, setNewPayment] = useState(false);
  const [openPo, setOpenPo] = useState<string | null>(null);
  const [openGrn, setOpenGrn] = useState<string | null>(null);
  const orders = useAsync(() => call('purchases.orders', {}) as Promise<any[]>, [tab]);
  const grns = useAsync(() => call('purchases.grns') as Promise<any[]>, [tab]);
  const returns = useAsync(() => call('purchases.returns') as Promise<any[]>, [tab]);
  const payments = useAsync(async () => (can('supplier_payments.manage') ? ((await call('purchases.payments')) as any[]) : []), [tab]);
  const canReceiveHere = !!info?.location?.canReceivePurchases;

  return (
    <Box>
      <PageHeader
        title="Purchases"
        subtitle={canReceiveHere ? 'Purchase orders, goods received notes (GRN), purchase returns and supplier payments' : 'This location is not authorised to receive supplier deliveries.'}
        actions={
          <>
            {can('purchase.order') && (
              <Button variant="outlined" startIcon={<AddIcon />} onClick={() => setNewPo(true)}>
                Purchase order
              </Button>
            )}
            {can('purchase.receive') && canReceiveHere && (
              <Button variant="contained" startIcon={<AddIcon />} onClick={() => setGrnFrom({})}>
                Receive goods (GRN)
              </Button>
            )}
            {can('purchase.return') && (
              <Button variant="outlined" onClick={() => setNewReturn(true)}>
                Purchase return
              </Button>
            )}
            {can('supplier_payments.manage') && (
              <Button variant="outlined" onClick={() => setNewPayment(true)}>
                Record payment
              </Button>
            )}
          </>
        }
      />
      <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab label="Purchase orders" />
        <Tab label="Goods received" />
        <Tab label="Purchase returns" />
        {can('supplier_payments.manage') && <Tab label="Supplier payments" />}
      </Tabs>
      {tab === 0 && (
        <>
          <ErrorAlert error={orders.error} />
          <DataTable
            rows={orders.data ?? []}
            loading={orders.loading}
            rowKey={(r) => r.id}
            onRowClick={(r) => setOpenPo(r.id)}
            columns={[
              { key: 'poNo', label: 'PO no.' },
              { key: 'createdAt', label: 'Date', render: (r) => date(r.createdAt) },
              { key: 'supplierName', label: 'Supplier' },
              { key: 'expectedDate', label: 'Expected', render: (r) => date(r.expectedDate) },
              { key: 'qtyOrdered', label: 'Ordered', align: 'right' },
              { key: 'qtyReceived', label: 'Received', align: 'right' },
              { key: 'taxableTotal', label: 'Value (excl. GST)', align: 'right', render: (r) => money(r.taxableTotal) },
              { key: 'status', label: 'Status', render: (r) => <Chip size="small" label={r.status.replace(/_/g, ' ').toLowerCase()} color={r.status === 'RECEIVED' ? 'success' : r.status === 'CANCELLED' ? 'default' : 'primary'} /> },
            ]}
            empty="No purchase orders for this location"
          />
        </>
      )}
      {tab === 1 && (
        <DataTable
          rows={grns.data ?? []}
          loading={grns.loading}
          rowKey={(r) => r.id}
          onRowClick={(r) => setOpenGrn(r.id)}
          columns={[
            { key: 'grnNo', label: 'GRN no.' },
            { key: 'occurredAt', label: 'Received', render: (r) => dateTime(r.occurredAt) },
            { key: 'supplierName', label: 'Supplier' },
            { key: 'supplierInvoiceNo', label: 'Supplier invoice' },
            { key: 'poNo', label: 'Against PO' },
            { key: 'taxTotal', label: 'GST', align: 'right', render: (r) => money(r.taxTotal) },
            { key: 'grandTotal', label: 'Total', align: 'right', render: (r) => money(r.grandTotal) },
          ]}
        />
      )}
      {tab === 2 && (
        <DataTable
          rows={returns.data ?? []}
          loading={returns.loading}
          rowKey={(r) => r.id}
          columns={[
            { key: 'returnNo', label: 'Return no.' },
            { key: 'occurredAt', label: 'Date', render: (r) => dateTime(r.occurredAt) },
            { key: 'supplierName', label: 'Supplier' },
            { key: 'grnNo', label: 'Against GRN' },
            { key: 'reason', label: 'Reason' },
            { key: 'grandTotal', label: 'Value', align: 'right', render: (r) => money(r.grandTotal) },
          ]}
        />
      )}
      {tab === 3 && (
        <DataTable
          rows={payments.data ?? []}
          loading={payments.loading}
          rowKey={(r) => r.id}
          columns={[
            { key: 'paidOn', label: 'Paid on', render: (r) => date(r.paidOn) },
            { key: 'supplierName', label: 'Supplier' },
            { key: 'method', label: 'Method' },
            { key: 'reference', label: 'Reference' },
            { key: 'grnNo', label: 'Against GRN' },
            { key: 'amount', label: 'Amount', align: 'right', render: (r) => money(r.amount) },
            { key: 'userName', label: 'By' },
          ]}
        />
      )}
      {newPo && <PurchaseOrderDialog onClose={() => setNewPo(false)} onDone={() => (setNewPo(false), void orders.reload())} />}
      {grnFrom && <GrnDialog poId={grnFrom.poId} onClose={() => setGrnFrom(null)} onDone={() => (setGrnFrom(null), setTab(1), void grns.reload(), void orders.reload())} />}
      {newReturn && <PurchaseReturnDialog onClose={() => setNewReturn(false)} onDone={() => (setNewReturn(false), setTab(2), void returns.reload())} />}
      {newPayment && <PaymentDialog onClose={() => setNewPayment(false)} onDone={() => (setNewPayment(false), setTab(3), void payments.reload())} />}
      {openPo && (
        <PoDetail
          id={openPo}
          onClose={() => setOpenPo(null)}
          onReceive={canReceiveHere && can('purchase.receive') ? () => (setGrnFrom({ poId: openPo }), setOpenPo(null)) : undefined}
          onChanged={() => void orders.reload()}
        />
      )}
      {openGrn && <GrnDetail id={openGrn} onClose={() => setOpenGrn(null)} />}
    </Box>
  );
}

function PoDetail({ id, onClose, onReceive, onChanged }: { id: string; onClose: () => void; onReceive?: () => void; onChanged: () => void }) {
  const { can, info, notify } = useApp();
  const po = useAsync(() => call('purchases.order', { id }), [id]);
  const p = po.data as any;
  const setStatus = async (status: 'ORDERED' | 'CANCELLED') => {
    try {
      await central('POST', `/api/purchase-orders/${id}/status`, { status });
      notify(status === 'CANCELLED' ? 'Order cancelled' : 'Order placed');
      onChanged();
      onClose();
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
  };
  if (!p) return null;
  const online = !!info?.session?.online;
  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>
        {p.poNo} — {p.supplierName} <Chip size="small" label={p.status} />
      </DialogTitle>
      <DialogContent>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Product</TableCell>
              <TableCell align="right">Ordered</TableCell>
              <TableCell align="right">Received</TableCell>
              <TableCell align="right">Unit cost</TableCell>
              <TableCell align="right">GST</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {p.lines.map((l: any) => (
              <TableRow key={l.id}>
                <TableCell>{l.productName}</TableCell>
                <TableCell align="right">{l.qty}</TableCell>
                <TableCell align="right">{l.qtyReceived}</TableCell>
                <TableCell align="right">{money(l.unitCost)}</TableCell>
                <TableCell align="right">{rate(l.gstRateBp)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {p.notes && <Typography sx={{ mt: 1 }}>{p.notes}</Typography>}
      </DialogContent>
      <DialogActions>
        {can('purchase.order') && online && ['DRAFT', 'ORDERED'].includes(p.status) && !p.lines.some((l: any) => l.qtyReceived > 0) && (
          <Button color="error" onClick={() => setStatus('CANCELLED')}>
            Cancel order
          </Button>
        )}
        {can('purchase.order') && online && p.status === 'DRAFT' && <Button onClick={() => setStatus('ORDERED')}>Place order</Button>}
        <Box sx={{ flex: 1 }} />
        {onReceive && ['ORDERED', 'PARTIALLY_RECEIVED'].includes(p.status) && (
          <Button variant="contained" onClick={onReceive}>
            Receive against this order
          </Button>
        )}
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

function GrnDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const g = useAsync(() => call('purchases.grn', { id }), [id]).data as any;
  if (!g) return null;
  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>
        {g.grnNo} — {g.supplierName}
      </DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 1 }}>
          Received {dateTime(g.occurredAt)} · supplier invoice {g.supplierInvoiceNo ?? '—'} {g.supplierInvoiceDate ? `dated ${date(g.supplierInvoiceDate)}` : ''} {g.poNo ? `· PO ${g.poNo}` : ''}
        </Typography>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Product</TableCell>
              <TableCell align="right">Qty</TableCell>
              <TableCell align="right">Unit cost</TableCell>
              <TableCell align="right">GST</TableCell>
              <TableCell align="right">Total</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {g.lines.map((l: any) => (
              <TableRow key={l.id}>
                <TableCell>{l.productName}</TableCell>
                <TableCell align="right">{l.qty}</TableCell>
                <TableCell align="right">{money(l.unitCost)}</TableCell>
                <TableCell align="right">{money(l.taxTotal)}</TableCell>
                <TableCell align="right">{money(l.total)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <Typography variant="h6" sx={{ textAlign: 'right', mt: 1 }}>
          {money(g.grandTotal)}
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

function GrnDialog({ poId, onClose, onDone }: { poId?: string; onClose: () => void; onDone: () => void }) {
  const { notify } = useApp();
  const [supplierId, setSupplierId] = useState('');
  const [orderId, setOrderId] = useState(poId ?? '');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(todayIso());
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const openOrders = useAsync(() => call('purchases.orders', {}) as Promise<any[]>, []);

  useEffect(() => {
    if (!orderId) return;
    void (async () => {
      const po = (await call('purchases.order', { id: orderId })) as any;
      setSupplierId(po.supplierId);
      const products = await Promise.all(po.lines.map((l: any) => call('catalog.getProduct', { id: l.productId })));
      setLines(
        po.lines
          .map((l: any, i: number) => ({
            product: products[i],
            qtyText: String(Math.max(0, l.qty - l.qtyReceived)),
            costText: rupeesText(l.unitCost),
            gstRateBp: l.gstRateBp,
            poLineId: l.id,
            maxQty: Math.max(0, l.qty - l.qtyReceived),
          }))
          .filter((l: Line) => (l.maxQty ?? 0) > 0),
      );
    })();
  }, [orderId]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await call('purchases.createGrn', {
        purchaseOrderId: orderId || null,
        supplierId,
        supplierInvoiceNo: invoiceNo || null,
        supplierInvoiceDate: invoiceDate || null,
        notes: notes || null,
        lines: toPayload(lines),
      });
      notify(`GRN ${r.grnNo} saved — stock updated`);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle>Goods received note</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Stack direction="row" spacing={2}>
            <TextField select label="Against purchase order (optional)" value={orderId} onChange={(e) => setOrderId(e.target.value)} sx={{ minWidth: 260 }}>
              <MenuItem value="">No purchase order</MenuItem>
              {(openOrders.data ?? [])
                .filter((o) => ['ORDERED', 'PARTIALLY_RECEIVED'].includes(o.status))
                .map((o) => (
                  <MenuItem key={o.id} value={o.id}>
                    {o.poNo} — {o.supplierName}
                  </MenuItem>
                ))}
            </TextField>
            <SupplierSelect value={supplierId} onChange={setSupplierId} disabled={!!orderId} />
            <TextField label="Supplier invoice no." value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} />
            <TextField type="date" label="Invoice date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
          </Stack>
          <LinesEditor lines={lines} setLines={setLines} showMax />
          <TextField label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={submit} disabled={busy || !supplierId || lines.length === 0}>
          Save GRN &amp; add stock
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function PurchaseOrderDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { info, notify } = useApp();
  const locations = useAsync(() => call('catalog.locations'), []);
  const [supplierId, setSupplierId] = useState('');
  const [locationId, setLocationId] = useState(info?.location?.canReceivePurchases ? info.location.id : '');
  const [expected, setExpected] = useState(todayIso(7));
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (status: 'DRAFT' | 'ORDERED') => {
    setBusy(true);
    setError(null);
    try {
      const po = await central('POST', '/api/purchase-orders', {
        id: uuidv7(),
        supplierId,
        locationId,
        expectedDate: expected || null,
        notes: notes || null,
        status,
        lines: toPayload(lines).map(({ productId, qty, unitCost, gstRateBp }) => ({ id: uuidv7(), productId, qty, unitCost, gstRateBp })),
      });
      notify(`Purchase order ${po.poNo} created`);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle>New purchase order</DialogTitle>
      <DialogContent>
        {!info?.session?.online && <Alert severity="warning">Purchase orders are created on the central server — sign in online to save.</Alert>}
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Stack direction="row" spacing={2}>
            <SupplierSelect value={supplierId} onChange={setSupplierId} />
            <TextField select label="Deliver to" value={locationId} onChange={(e) => setLocationId(e.target.value)} sx={{ minWidth: 240 }}>
              {(locations.data ?? []).filter((l) => l.canReceivePurchases && l.isActive).map((l) => (
                <MenuItem key={l.id} value={l.id}>
                  {l.name}
                </MenuItem>
              ))}
            </TextField>
            <TextField type="date" label="Expected by" value={expected} onChange={(e) => setExpected(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
          </Stack>
          <LinesEditor lines={lines} setLines={setLines} />
          <TextField label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button onClick={() => submit('DRAFT')} disabled={busy || !supplierId || !locationId || !lines.length}>
          Save draft
        </Button>
        <Button variant="contained" onClick={() => submit('ORDERED')} disabled={busy || !supplierId || !locationId || !lines.length}>
          Place order
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function PurchaseReturnDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { notify } = useApp();
  const [supplierId, setSupplierId] = useState('');
  const [grnId, setGrnId] = useState('');
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const grns = useAsync(() => call('purchases.grns') as Promise<any[]>, []);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await call('purchases.createReturn', {
        supplierId,
        grnId: grnId || null,
        reason,
        lines: toPayload(lines).map(({ productId, qty, unitCost, gstRateBp }) => ({ productId, qty, unitCost, gstRateBp })),
      });
      notify(`Purchase return ${r.returnNo} saved`);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle>Return goods to supplier</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Stack direction="row" spacing={2}>
            <SupplierSelect value={supplierId} onChange={setSupplierId} />
            <TextField select label="Against GRN (optional)" value={grnId} onChange={(e) => setGrnId(e.target.value)} sx={{ minWidth: 240 }}>
              <MenuItem value="">—</MenuItem>
              {(grns.data ?? []).map((g) => (
                <MenuItem key={g.id} value={g.id}>
                  {g.grnNo} — {g.supplierName}
                </MenuItem>
              ))}
            </TextField>
            <TextField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} fullWidth />
          </Stack>
          <LinesEditor lines={lines} setLines={setLines} />
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" color="warning" onClick={submit} disabled={busy || !supplierId || !lines.length || reason.trim().length < 2}>
          Save return &amp; remove stock
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function PaymentDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { notify } = useApp();
  const [supplierId, setSupplierId] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<'CASH' | 'UPI' | 'CARD' | 'BANK_TRANSFER' | 'CHEQUE'>('BANK_TRANSFER');
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState(todayIso());
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setError(null);
    try {
      const paise = parseRupees(amount);
      if (!paise) throw new Error('Enter a valid amount');
      await call('purchases.pay', { supplierId, amount: paise, method, reference: reference || null, paidOn });
      notify('Payment recorded');
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Record supplier payment</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <SupplierSelect value={supplierId} onChange={setSupplierId} />
          <Stack direction="row" spacing={2}>
            <TextField label="Amount (₹)" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <TextField select label="Method" value={method} onChange={(e) => setMethod(e.target.value as typeof method)} sx={{ width: 200 }}>
              {['BANK_TRANSFER', 'CHEQUE', 'UPI', 'CASH', 'CARD'].map((m) => (
                <MenuItem key={m} value={m}>
                  {m.replace('_', ' ')}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
          <Stack direction="row" spacing={2}>
            <TextField label="Reference (UTR / cheque no.)" value={reference} onChange={(e) => setReference(e.target.value)} fullWidth />
            <TextField type="date" label="Paid on" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
          </Stack>
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={submit} disabled={!supplierId || !amount}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
