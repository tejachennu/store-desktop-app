import { useEffect, useState } from 'react';
import {
  Alert,
  Avatar,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Grid,
  IconButton,
  List,
  ListItem,
  ListItemText,
  MenuItem,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import CategoryIcon from '@mui/icons-material/Category';
import { GST_RATES_BP, UNITS, productInputSchema, type CategoryRow, type ProductRow } from '@store/shared';
import { useApp } from '../AppState';
import { call, central, errorMessage } from '../lib/api';
import { useAsync } from '../lib/hooks';
import { date, money, parseRupees, rate, rupeesText } from '../lib/format';
import { DataTable } from '../components/DataTable';
import { ErrorAlert, PageHeader } from '../components/common';

type Item = Awaited<ReturnType<typeof load>>['rows'][number];
const load = (categoryId: string, includeInactive: boolean) =>
  call('catalog.searchProducts', { categoryId: categoryId || undefined, activeOnly: !includeInactive, limit: 500 });

export function ProductsPage() {
  const { can, info } = useApp();
  const [categoryId, setCategoryId] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [editing, setEditing] = useState<ProductRow | 'new' | null>(null);
  const [catsOpen, setCatsOpen] = useState(false);
  const products = useAsync(() => load(categoryId, includeInactive), [categoryId, includeInactive]);
  const categories = useAsync(() => call('catalog.categories'), [catsOpen]);
  const manage = can('products.manage');
  const online = !!info?.session?.online;

  return (
    <Box>
      <PageHeader
        title="Products"
        subtitle={manage ? 'The catalogue is managed centrally; changes reach every warehouse and branch on their next sync.' : 'Company product catalogue'}
        actions={
          manage && (
            <>
              <Button variant="outlined" startIcon={<CategoryIcon />} onClick={() => setCatsOpen(true)} disabled={!online}>
                Categories
              </Button>
              <Button variant="contained" startIcon={<AddIcon />} onClick={() => setEditing('new')} disabled={!online}>
                New product
              </Button>
            </>
          )
        }
      />
      {manage && !online && <Alert severity="info" sx={{ mb: 2 }}>Sign in online to add or edit products.</Alert>}
      <ErrorAlert error={products.error} onRetry={products.reload} />
      <DataTable<Item>
        rows={products.data?.rows ?? []}
        loading={products.loading}
        rowKey={(r) => r.id}
        onRowClick={manage && online ? async (r) => setEditing(await call('catalog.getProduct', { id: r.id })) : undefined}
        searchPlaceholder="Name, SKU, brand, barcode…"
        toolbar={
          <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
            <TextField select label="Category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} sx={{ minWidth: 180 }}>
              <MenuItem value="">All categories</MenuItem>
              {(categories.data ?? []).map((c) => (
                <MenuItem key={c.id} value={c.id}>
                  {c.name}
                </MenuItem>
              ))}
            </TextField>
            <FormControlLabel control={<Switch checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />} label="Show inactive" />
          </Stack>
        }
        columns={[
          { key: 'sku', label: 'SKU' },
          { key: 'name', label: 'Name', render: (r) => <>{r.name}{r.variantGroup && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{r.variantGroup} · {Object.values(r.variantAttrs).join(' / ')}</Typography>}</> },
          { key: 'categoryName', label: 'Category' },
          { key: 'barcodes', label: 'Barcodes', value: (r) => r.barcodes.map((b) => b.barcode).join(' '), render: (r) => r.barcodes.map((b) => (b.factor > 1 ? `${b.barcode} (${b.unitLabel}×${b.factor})` : b.barcode)).join(', ') },
          { key: 'hsnCode', label: 'HSN' },
          { key: 'gstRateBp', label: 'GST', align: 'right', render: (r) => rate(r.gstRateBp) },
          { key: 'purchasePrice', label: 'Cost', align: 'right', render: (r) => money(r.purchasePrice) },
          { key: 'sellingPrice', label: 'Price', align: 'right', render: (r) => money(r.sellingPrice) },
          { key: 'mrp', label: 'MRP', align: 'right', render: (r) => (r.mrp ? money(r.mrp) : '') },
          { key: 'qtyOnHand', label: 'Stock here', align: 'right' },
          { key: 'isActive', label: 'Status', render: (r) => (r.isActive ? <Chip size="small" color="success" label="Active" /> : <Chip size="small" label="Inactive" />), value: (r) => (r.isActive ? 1 : 0) },
        ]}
      />
      {editing && (
        <ProductDialog
          product={editing === 'new' ? null : editing}
          categories={categories.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            // Pull the change into the local cache, then refresh the list.
            void call('sync.now').finally(() => void products.reload());
          }}
        />
      )}
      {catsOpen && <CategoriesDialog categories={categories.data ?? []} onClose={() => setCatsOpen(false)} onChanged={() => void call('sync.now').finally(() => void categories.reload())} />}
    </Box>
  );
}

/** Downscale an image file to a ≤ 600 px JPEG data URL to keep the catalogue small. */
async function imageToDataUrl(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    const scale = Math.min(1, 600 / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.82);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function ProductDialog({ product, categories, onClose, onSaved }: { product: ProductRow | null; categories: CategoryRow[]; onClose: () => void; onSaved: () => void }) {
  const { notify } = useApp();
  const [tab, setTab] = useState(0);
  const [f, setF] = useState(() => ({
    sku: product?.sku ?? '',
    name: product?.name ?? '',
    categoryId: product?.categoryId ?? '',
    brand: product?.brand ?? '',
    hsnCode: product?.hsnCode ?? '',
    unit: product?.unit ?? 'pcs',
    gstRateBp: product?.gstRateBp ?? 1800,
    purchasePrice: product ? rupeesText(product.purchasePrice) : '',
    sellingPrice: product ? rupeesText(product.sellingPrice) : '',
    mrp: product?.mrp ? rupeesText(product.mrp) : '',
    priceIncludesTax: product?.priceIncludesTax ?? true,
    reorderLevel: String(product?.reorderLevel ?? 0),
    variantGroup: product?.variantGroup ?? '',
    variantAttrs: Object.entries(product?.variantAttrs ?? {}).map(([k, v]) => `${k}=${v}`).join(', '),
    imageData: product?.imageData ?? null,
    isActive: product?.isActive ?? true,
    barcodes: product?.barcodes ?? [],
  }));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<any[] | null>(null);
  useEffect(() => {
    if (tab === 2 && product && !history) central<any[]>('GET', `/api/products/${product.id}/price-history`).then(setHistory).catch(() => setHistory([]));
  }, [tab, product, history]);

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  const save = async () => {
    setError(null);
    const attrs: Record<string, string> = {};
    for (const part of f.variantAttrs.split(',').map((s) => s.trim()).filter(Boolean)) {
      const [k, ...v] = part.split('=');
      if (!k || !v.length) return setError('Variant attributes must look like "Size=XL, Colour=Blue"');
      attrs[k.trim()] = v.join('=').trim();
    }
    const body = {
      sku: f.sku,
      name: f.name,
      categoryId: f.categoryId || null,
      brand: f.brand || null,
      hsnCode: f.hsnCode || null,
      unit: f.unit,
      gstRateBp: Number(f.gstRateBp),
      purchasePrice: parseRupees(f.purchasePrice) ?? -1,
      sellingPrice: parseRupees(f.sellingPrice) ?? -1,
      mrp: f.mrp ? parseRupees(f.mrp) ?? -1 : null,
      priceIncludesTax: f.priceIncludesTax,
      reorderLevel: Math.floor(Number(f.reorderLevel) || 0),
      variantGroup: f.variantGroup || null,
      variantAttrs: attrs,
      imageData: f.imageData,
      isActive: f.isActive,
      barcodes: f.barcodes.filter((b) => b.barcode.trim()),
    };
    const check = productInputSchema.safeParse(body);
    if (!check.success) return setError(check.error.issues.map((i) => `${i.path.join('.') || 'product'}: ${i.message}`).join('; '));
    setBusy(true);
    try {
      if (product) await central('PUT', `/api/products/${product.id}`, body);
      else await central('POST', '/api/products', body);
      notify(`Product ${product ? 'updated' : 'created'}`);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>{product ? `Edit ${product.name}` : 'New product'}</DialogTitle>
      <DialogContent>
        <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ mb: 2 }}>
          <Tab label="Details" />
          <Tab label="Barcodes & variants" />
          {product && <Tab label="Purchase price history" />}
        </Tabs>
        {tab === 0 && (
          <Grid container spacing={2}>
            <Grid size={4}>
              <TextField fullWidth label="SKU" value={f.sku} onChange={set('sku')} required />
            </Grid>
            <Grid size={8}>
              <TextField fullWidth label="Name" value={f.name} onChange={set('name')} required />
            </Grid>
            <Grid size={4}>
              <TextField fullWidth select label="Category" value={f.categoryId} onChange={set('categoryId')}>
                <MenuItem value="">—</MenuItem>
                {categories.map((c) => (
                  <MenuItem key={c.id} value={c.id}>
                    {c.name}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>
            <Grid size={4}>
              <TextField fullWidth label="Brand" value={f.brand} onChange={set('brand')} />
            </Grid>
            <Grid size={4}>
              <TextField fullWidth label="HSN / SAC" value={f.hsnCode} onChange={set('hsnCode')} />
            </Grid>
            <Grid size={3}>
              <TextField fullWidth select label="Base unit" value={f.unit} onChange={set('unit')}>
                {UNITS.map((u) => (
                  <MenuItem key={u} value={u}>
                    {u}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>
            <Grid size={3}>
              <TextField fullWidth select label="GST rate" value={f.gstRateBp} onChange={set('gstRateBp')}>
                {GST_RATES_BP.map((r) => (
                  <MenuItem key={r} value={r}>
                    {rate(r)}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>
            <Grid size={3}>
              <TextField fullWidth label="Reorder level" value={f.reorderLevel} onChange={set('reorderLevel')} />
            </Grid>
            <Grid size={3}>
              <FormControlLabel control={<Switch checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />} label="Active" />
            </Grid>
            <Grid size={3}>
              <TextField fullWidth label="Purchase price (₹)" value={f.purchasePrice} onChange={set('purchasePrice')} />
            </Grid>
            <Grid size={3}>
              <TextField fullWidth label="Selling price (₹)" value={f.sellingPrice} onChange={set('sellingPrice')} />
            </Grid>
            <Grid size={3}>
              <TextField fullWidth label="MRP (₹)" value={f.mrp} onChange={set('mrp')} />
            </Grid>
            <Grid size={3}>
              <FormControlLabel control={<Switch checked={f.priceIncludesTax} onChange={(e) => setF({ ...f, priceIncludesTax: e.target.checked })} />} label="Price incl. GST" />
            </Grid>
            <Grid size={12}>
              <Stack direction="row" spacing={2} sx={{ alignItems: 'center' }}>
                <Avatar variant="rounded" src={f.imageData ?? undefined} sx={{ width: 72, height: 72 }} />
                <Button component="label" variant="outlined">
                  Upload image
                  <input
                    hidden
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (file) setF({ ...f, imageData: await imageToDataUrl(file) });
                    }}
                  />
                </Button>
                {f.imageData && <Button onClick={() => setF({ ...f, imageData: null })}>Remove</Button>}
              </Stack>
            </Grid>
          </Grid>
        )}
        {tab === 1 && (
          <Stack spacing={2}>
            <Typography variant="subtitle2">Barcodes (EAN/UPC, QR payload or internal codes). Use a factor for pack barcodes, e.g. a box of 12.</Typography>
            {f.barcodes.map((b, i) => (
              <Stack key={i} direction="row" spacing={1}>
                <TextField label="Barcode" value={b.barcode} onChange={(e) => setF({ ...f, barcodes: f.barcodes.map((x, j) => (j === i ? { ...x, barcode: e.target.value } : x)) })} sx={{ flex: 1 }} />
                <TextField label="Pack label" value={b.unitLabel} onChange={(e) => setF({ ...f, barcodes: f.barcodes.map((x, j) => (j === i ? { ...x, unitLabel: e.target.value } : x)) })} sx={{ width: 120 }} />
                <TextField label="Units per pack" value={b.factor} onChange={(e) => setF({ ...f, barcodes: f.barcodes.map((x, j) => (j === i ? { ...x, factor: Math.max(1, Math.floor(Number(e.target.value) || 1)) } : x)) })} sx={{ width: 130 }} />
                <IconButton onClick={() => setF({ ...f, barcodes: f.barcodes.filter((_, j) => j !== i) })}>
                  <DeleteIcon />
                </IconButton>
              </Stack>
            ))}
            <Button startIcon={<AddIcon />} onClick={() => setF({ ...f, barcodes: [...f.barcodes, { barcode: '', unitLabel: f.unit, factor: 1 }] })} sx={{ alignSelf: 'flex-start' }}>
              Add barcode
            </Button>
            <Typography variant="subtitle2" sx={{ pt: 2 }}>
              Variants — products that share a group name are shown together (e.g. a shirt in several sizes, each its own SKU).
            </Typography>
            <Stack direction="row" spacing={2}>
              <TextField label="Variant group" value={f.variantGroup} onChange={set('variantGroup')} sx={{ flex: 1 }} />
              <TextField label="Attributes" placeholder="Size=XL, Colour=Blue" value={f.variantAttrs} onChange={set('variantAttrs')} sx={{ flex: 2 }} />
            </Stack>
          </Stack>
        )}
        {tab === 2 && (
          <List dense>
            {(history ?? []).map((h, i) => (
              <ListItem key={i}>
                <ListItemText primary={`${money(h.unitCost)} × ${h.qty} — ${h.supplierName}`} secondary={`${date(h.receivedAt)} · ${h.grnNo} · ${h.locationName}`} />
              </ListItem>
            ))}
            {history && history.length === 0 && <Typography color="text.secondary">No purchases recorded yet.</Typography>}
          </List>
        )}
        {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={save} disabled={busy}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function CategoriesDialog({ categories, onClose, onChanged }: { categories: CategoryRow[]; onClose: () => void; onChanged: () => void }) {
  const { notify } = useApp();
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setError(null);
    try {
      await central('POST', '/api/categories', { name, parentId: parentId || null, isActive: true });
      notify('Category added');
      setName('');
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const toggle = async (c: CategoryRow) => {
    try {
      await central('PUT', `/api/categories/${c.id}`, { name: c.name, parentId: c.parentId, isActive: !c.isActive });
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Categories</DialogTitle>
      <DialogContent>
        <Stack direction="row" spacing={1} sx={{ my: 1 }}>
          <TextField label="New category" value={name} onChange={(e) => setName(e.target.value)} sx={{ flex: 1 }} />
          <TextField select label="Parent" value={parentId} onChange={(e) => setParentId(e.target.value)} sx={{ width: 180 }}>
            <MenuItem value="">—</MenuItem>
            {categories.map((c) => (
              <MenuItem key={c.id} value={c.id}>
                {c.name}
              </MenuItem>
            ))}
          </TextField>
          <Button variant="contained" onClick={add} disabled={!name.trim()}>
            Add
          </Button>
        </Stack>
        {error && <Alert severity="error">{error}</Alert>}
        <List dense>
          {categories.map((c) => (
            <ListItem key={c.id} secondaryAction={<Switch checked={c.isActive} onChange={() => toggle(c)} />}>
              <ListItemText primary={c.name} secondary={c.parentId ? `in ${categories.find((p) => p.id === c.parentId)?.name ?? ''}` : undefined} />
            </ListItem>
          ))}
        </List>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Done</Button>
      </DialogActions>
    </Dialog>
  );
}
