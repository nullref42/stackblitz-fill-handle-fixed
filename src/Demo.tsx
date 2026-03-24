import * as React from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import {
  DataGridPremium,
  useGridApiRef,
  type GridColDef,
  type GridRowModel,
  type GridRowsProp,
} from '@mui/x-data-grid-premium';
import { useFillHandle } from './useFillHandle';

// ---------------------------------------------------------------------------
// Column definitions — all editable except `id`
// ---------------------------------------------------------------------------

const columns: GridColDef[] = [
  { field: 'id', headerName: 'ID', width: 60, editable: false },
  { field: 'product', headerName: 'Product', width: 150, editable: true },
  { field: 'category', headerName: 'Category', width: 130, editable: true },
  {
    field: 'price',
    headerName: 'Price',
    width: 100,
    type: 'number',
    editable: true,
  },
  {
    field: 'quantity',
    headerName: 'Quantity',
    width: 100,
    type: 'number',
    editable: true,
  },
  {
    field: 'rating',
    headerName: 'Rating',
    width: 90,
    type: 'number',
    editable: true,
  },
];

// ---------------------------------------------------------------------------
// Sample data — 15 rows, some left empty so the user can fill into them
// ---------------------------------------------------------------------------

const initialRows: GridRowsProp = [
  { id: 1, product: 'Widget A', category: 'Gadgets', price: 25.0, quantity: 100, rating: 4.5 },
  { id: 2, product: 'Widget B', category: 'Gadgets', price: 30.0, quantity: 200, rating: 4.2 },
  { id: 3, product: 'Widget C', category: 'Gadgets', price: 18.5, quantity: 150, rating: 3.8 },
  { id: 4, product: 'Gizmo X', category: 'Tools', price: 55.0, quantity: 80, rating: 4.9 },
  { id: 5, product: 'Gizmo Y', category: 'Tools', price: 42.0, quantity: 60, rating: 4.1 },
  { id: 6, product: '', category: '', price: 0, quantity: 0, rating: 0 },
  { id: 7, product: '', category: '', price: 0, quantity: 0, rating: 0 },
  { id: 8, product: '', category: '', price: 0, quantity: 0, rating: 0 },
  { id: 9, product: 'Doohickey', category: 'Parts', price: 12.0, quantity: 500, rating: 3.5 },
  { id: 10, product: 'Thingamajig', category: 'Parts', price: 8.75, quantity: 320, rating: 3.9 },
  { id: 11, product: '', category: '', price: 0, quantity: 0, rating: 0 },
  { id: 12, product: '', category: '', price: 0, quantity: 0, rating: 0 },
  { id: 13, product: 'Sprocket', category: 'Hardware', price: 15.0, quantity: 420, rating: 4.6 },
  { id: 14, product: 'Cog', category: 'Hardware', price: 9.25, quantity: 700, rating: 4.0 },
  { id: 15, product: '', category: '', price: 0, quantity: 0, rating: 0 },
];

// ---------------------------------------------------------------------------
// Demo component
// ---------------------------------------------------------------------------

export default function Demo() {
  const apiRef = useGridApiRef();
  const [rows, setRows] = React.useState<GridRowsProp>(initialRows);

  // Activate the fill handle
  const { getCellClassName } = useFillHandle(apiRef);

  // Keep React state in sync when the user edits a cell inline
  const processRowUpdate = React.useCallback(
    (newRow: GridRowModel) => {
      setRows((prev) =>
        prev.map((r) => (r.id === newRow.id ? newRow : r)),
      );
      return newRow;
    },
    [],
  );

  return (
    <Box sx={{ width: '100%', p: 3 }}>
      <Typography variant="h5" gutterBottom>
        DataGrid Premium — Drag Fill Handle (Userland)
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Select one or more cells in a column, then drag the small blue
        square at the bottom-right corner of the selection up or down to
        fill target cells with the source values.
      </Typography>

      <Box sx={{ height: 600 }}>
        <DataGridPremium
          apiRef={apiRef}
          rows={rows}
          columns={columns}
          cellSelection
          getCellClassName={getCellClassName}
          processRowUpdate={processRowUpdate}
          sx={{
            height: '100%',

            /* ── Fill-handle indicator (blue square) ─────────────── */
            '& .fill-handle-cell': {
              position: 'relative',
            },
            '& .fill-handle-cell::after': {
              content: '""',
              position: 'absolute',
              bottom: -4,
              right: -4,
              width: 8,
              height: 8,
              backgroundColor: 'primary.main',
              border: '2px solid #fff',
              cursor: 'crosshair',
              zIndex: 50,
              pointerEvents: 'auto',
            },

            /* ── Drag-preview styles ─────────────────────────────── */
            '& .fill-preview': {
              backgroundColor: 'rgba(25, 118, 210, 0.08)',
            },
            '& .fill-preview-top': {
              borderTop: '2px dashed',
              borderTopColor: 'primary.main',
            },
            '& .fill-preview-bottom': {
              borderBottom: '2px dashed',
              borderBottomColor: 'primary.main',
            },
            '& .fill-preview-left': {
              borderLeft: '2px dashed',
              borderLeftColor: 'primary.main',
            },
            '& .fill-preview-right': {
              borderRight: '2px dashed',
              borderRightColor: 'primary.main',
            },
          }}
        />
      </Box>
    </Box>
  );
}
