import { useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { computeLineRefund, PAYMENT_METHODS } from '@store/shared';
import { useNavigate } from 'react-router-dom';
import type { ApiResult } from '../../../core/api';
import { call, errorMessage } from '../lib/api';
import { money } from '../lib/format';
import { creditNoteHtml } from '../lib/receipt';
import { useApp } from '../AppState';

type Sale = ApiResult<'sales.get'>;

/**
 * Sales return with pro-rata GST refund. "Exchange" = return + a new sale that the
 * POS opens pre-linked to this return.
 */
export function ReturnDialog({ sale, onClose, onDone }: { sale: Sale; onClose: () => void; onDone: () => void }) {
  const { info, notify } = useApp();
  const nav = useNavigate();
  const [qty, setQty] = useState<Record<string, number>>({});
  const [restock, setRestock] = useState<Record<string, boolean>>({});
  const [reason, setReason] = useState('');
  const [method, setMethod] = useState<(typeof PAYMENT_METHODS)[number]>('CASH');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refund = sale.lines.reduce((s, l) => {
    const q = qty[l.id] ?? 0;
    if (!q) return s;
    try {
      return s + computeLineRefund({ qtySold: l.qty, qtyAlreadyReturned: l.qtyReturned, ...l }, q).total;
    } catch {
      return s;
    }
  }, 0);

  const submit = async (exchange: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const lines = sale.lines.filter((l) => (qty[l.id] ?? 0) > 0).map((l) => ({ saleLineId: l.id, qty: qty[l.id], restock: restock[l.id] ?? true }));
      const r = await call('sales.return', { saleId: sale.id, reason, refundMethod: method, lines });
      notify(`Return ${r.returnNo} recorded — refund ${money(r.refundTotal)}`);
      if (info?.location) {
        const detail = await call('sales.getReturn', { id: r.id });
        const prefs = await call('prefs.get');
        await call('print.html', { html: creditNoteHtml(detail, { settings: info.settings, location: info.location }, prefs.receiptWidthMm), widthMm: prefs.receiptWidthMm });
      }
      onDone();
      if (exchange) nav(`/pos?exchange=${r.id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Return items — {sale.invoiceNo}</DialogTitle>
      <DialogContent>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Item</TableCell>
              <TableCell align="right">Sold</TableCell>
              <TableCell align="right">Already returned</TableCell>
              <TableCell align="right" width={120}>Return qty</TableCell>
              <TableCell align="center">Back to stock</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {sale.lines.map((l) => {
              const max = l.qty - l.qtyReturned;
              return (
                <TableRow key={l.id}>
                  <TableCell>{l.name}</TableCell>
                  <TableCell align="right">{l.qty}</TableCell>
                  <TableCell align="right">{l.qtyReturned}</TableCell>
                  <TableCell align="right">
                    <TextField
                      type="number"
                      disabled={max === 0}
                      value={qty[l.id] ?? 0}
                      onChange={(e) => setQty({ ...qty, [l.id]: Math.max(0, Math.min(max, Math.floor(Number(e.target.value) || 0))) })}
                      slotProps={{ htmlInput: { min: 0, max } }}
                    />
                  </TableCell>
                  <TableCell align="center">
                    <Checkbox checked={restock[l.id] ?? true} onChange={(e) => setRestock({ ...restock, [l.id]: e.target.checked })} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        <Typography variant="caption" color="text.secondary">
          Untick "Back to stock" for damaged or unsellable items — they are refunded but not added to inventory.
        </Typography>
        <Stack direction="row" spacing={2} sx={{ mt: 2 }}>
          <TextField label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} fullWidth required />
          <TextField select label="Refund via" value={method} onChange={(e) => setMethod(e.target.value as typeof method)} sx={{ width: 160 }}>
            {PAYMENT_METHODS.map((m) => (
              <MenuItem key={m} value={m}>
                {m}
              </MenuItem>
            ))}
          </TextField>
        </Stack>
        <Typography variant="h6" sx={{ mt: 2, textAlign: 'right' }}>
          Refund: {money(refund)}
        </Typography>
        {error && <Alert severity="error">{error}</Alert>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button onClick={() => submit(true)} disabled={busy || refund === 0 || reason.trim().length < 2}>
          Return &amp; start exchange sale
        </Button>
        <Button variant="contained" color="warning" onClick={() => submit(false)} disabled={busy || refund === 0 || reason.trim().length < 2}>
          Confirm return
        </Button>
      </DialogActions>
    </Dialog>
  );
}
