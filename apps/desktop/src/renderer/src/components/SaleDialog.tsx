import { useState } from 'react';
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import PrintIcon from '@mui/icons-material/Print';
import UndoIcon from '@mui/icons-material/Undo';
import type { ApiResult } from '../../../core/api';
import { useApp } from '../AppState';
import { call, errorMessage } from '../lib/api';
import { dateTime, money, rate } from '../lib/format';
import { invoiceHtml, receiptHtml } from '../lib/receipt';
import { SyncChip } from './common';
import { ReturnDialog } from './ReturnDialog';

type Sale = ApiResult<'sales.get'>;

export function usePrinter() {
  const { info, notify } = useApp();
  return async (kind: 'receipt' | 'invoice', sale: Sale) => {
    if (!info?.location) return;
    try {
      const prefs = await call('prefs.get');
      const ctx = { settings: info.settings, location: info.location };
      const html = kind === 'receipt' ? receiptHtml(sale, ctx, prefs.receiptWidthMm) : invoiceHtml(sale, ctx);
      const r = await call('print.html', { html, widthMm: kind === 'receipt' ? prefs.receiptWidthMm : undefined, silent: kind === 'receipt' ? undefined : false });
      if (!r.ok && r.error && r.error !== 'cancelled') notify(`Printing failed: ${r.error}`, 'error');
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
  };
}

/** Invoice detail with reprint and return actions. */
export function SaleDialog({ sale, onClose, onChanged }: { sale: Sale | null; onClose: () => void; onChanged?: () => void }) {
  const { can } = useApp();
  const print = usePrinter();
  const [returning, setReturning] = useState(false);
  if (!sale) return null;
  const returnable = sale.lines.some((l) => l.qtyReturned < l.qty);
  return (
    <>
      <Dialog open onClose={onClose} maxWidth="md" fullWidth>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          Invoice {sale.invoiceNo}
          <SyncChip status={sale.syncStatus} />
          {sale.interState && <Chip size="small" label="IGST (inter-state)" />}
        </DialogTitle>
        <DialogContent>
          <Stack direction="row" spacing={4} sx={{ mb: 2 }}>
            <Box>
              <Typography variant="caption" color="text.secondary">Date</Typography>
              <Typography>{dateTime(sale.occurredAt)}</Typography>
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary">Customer</Typography>
              <Typography>{sale.customer ? `${sale.customer.name}${sale.customer.phone ? ` · ${sale.customer.phone}` : ''}` : 'Walk-in'}</Typography>
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary">Cashier</Typography>
              <Typography>{sale.userName}</Typography>
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary">Payment</Typography>
              <Typography>{sale.payments.map((p) => `${p.method} ${money(p.amount)}`).join(' + ') || '—'}</Typography>
            </Box>
          </Stack>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Item</TableCell>
                <TableCell>HSN</TableCell>
                <TableCell align="right">Qty</TableCell>
                <TableCell align="right">Returned</TableCell>
                <TableCell align="right">Rate</TableCell>
                <TableCell align="right">Discount</TableCell>
                <TableCell align="right">GST</TableCell>
                <TableCell align="right">Amount</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {sale.lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>
                    {l.name}
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                      {l.sku}
                    </Typography>
                  </TableCell>
                  <TableCell>{l.hsnCode}</TableCell>
                  <TableCell align="right">{l.qty}</TableCell>
                  <TableCell align="right">{l.qtyReturned || ''}</TableCell>
                  <TableCell align="right">{money(l.unitPrice)}</TableCell>
                  <TableCell align="right">{l.discount ? money(l.discount) : ''}</TableCell>
                  <TableCell align="right">{rate(l.gstRateBp)}</TableCell>
                  <TableCell align="right">{money(l.lineTotal)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Divider sx={{ my: 2 }} />
          <Stack direction="row" spacing={4} sx={{ justifyContent: 'flex-end' }}>
            <Typography>Taxable {money(sale.taxableTotal)}</Typography>
            {sale.interState ? <Typography>IGST {money(sale.igstTotal)}</Typography> : <Typography>CGST {money(sale.cgstTotal)} · SGST {money(sale.sgstTotal)}</Typography>}
            <Typography>Round off {money(sale.roundOff)}</Typography>
            <Typography variant="h6">Total {money(sale.grandTotal)}</Typography>
          </Stack>
          {sale.returns.length > 0 && (
            <Box sx={{ mt: 2 }}>
              <Typography variant="subtitle2">Returns</Typography>
              {sale.returns.map((r) => (
                <Typography key={r.id} variant="body2">
                  {r.returnNo} · {dateTime(r.occurredAt)} · refund {money(r.refundTotal)} · {r.reason}
                </Typography>
              ))}
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          {can('pos.return') && returnable && (
            <Button startIcon={<UndoIcon />} color="warning" onClick={() => setReturning(true)}>
              Return / Exchange
            </Button>
          )}
          <Box sx={{ flex: 1 }} />
          <Button startIcon={<PrintIcon />} onClick={() => print('receipt', sale)}>
            Print receipt
          </Button>
          <Button startIcon={<PrintIcon />} onClick={() => print('invoice', sale)}>
            GST invoice (A4)
          </Button>
          <Button variant="contained" onClick={onClose}>
            Close
          </Button>
        </DialogActions>
      </Dialog>
      {returning && (
        <ReturnDialog
          sale={sale}
          onClose={() => setReturning(false)}
          onDone={() => {
            setReturning(false);
            onChanged?.();
          }}
        />
      )}
    </>
  );
}
