import { useEffect, useRef, useState } from 'react';
import { Autocomplete, Box, TextField, Typography } from '@mui/material';
import type { ProductRow } from '@store/shared';
import { call } from '../lib/api';
import { money } from '../lib/format';

type Item = ProductRow & { qtyOnHand?: number | null };

interface Props {
  label?: string;
  onPick: (p: Item, factor: number) => void;
  autoFocus?: boolean;
  activeOnly?: boolean;
  showStock?: boolean;
  inputRef?: React.Ref<HTMLInputElement>;
  disabled?: boolean;
}

/**
 * Product search box that also accepts barcode-scanner input: scanners type the
 * code and press Enter, which resolves the exact barcode (including pack barcodes).
 */
export function ProductPicker({ label = 'Scan barcode or search product', onPick, autoFocus, activeOnly = true, showStock = true, inputRef, disabled }: Props) {
  const [input, setInput] = useState('');
  const [options, setOptions] = useState<Item[]>([]);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!input.trim()) {
      setOptions([]);
      return;
    }
    timer.current = setTimeout(async () => {
      const res = await call('catalog.searchProducts', { search: input.trim(), activeOnly, limit: 20 });
      setOptions(res.rows);
    }, 150);
  }, [input, activeOnly]);

  const tryBarcode = async () => {
    const code = input.trim();
    if (!code) return false;
    const hit = await call('catalog.findBarcode', { code });
    if (hit) {
      if (activeOnly && !hit.product.isActive) {
        setError(`${hit.product.name} is inactive`);
        return true;
      }
      onPick(hit.product, hit.factor);
      setInput('');
      setOptions([]);
      setError(null);
      return true;
    }
    return false;
  };

  return (
    <Autocomplete<Item, false, false, true>
      freeSolo
      disabled={disabled}
      options={options}
      filterOptions={(x) => x}
      getOptionLabel={(o) => (typeof o === 'string' ? o : `${o.name} (${o.sku})`)}
      inputValue={input}
      onInputChange={(_e, v, reason) => {
        if (reason !== 'reset') setInput(v);
        setError(null);
      }}
      value={null}
      onChange={(_e, v) => {
        if (v && typeof v !== 'string') {
          onPick(v, 1);
          setInput('');
          setOptions([]);
        }
      }}
      renderOption={(props, o) => (
        <Box component="li" {...props} key={o.id} sx={{ display: 'flex', gap: 2 }}>
          <Box sx={{ flex: 1 }}>
            <Typography variant="body2">{o.name}</Typography>
            <Typography variant="caption" color="text.secondary">
              {o.sku} {o.barcodes[0] ? `· ${o.barcodes[0].barcode}` : ''}
            </Typography>
          </Box>
          {showStock && o.qtyOnHand !== undefined && (
            <Typography variant="caption" color={(o.qtyOnHand ?? 0) > 0 ? 'text.secondary' : 'error'}>
              Stock {o.qtyOnHand ?? 0}
            </Typography>
          )}
          <Typography variant="body2" sx={{ minWidth: 80, textAlign: 'right' }}>
            {money(o.sellingPrice)}
          </Typography>
        </Box>
      )}
      renderInput={(params) => (
        <TextField
          {...params}
          label={label}
          autoFocus={autoFocus}
          inputRef={inputRef}
          error={!!error}
          helperText={error ?? undefined}
          onKeyDown={async (e) => {
            if (e.key === 'Enter') {
              const handled = await tryBarcode();
              if (handled) {
                e.preventDefault();
                (e as unknown as { defaultMuiPrevented: boolean }).defaultMuiPrevented = true;
              } else if (options.length === 0 && input.trim()) {
                setError(`No product found for "${input.trim()}"`);
              }
            }
          }}
        />
      )}
    />
  );
}
