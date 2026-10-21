import { useState } from 'react';
import { Box, Button, Stack, Tab, Tabs, TextField } from '@mui/material';
import type { ApiResult } from '../../../core/api';
import { call, errorMessage } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { dateTime, money, todayIso } from '../lib/format';
import { DataTable } from '../components/DataTable';
import { ErrorAlert, PageHeader, SyncChip } from '../components/common';
import { SaleDialog } from '../components/SaleDialog';
import { useApp } from '../AppState';

type SaleRow = { id: string; invoiceNo: string; occurredAt: string; grandTotal: number; taxTotal: number; customerName: string | null; customerPhone: string | null; userName: string; refunded: number; methods: string | null; syncStatus: string | null };
type ReturnRow = { id: string; returnNo: string; occurredAt: string; reason: string; refundTotal: number; invoiceNo: string; userName: string };

export function SalesPage() {
  const { notify } = useApp();
  const [tab, setTab] = useState(0);
  const [from, setFrom] = useState(todayIso(-6));
  const [to, setTo] = useState(todayIso());
  const [invoice, setInvoice] = useState('');
  const [open, setOpen] = useState<ApiResult<'sales.get'> | null>(null);
  const sales = useAsync(() => call('sales.list', { from, to }) as Promise<SaleRow[]>, [from, to]);
  const returns = useAsync(() => call('sales.returns') as Promise<ReturnRow[]>, []);

  const openSale = async (id: string) => {
    try {
      setOpen(await call('sales.get', { id }));
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
  };
  const findInvoice = async () => {
    const s = await call('sales.findByInvoice', { invoiceNo: invoice });
    if (s) setOpen(s);
    else notify(`Invoice ${invoice} not found on this computer`, 'warning');
  };

  const total = (sales.data ?? []).reduce((s, r) => s + r.grandTotal, 0);
  return (
    <Box>
      <PageHeader
        title="Sales & Returns"
        subtitle="Invoices made on this computer. Open an invoice to reprint it or process a return / exchange."
        actions={
          <Stack direction="row" spacing={1}>
            <TextField label="Invoice no." value={invoice} onChange={(e) => setInvoice(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void findInvoice()} />
            <Button variant="outlined" onClick={findInvoice} disabled={!invoice.trim()}>
              Open
            </Button>
          </Stack>
        }
      />
      <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab label="Invoices" />
        <Tab label="Returns & credit notes" />
      </Tabs>
      {tab === 0 && (
        <>
          <ErrorAlert error={sales.error} onRetry={sales.reload} />
          <DataTable
            rows={sales.data ?? []}
            loading={sales.loading}
            rowKey={(r) => r.id}
            onRowClick={(r) => openSale(r.id)}
            searchPlaceholder="Invoice, customer, phone…"
            toolbar={
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                <TextField type="date" label="From" value={from} onChange={(e) => setFrom(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
                <TextField type="date" label="To" value={to} onChange={(e) => setTo(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
                <Box sx={{ fontWeight: 600, ml: 2 }}>Total {money(total)}</Box>
              </Stack>
            }
            columns={[
              { key: 'invoiceNo', label: 'Invoice' },
              { key: 'occurredAt', label: 'Date', render: (r) => dateTime(r.occurredAt) },
              { key: 'customerName', label: 'Customer', render: (r) => r.customerName ?? 'Walk-in', value: (r) => `${r.customerName ?? ''} ${r.customerPhone ?? ''}` },
              { key: 'methods', label: 'Paid by' },
              { key: 'userName', label: 'Cashier' },
              { key: 'taxTotal', label: 'GST', align: 'right', render: (r) => money(r.taxTotal) },
              { key: 'grandTotal', label: 'Total', align: 'right', render: (r) => money(r.grandTotal) },
              { key: 'refunded', label: 'Refunded', align: 'right', render: (r) => (r.refunded ? money(r.refunded) : '') },
              { key: 'syncStatus', label: 'Sync', render: (r) => <SyncChip status={r.syncStatus} /> },
            ]}
          />
        </>
      )}
      {tab === 1 && (
        <DataTable
          rows={returns.data ?? []}
          loading={returns.loading}
          rowKey={(r) => r.id}
          columns={[
            { key: 'returnNo', label: 'Credit note' },
            { key: 'invoiceNo', label: 'Invoice' },
            { key: 'occurredAt', label: 'Date', render: (r) => dateTime(r.occurredAt) },
            { key: 'reason', label: 'Reason' },
            { key: 'userName', label: 'By' },
            { key: 'refundTotal', label: 'Refund', align: 'right', render: (r) => money(r.refundTotal) },
          ]}
        />
      )}
      <SaleDialog
        sale={open}
        onClose={() => setOpen(null)}
        onChanged={async () => {
          if (open) setOpen(await call('sales.get', { id: open.id }));
          void sales.reload();
          void returns.reload();
        }}
      />
    </Box>
  );
}
