import { useState } from 'react';
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Table, TableBody, TableCell, TableHead, TableRow, TextField } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { STATE_CODES, type CustomerRow } from '@store/shared';
import { useApp } from '../AppState';
import { call } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { dateTime, money } from '../lib/format';
import { DataTable } from '../components/DataTable';
import { PageHeader } from '../components/common';
import { CustomerDialog } from '../components/CustomerDialog';
import { SaleDialog } from '../components/SaleDialog';
import type { ApiResult } from '../../../core/api';

export function CustomersPage() {
  const { can } = useApp();
  const [search, setSearch] = useState('');
  const customers = useAsync(() => call('customers.search', { search }), [search]);
  const [editing, setEditing] = useState<CustomerRow | 'new' | null>(null);
  const [history, setHistory] = useState<CustomerRow | null>(null);
  return (
    <Box>
      <PageHeader
        title="Customers"
        subtitle="Customers can be added at any branch, even offline. Purchase history covers invoices made on this computer."
        actions={
          can('customers.manage') && (
            <Button variant="contained" startIcon={<AddIcon />} onClick={() => setEditing('new')}>
              New customer
            </Button>
          )
        }
      />
      <DataTable
        rows={customers.data ?? []}
        loading={customers.loading}
        rowKey={(r) => r.id}
        searchable={false}
        toolbar={
          <TextField
            placeholder="Search name, phone or GSTIN, then press Enter"
            onKeyDown={(e) => e.key === 'Enter' && setSearch((e.target as HTMLInputElement).value)}
            sx={{ width: 360 }}
          />
        }
        onRowClick={(r) => setHistory(r)}
        columns={[
          { key: 'name', label: 'Name' },
          { key: 'phone', label: 'Phone' },
          { key: 'email', label: 'Email' },
          { key: 'gstin', label: 'GSTIN' },
          { key: 'stateCode', label: 'State', render: (r) => (r.stateCode ? STATE_CODES[r.stateCode] ?? r.stateCode : '') },
          {
            key: 'edit',
            label: '',
            sortable: false,
            render: (r) =>
              can('customers.manage') && (
                <Button size="small" onClick={(e) => (e.stopPropagation(), setEditing(r))}>
                  Edit
                </Button>
              ),
          },
        ]}
      />
      <CustomerDialog open={!!editing} initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), void customers.reload())} />
      {history && <HistoryDialog customer={history} onClose={() => setHistory(null)} />}
    </Box>
  );
}

function HistoryDialog({ customer, onClose }: { customer: CustomerRow; onClose: () => void }) {
  const rows = useAsync(() => call('customers.history', { id: customer.id }) as Promise<any[]>, [customer.id]);
  const [sale, setSale] = useState<ApiResult<'sales.get'> | null>(null);
  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Purchase history — {customer.name}</DialogTitle>
      <DialogContent>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Invoice</TableCell>
              <TableCell>Date</TableCell>
              <TableCell align="right">Items</TableCell>
              <TableCell align="right">Total</TableCell>
              <TableCell align="right">Refunded</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(rows.data ?? []).map((r) => (
              <TableRow key={r.id} hover sx={{ cursor: 'pointer' }} onClick={async () => setSale(await call('sales.get', { id: r.id }))}>
                <TableCell>{r.invoiceNo}</TableCell>
                <TableCell>{dateTime(r.occurredAt)}</TableCell>
                <TableCell align="right">{r.items}</TableCell>
                <TableCell align="right">{money(r.grandTotal)}</TableCell>
                <TableCell align="right">{r.refunded ? money(r.refunded) : ''}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
      <SaleDialog sale={sale} onClose={() => setSale(null)} />
    </Dialog>
  );
}
