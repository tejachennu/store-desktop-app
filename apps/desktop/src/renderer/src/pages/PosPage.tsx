import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import PaymentsIcon from '@mui/icons-material/Payments';
import { PAYMENT_METHODS, type CustomerRow, type PaymentMethod, type ProductRow } from '@store/shared';
import type { ApiResult } from '../../../core/api';
import { useApp } from '../AppState';
import { call, errorMessage } from '../lib/api';
import { useHotkey } from '../lib/hooks';
import { money, parseRupees, rupeesText } from '../lib/format';
import { ProductPicker } from '../components/ProductPicker';
import { CustomerDialog } from '../components/CustomerDialog';
import { usePrinter } from '../components/SaleDialog';
import { ConfirmDialog } from '../components/common';

interface CartLine {
  product: ProductRow & { qtyOnHand?: number | null };
  qty: number;
  discountType: 'PERCENT' | 'AMOUNT';
  /** Percent (e.g. "10") or rupees (e.g. "25.50") as typed. */
  discountText: string;
}

type Quote = ApiResult<'pos.quote'>;

function lineDiscount(l: CartLine) {
  const t = l.discountText.trim();
  if (!t) return null;
  if (l.discountType === 'PERCENT') {
    const pct = Number(t);
    return Number.isFinite(pct) && pct > 0 ? { type: 'PERCENT' as const, valueBp: Math.min(10000, Math.round(pct * 100)) } : null;
  }
  const paise = parseRupees(t);
  return paise ? { type: 'AMOUNT' as const, value: paise } : null;
}

/**
 * Fast billing screen. Keyboard: F2 search/scan · F4 customer · F8 pay · Esc clear cart.
 * Totals are computed by the main process from the local catalogue (authoritative prices + GST).
 */
export function PosPage() {
  const { info, can, notify } = useApp();
  const [params, setParams] = useSearchParams();
  const exchangeReturnId = params.get('exchange');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customer, setCustomer] = useState<CustomerRow | null>(null);
  const [customerOptions, setCustomerOptions] = useState<CustomerRow[]>([]);
  const [customerInput, setCustomerInput] = useState('');
  const [newCustomer, setNewCustomer] = useState(false);
  const [billDiscountText, setBillDiscountText] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [lastSale, setLastSale] = useState<ApiResult<'sales.get'> | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [pickerKey, setPickerKey] = useState(0);
  const scanRef = useRef<HTMLInputElement>(null);
  const customerRef = useRef<HTMLInputElement>(null);
  const print = usePrinter();
  const canDiscount = can('pos.discount');

  const saleInput = useMemo(
    () => ({
      customerId: customer?.id ?? null,
      billDiscount: parseRupees(billDiscountText) ?? 0,
      exchangeReturnId: exchangeReturnId ?? null,
      lines: cart.map((l) => ({ productId: l.product.id, qty: l.qty, discount: lineDiscount(l) })),
    }),
    [cart, customer, billDiscountText, exchangeReturnId],
  );

  useEffect(() => {
    if (cart.length === 0) {
      setQuote(null);
      setQuoteError(null);
      return;
    }
    let cancelled = false;
    call('pos.quote', { ...saleInput, payments: [] })
      .then((q) => !cancelled && (setQuote(q), setQuoteError(null)))
      .catch((err) => !cancelled && setQuoteError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [saleInput, cart.length]);

  useEffect(() => {
    const t = setTimeout(async () => setCustomerOptions(await call('customers.search', { search: customerInput })), 150);
    return () => clearTimeout(t);
  }, [customerInput]);

  const addProduct = (p: CartLine['product'], factor: number) => {
    setCart((c) => {
      const i = c.findIndex((l) => l.product.id === p.id);
      if (i >= 0) {
        const next = [...c];
        next[i] = { ...next[i], qty: next[i].qty + factor };
        return next;
      }
      return [...c, { product: p, qty: factor, discountType: 'PERCENT', discountText: '' }];
    });
    setTimeout(() => scanRef.current?.focus(), 0);
  };

  const setLine = (i: number, patch: Partial<CartLine>) => setCart((c) => c.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const removeLine = (i: number) => setCart((c) => c.filter((_, j) => j !== i));
  const reset = () => {
    setCart([]);
    setCustomer(null);
    setBillDiscountText('');
    setQuote(null);
    if (exchangeReturnId) setParams({});
    setPickerKey((k) => k + 1); // remount the scan box to clear leftover text / errors
    setTimeout(() => scanRef.current?.focus(), 0);
  };

  useHotkey('F2', () => scanRef.current?.focus());
  useHotkey('F4', () => customerRef.current?.focus());
  useHotkey('F8', () => cart.length && quote && !quoteError && setPaying(true), !paying);
  useHotkey('Escape', () => cart.length && setConfirmClear(true), !paying);

  if (info?.location?.type !== 'BRANCH') {
    return <Alert severity="info">The point of sale is available on branch computers only.</Alert>;
  }

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 380px', gap: 2, height: 'calc(100vh - 120px)' }}>
      <Paper sx={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <Box sx={{ p: 2, display: 'flex', gap: 2, alignItems: 'center' }}>
          <Box sx={{ flex: 1 }}>
            <ProductPicker key={pickerKey} inputRef={scanRef} autoFocus onPick={addProduct} />
          </Box>
          {exchangeReturnId && <Chip color="warning" label="Exchange sale (linked to return)" onDelete={() => setParams({})} />}
          <Typography variant="caption" color="text.secondary">
            F2 scan · F4 customer · F8 pay · Esc clear
          </Typography>
        </Box>
        <Divider />
        <TableContainer sx={{ flex: 1 }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell>Item</TableCell>
                <TableCell align="right">Price</TableCell>
                <TableCell align="center" width={150}>Qty</TableCell>
                {canDiscount && <TableCell align="center" width={170}>Discount</TableCell>}
                <TableCell align="right">Amount</TableCell>
                <TableCell width={40} />
              </TableRow>
            </TableHead>
            <TableBody>
              {cart.map((l, i) => {
                const q = quote?.lines[i];
                const stock = l.product.qtyOnHand;
                return (
                  <TableRow key={l.product.id}>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontWeight: 600 }}>
                        {l.product.name}
                      </Typography>
                      <Typography variant="caption" color={stock !== undefined && stock !== null && stock < l.qty ? 'error' : 'text.secondary'}>
                        {l.product.sku} · GST {l.product.gstRateBp / 100}% {stock !== undefined && stock !== null ? `· in stock ${stock}` : ''}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">{money(l.product.sellingPrice)}</TableCell>
                    <TableCell align="center">
                      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'center' }}>
                        <IconButton size="small" onClick={() => (l.qty > 1 ? setLine(i, { qty: l.qty - 1 }) : removeLine(i))}>
                          <RemoveIcon fontSize="small" />
                        </IconButton>
                        <TextField
                          value={l.qty}
                          onChange={(e) => {
                            const n = Math.floor(Number(e.target.value));
                            if (Number.isFinite(n) && n > 0) setLine(i, { qty: Math.min(n, 100000) });
                          }}
                          sx={{ width: 64 }}
                          slotProps={{ htmlInput: { style: { textAlign: 'center' } } }}
                        />
                        <IconButton size="small" onClick={() => setLine(i, { qty: l.qty + 1 })}>
                          <AddIcon fontSize="small" />
                        </IconButton>
                      </Stack>
                    </TableCell>
                    {canDiscount && (
                      <TableCell align="center">
                        <Stack direction="row" spacing={0.5}>
                          <TextField
                            select
                            value={l.discountType}
                            onChange={(e) => setLine(i, { discountType: e.target.value as 'PERCENT' | 'AMOUNT' })}
                            sx={{ width: 64 }}
                          >
                            <MenuItem value="PERCENT">%</MenuItem>
                            <MenuItem value="AMOUNT">₹</MenuItem>
                          </TextField>
                          <TextField value={l.discountText} onChange={(e) => setLine(i, { discountText: e.target.value })} sx={{ width: 90 }} placeholder="0" />
                        </Stack>
                      </TableCell>
                    )}
                    <TableCell align="right">
                      <Typography sx={{ fontWeight: 600 }}>{q ? money(q.lineTotal) : '…'}</Typography>
                      {q && q.discount > 0 && (
                        <Typography variant="caption" color="success.main">
                          −{money(q.discount)}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <IconButton size="small" onClick={() => removeLine(i)} aria-label="Remove">
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </TableCell>
                  </TableRow>
                );
              })}
              {cart.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6}>
                    <Typography color="text.secondary" sx={{ textAlign: 'center', py: 8 }}>
                      Scan a barcode or search for a product to start a bill
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      <Paper sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Stack direction="row" spacing={1}>
          <Autocomplete
            sx={{ flex: 1 }}
            options={customerOptions}
            value={customer}
            onChange={(_e, v) => setCustomer(v)}
            inputValue={customerInput}
            onInputChange={(_e, v) => setCustomerInput(v)}
            getOptionLabel={(c) => `${c.name}${c.phone ? ` · ${c.phone}` : ''}`}
            isOptionEqualToValue={(a, b) => a.id === b.id}
            filterOptions={(x) => x}
            renderInput={(p) => <TextField {...p} inputRef={customerRef} label="Customer (optional)" placeholder="Name or phone" />}
          />
          {can('customers.manage') && (
            <Tooltip title="New customer">
              <IconButton onClick={() => setNewCustomer(true)}>
                <PersonAddIcon />
              </IconButton>
            </Tooltip>
          )}
        </Stack>
        {customer?.gstin && <Chip size="small" label={`B2B · GSTIN ${customer.gstin}`} color="info" />}
        {canDiscount && (
          <TextField label="Bill discount (₹)" value={billDiscountText} onChange={(e) => setBillDiscountText(e.target.value)} placeholder="0.00" />
        )}
        <Divider />
        {quoteError && <Alert severity="error">{quoteError}</Alert>}
        <Stack spacing={0.5}>
          <Row label="Items" value={String(cart.reduce((s, l) => s + l.qty, 0))} />
          <Row label="Gross" value={money(quote?.grossTotal ?? 0)} />
          <Row label="Discount" value={`−${money(quote?.discountTotal ?? 0)}`} />
          <Row label="Taxable value" value={money(quote?.taxableTotal ?? 0)} />
          {quote?.interState ? (
            <Row label="IGST" value={money(quote.igstTotal)} />
          ) : (
            <>
              <Row label="CGST" value={money(quote?.cgstTotal ?? 0)} />
              <Row label="SGST" value={money(quote?.sgstTotal ?? 0)} />
            </>
          )}
          <Row label="Round off" value={money(quote?.roundOff ?? 0)} />
        </Stack>
        <Box sx={{ bgcolor: 'primary.main', color: '#fff', borderRadius: 2, p: 2, textAlign: 'right' }}>
          <Typography variant="body2">Amount payable</Typography>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>
            {money(quote?.grandTotal ?? 0)}
          </Typography>
        </Box>
        <Box sx={{ flex: 1 }} />
        <Button
          variant="contained"
          size="large"
          startIcon={<PaymentsIcon />}
          disabled={!cart.length || !quote || !!quoteError}
          onClick={() => setPaying(true)}
          sx={{ py: 1.5, fontSize: 18 }}
        >
          Pay (F8)
        </Button>
        <Stack direction="row" spacing={1}>
          <Button fullWidth color="inherit" disabled={!cart.length} onClick={() => setConfirmClear(true)}>
            Clear (Esc)
          </Button>
          <Button fullWidth color="inherit" disabled={!lastSale} onClick={() => lastSale && print('receipt', lastSale)}>
            Reprint last
          </Button>
        </Stack>
      </Paper>

      {paying && quote && (
        <PaymentDialog
          total={quote.grandTotal}
          onClose={() => setPaying(false)}
          onPay={async (payments) => {
            const sale = await call('pos.sell', { ...saleInput, payments });
            setPaying(false);
            setLastSale(sale);
            notify(`Sale ${sale.invoiceNo} saved${sale.change ? ` — give change ${money(sale.change)}` : ''}`);
            reset();
            void print('receipt', sale);
          }}
        />
      )}
      <CustomerDialog
        open={newCustomer}
        initial={{ name: customerInput }}
        onClose={() => setNewCustomer(false)}
        onSaved={(c) => {
          setCustomer(c);
          setNewCustomer(false);
        }}
      />
      <ConfirmDialog open={confirmClear} title="Clear the cart?" message="All items in the current bill will be removed." confirmLabel="Clear" danger onClose={() => setConfirmClear(false)} onConfirm={reset} />
    </Box>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
      <Typography color="text.secondary">{label}</Typography>
      <Typography>{value}</Typography>
    </Stack>
  );
}

interface PayRow {
  method: PaymentMethod;
  amountText: string;
  reference: string;
}

/** Split payment entry: any mix of cash / UPI / card; only cash can produce change. */
function PaymentDialog({ total, onClose, onPay }: { total: number; onClose: () => void; onPay: (p: { method: PaymentMethod; amount: number; reference: string | null }[]) => Promise<void> }) {
  const [rows, setRows] = useState<PayRow[]>([{ method: 'CASH', amountText: rupeesText(total), reference: '' }]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setTimeout(() => firstRef.current?.select(), 50);
  }, []);

  const parsed = rows.map((r) => ({ ...r, amount: parseRupees(r.amountText) ?? 0 }));
  const paid = parsed.reduce((s, r) => s + r.amount, 0);
  const nonCash = parsed.filter((r) => r.method !== 'CASH').reduce((s, r) => s + r.amount, 0);
  const balance = total - paid;
  const valid = total === 0 || (paid >= total && nonCash <= total && parsed.every((r) => r.amount > 0));

  const quick = (method: PaymentMethod) => setRows([{ method, amountText: rupeesText(total), reference: '' }]);
  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onPay(total === 0 ? [] : parsed.map((r) => ({ method: r.method, amount: r.amount, reference: r.reference.trim() || null })));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Payment — {money(total)}</DialogTitle>
      <DialogContent>
        <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
          {PAYMENT_METHODS.map((m) => (
            <Button key={m} variant="outlined" onClick={() => quick(m)}>
              Full {m}
            </Button>
          ))}
        </Stack>
        <Stack spacing={1.5}>
          {rows.map((r, i) => (
            <Stack key={i} direction="row" spacing={1}>
              <TextField select value={r.method} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, method: e.target.value as PaymentMethod } : x)))} sx={{ width: 120 }}>
                {PAYMENT_METHODS.map((m) => (
                  <MenuItem key={m} value={m}>
                    {m}
                  </MenuItem>
                ))}
              </TextField>
              <TextField
                inputRef={i === 0 ? firstRef : undefined}
                label="Amount (₹)"
                value={r.amountText}
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, amountText: e.target.value } : x)))}
                onKeyDown={(e) => e.key === 'Enter' && void submit()}
                sx={{ width: 160 }}
              />
              {r.method !== 'CASH' && (
                <TextField label="Txn / approval ref" value={r.reference} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, reference: e.target.value } : x)))} sx={{ flex: 1 }} />
              )}
              {rows.length > 1 && (
                <IconButton onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                  <DeleteIcon />
                </IconButton>
              )}
            </Stack>
          ))}
          <Button
            startIcon={<AddIcon />}
            onClick={() => setRows([...rows, { method: 'UPI', amountText: balance > 0 ? rupeesText(balance) : '', reference: '' }])}
            sx={{ alignSelf: 'flex-start' }}
          >
            Split payment
          </Button>
        </Stack>
        <Divider sx={{ my: 2 }} />
        <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
          <Typography>Paid {money(paid)}</Typography>
          {balance > 0 ? (
            <Typography color="error">Balance due {money(balance)}</Typography>
          ) : (
            <Typography variant="h6" color="success.main">
              Change {money(-balance)}
            </Typography>
          )}
        </Stack>
        {nonCash > total && <Alert severity="warning" sx={{ mt: 1 }}>Card/UPI amount cannot exceed the bill.</Alert>}
        {error && <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Back
        </Button>
        <Button variant="contained" size="large" onClick={submit} disabled={!valid || busy}>
          Complete sale (Enter)
        </Button>
      </DialogActions>
    </Dialog>
  );
}
