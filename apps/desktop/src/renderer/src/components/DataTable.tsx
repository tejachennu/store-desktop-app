import { useMemo, useState, type ReactNode } from 'react';
import {
  Box,
  InputAdornment,
  LinearProgress,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TableSortLabel,
  TextField,
  Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';

export interface Column<T> {
  key: string;
  label: string;
  render?: (row: T) => ReactNode;
  /** Value used for sorting and text search (defaults to row[key]). */
  value?: (row: T) => string | number | null | undefined;
  align?: 'left' | 'right' | 'center';
  width?: number | string;
  sortable?: boolean;
}

interface Props<T> {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  loading?: boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
  toolbar?: ReactNode;
  onRowClick?: (row: T) => void;
  empty?: string;
  dense?: boolean;
  pageSize?: number;
  maxHeight?: number | string;
}

/** Searchable, sortable, paginated table used across the app. */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  loading,
  searchable = true,
  searchPlaceholder = 'Search…',
  toolbar,
  onRowClick,
  empty = 'No records',
  dense = true,
  pageSize = 25,
  maxHeight,
}: Props<T>) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);
  const [page, setPage] = useState(0);
  const [perPage, setPerPage] = useState(pageSize);

  const valueOf = (row: T, c: Column<T>) => (c.value ? c.value(row) : (row as Record<string, unknown>)[c.key]) as string | number | null | undefined;

  const filtered = useMemo(() => {
    let out = rows;
    const s = search.trim().toLowerCase();
    if (s) out = out.filter((r) => columns.some((c) => String(valueOf(r, c) ?? '').toLowerCase().includes(s)));
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      if (col) {
        out = [...out].sort((a, b) => {
          const va = valueOf(a, col);
          const vb = valueOf(b, col);
          const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va ?? '').localeCompare(String(vb ?? ''), undefined, { numeric: true });
          return sort.dir === 'asc' ? cmp : -cmp;
        });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, search, sort, columns]);

  const visible = filtered.slice(page * perPage, page * perPage + perPage);

  return (
    <Paper sx={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {(searchable || toolbar) && (
        <Box sx={{ display: 'flex', gap: 1, p: 1.5, alignItems: 'center', flexWrap: 'wrap', borderBottom: '1px solid #e3e8f0' }}>
          {searchable && (
            <TextField
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
              placeholder={searchPlaceholder}
              sx={{ minWidth: 260 }}
              slotProps={{ input: { startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> } }}
            />
          )}
          <Box sx={{ flex: 1 }} />
          {toolbar}
        </Box>
      )}
      {loading && <LinearProgress />}
      <TableContainer sx={{ maxHeight }}>
        <Table size={dense ? 'small' : 'medium'} stickyHeader>
          <TableHead>
            <TableRow>
              {columns.map((c) => (
                <TableCell key={c.key} align={c.align} sx={{ width: c.width, whiteSpace: 'nowrap' }}>
                  {c.sortable === false ? (
                    c.label
                  ) : (
                    <TableSortLabel
                      active={sort?.key === c.key}
                      direction={sort?.key === c.key ? sort.dir : 'asc'}
                      onClick={() => setSort((s) => (s?.key === c.key ? { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: 'asc' }))}
                    >
                      {c.label}
                    </TableSortLabel>
                  )}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {visible.map((row) => (
              <TableRow key={rowKey(row)} hover onClick={onRowClick ? () => onRowClick(row) : undefined} sx={{ cursor: onRowClick ? 'pointer' : undefined }}>
                {columns.map((c) => (
                  <TableCell key={c.key} align={c.align}>
                    {c.render ? c.render(row) : String(valueOf(row, c) ?? '')}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {!loading && visible.length === 0 && (
              <TableRow>
                <TableCell colSpan={columns.length}>
                  <Typography color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>
                    {empty}
                  </Typography>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>
      {filtered.length > perPage && (
        <TablePagination
          component="div"
          count={filtered.length}
          page={page}
          rowsPerPage={perPage}
          onPageChange={(_e, p) => setPage(p)}
          onRowsPerPageChange={(e) => {
            setPerPage(Number(e.target.value));
            setPage(0);
          }}
          rowsPerPageOptions={[25, 50, 100]}
        />
      )}
    </Paper>
  );
}
