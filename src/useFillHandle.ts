/**
 * useFillHandle — Userland drag-fill handle for MUI X DataGrid Premium.
 *
 * Adds an Excel-style fill handle to the bottom-right corner of the cell
 * selection.  The user drags it up/down or left/right to fill target cells
 * with the source values in a cycling pattern.
 *
 * Dragging is locked to a single axis (vertical or horizontal) based on
 * the dominant direction of initial mouse movement — just like Excel.
 *
 * Only PUBLIC DataGridPremium APIs are used — no internal imports.
 */

import { useEffect, useRef } from 'react';
import type {
  GridRowId,
  GridCellParams,
  GridColDef,
} from '@mui/x-data-grid-premium';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The apiRef shape we depend on (subset of GridApiPremium). */
export interface FillHandleApi {
  rootElementRef: React.RefObject<HTMLElement | null>;
  getSelectedCellsAsArray: () => Array<{ id: GridRowId; field: string }>;
  getCellParams: (id: GridRowId, field: string) => GridCellParams;
  getColumn: (field: string) => GridColDef;
  setCellSelectionModel: (
    model: Record<GridRowId, Record<string, boolean>>,
  ) => void;
  getCellSelectionModel: () => Record<GridRowId, Record<string, boolean>>;
  getSortedRowIds: () => GridRowId[];
  getVisibleColumns: () => GridColDef[];
  updateRows: (updates: Array<Record<string, unknown>>) => void;
  subscribeEvent: (
    event: string,
    handler: (...args: unknown[]) => void,
  ) => () => void;
}

export interface FillUpdate {
  id: GridRowId;
  [field: string]: unknown;
}

type ApiRef = React.RefObject<FillHandleApi>;

type DragAxis = 'none' | 'vertical' | 'horizontal';

// Minimum pixels moved before we lock to an axis
const AXIS_LOCK_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useFillHandle(
  apiRef: ApiRef,
  onFill?: (updates: FillUpdate[]) => void,
): void {
  // Keep onFill in a ref so the effect doesn't re-run when it changes.
  const onFillRef = useRef(onFill);
  onFillRef.current = onFill;

  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;

    // ── Drag state ───────────────────────────────────────────────────
    let isDragging = false;
    let dragAxis: DragAxis = 'none';
    let startClientX = 0;
    let startClientY = 0;

    // Source selection bounds
    let sourceRowStart = -1;
    let sourceRowEnd = -1;
    let sourceColStart = -1;
    let sourceColEnd = -1;

    // Source fields (columns) in visual order
    let sourceFields: string[] = [];
    // Source row ids in visual order
    let sourceRowIds: GridRowId[] = [];
    // Source values: sourceValues[colIdx][rowIdx]
    let sourceValues: unknown[][] = [];

    // Current fill targets
    let currentTargetRowIds: GridRowId[] = [];
    let currentTargetFields: string[] = [];

    let decoratedEls = new Set<HTMLElement>();
    let rafId = 0;

    // ── Helpers ──────────────────────────────────────────────────────

    function getRootEl(): HTMLElement | null {
      return api.rootElementRef?.current ?? null;
    }

    function getCellEl(
      rowId: GridRowId,
      field: string,
    ): HTMLElement | null {
      const root = getRootEl();
      if (!root) return null;
      const escapedId = CSS.escape(String(rowId));
      const escapedField = CSS.escape(field);
      return root.querySelector<HTMLElement>(
        `[data-id="${escapedId}"] [data-field="${escapedField}"]`,
      );
    }

    function clearPreviewClasses(): void {
      for (const el of decoratedEls) {
        el.classList.remove(
          'fill-preview',
          'fill-preview-top',
          'fill-preview-bottom',
          'fill-preview-left',
          'fill-preview-right',
        );
      }
      decoratedEls = new Set();
    }

    function resolveRowId(raw: string): GridRowId | null {
      const sortedIds = api.getSortedRowIds();
      if (sortedIds.includes(raw as GridRowId)) return raw;
      const asNum = Number(raw);
      if (!Number.isNaN(asNum) && sortedIds.includes(asNum)) return asNum;
      return null;
    }

    // ── 1. Position the fill handle on the bottom-right selected cell ─

    const unsubSelection = api.subscribeEvent(
      'cellSelectionChange',
      () => {
        const root = getRootEl();
        if (!root) return;

        root
          .querySelectorAll('.fill-handle-cell')
          .forEach((el) => el.classList.remove('fill-handle-cell'));

        const selected = api.getSelectedCellsAsArray();
        if (selected.length === 0) return;

        const sortedIds = api.getSortedRowIds();
        const visibleCols = api.getVisibleColumns();

        let bestRowIdx = -1;
        let bestColIdx = -1;
        let bestCell: { id: GridRowId; field: string } | null = null;

        for (const cell of selected) {
          const ri = sortedIds.indexOf(cell.id);
          const ci = visibleCols.findIndex((c) => c.field === cell.field);
          if (ri < 0 || ci < 0) continue;
          if (
            ri > bestRowIdx ||
            (ri === bestRowIdx && ci > bestColIdx)
          ) {
            bestRowIdx = ri;
            bestColIdx = ci;
            bestCell = cell;
          }
        }

        if (bestCell) {
          getCellEl(bestCell.id, bestCell.field)?.classList.add(
            'fill-handle-cell',
          );
        }
      },
    );

    // ── 2. Detect mousedown on the fill handle ──────────────────────

    const unsubMouseDown = api.subscribeEvent(
      'cellMouseDown',
      (...args: unknown[]) => {
        const params = args[0] as GridCellParams;
        const event = args[1] as React.MouseEvent<HTMLElement> & {
          defaultMuiPrevented?: boolean;
        };

        const cellEl = getCellEl(params.id, params.field);
        if (!cellEl?.classList.contains('fill-handle-cell')) return;

        // Hit-test: pointer must be within 14 px of the cell's
        // bottom-right corner (the fill handle zone).
        const rect = cellEl.getBoundingClientRect();
        if (
          rect.right - event.clientX > 14 ||
          rect.bottom - event.clientY > 14 ||
          event.clientX > rect.right + 4 ||
          event.clientY > rect.bottom + 4
        ) {
          return;
        }

        // Suppress the default MUI cell-selection drag
        event.preventDefault();
        event.stopPropagation();
        event.defaultMuiPrevented = true;

        // Gather ALL selected cells and compute bounds
        const selected = api.getSelectedCellsAsArray();
        if (selected.length === 0) return;

        const sortedIds = api.getSortedRowIds();
        const visibleCols = api.getVisibleColumns();

        let minRow = Infinity, maxRow = -1;
        let minCol = Infinity, maxCol = -1;

        for (const cell of selected) {
          const ri = sortedIds.indexOf(cell.id);
          const ci = visibleCols.findIndex((c) => c.field === cell.field);
          if (ri < 0 || ci < 0) continue;
          minRow = Math.min(minRow, ri);
          maxRow = Math.max(maxRow, ri);
          minCol = Math.min(minCol, ci);
          maxCol = Math.max(maxCol, ci);
        }

        if (maxRow < 0 || maxCol < 0) return;

        // Collect source fields in visual order, filtering to editable
        const fields: string[] = [];
        for (let c = minCol; c <= maxCol; c++) {
          const col = visibleCols[c];
          if (col.editable) fields.push(col.field);
        }
        if (fields.length === 0) return;

        // Collect source row ids in visual order
        const rowIds: GridRowId[] = [];
        for (let r = minRow; r <= maxRow; r++) {
          rowIds.push(sortedIds[r]);
        }

        // Build source values matrix: [colIdx][rowIdx]
        const values: unknown[][] = fields.map((field) =>
          rowIds.map((id) => api.getCellParams(id, field).value),
        );

        isDragging = true;
        dragAxis = 'none';
        startClientX = event.clientX;
        startClientY = event.clientY;
        sourceRowStart = minRow;
        sourceRowEnd = maxRow;
        sourceColStart = minCol;
        sourceColEnd = maxCol;
        sourceFields = fields;
        sourceRowIds = rowIds;
        sourceValues = values;
        currentTargetRowIds = [];
        currentTargetFields = [];

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      },
    );

    // ── 3. Mousemove — throttled via requestAnimationFrame ──────────

    function onMouseMove(e: MouseEvent): void {
      if (!isDragging) return;
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() =>
        handleMove(e.clientX, e.clientY),
      );
    }

    function handleMove(clientX: number, clientY: number): void {
      // Determine axis lock if not yet locked
      if (dragAxis === 'none') {
        const dx = Math.abs(clientX - startClientX);
        const dy = Math.abs(clientY - startClientY);
        if (dx < AXIS_LOCK_THRESHOLD && dy < AXIS_LOCK_THRESHOLD) {
          // Haven't moved enough yet — don't show any preview
          currentTargetRowIds = [];
          currentTargetFields = [];
          clearPreviewClasses();
          return;
        }
        dragAxis = dy >= dx ? 'vertical' : 'horizontal';
      }

      const sortedIds = api.getSortedRowIds();
      const visibleCols = api.getVisibleColumns();

      // Walk DOM to find the row and column under the pointer
      const hits = document.elementsFromPoint(clientX, clientY);
      let targetRowId: GridRowId | null = null;
      let targetField: string | null = null;

      for (const hit of hits) {
        let node: HTMLElement | null = hit as HTMLElement;
        while (node) {
          if (targetField === null && node.dataset?.field !== undefined) {
            targetField = node.dataset.field;
          }
          if (targetRowId === null && node.dataset?.id !== undefined) {
            targetRowId = resolveRowId(node.dataset.id);
          }
          if (targetRowId !== null && targetField !== null) break;
          node = node.parentElement;
        }
        if (targetRowId !== null && targetField !== null) break;
      }

      if (dragAxis === 'vertical') {
        // ── Vertical fill: extend rows, keep source columns ──
        if (targetRowId === null) {
          currentTargetRowIds = [];
          currentTargetFields = [];
          clearPreviewClasses();
          return;
        }

        const targetIdx = sortedIds.indexOf(targetRowId);
        if (targetIdx < 0) return;

        const newTargetRows: GridRowId[] = [];
        if (targetIdx > sourceRowEnd) {
          for (let i = sourceRowEnd + 1; i <= targetIdx; i++) {
            newTargetRows.push(sortedIds[i]);
          }
        } else if (targetIdx < sourceRowStart) {
          for (let i = targetIdx; i < sourceRowStart; i++) {
            newTargetRows.push(sortedIds[i]);
          }
        }

        currentTargetRowIds = newTargetRows;
        currentTargetFields = sourceFields;

        // Apply preview decoration
        const nextDecorated = new Set<HTMLElement>();
        for (let ri = 0; ri < newTargetRows.length; ri++) {
          for (let fi = 0; fi < sourceFields.length; fi++) {
            const el = getCellEl(newTargetRows[ri], sourceFields[fi]);
            if (!el) continue;

            el.classList.add('fill-preview');
            if (ri === 0) el.classList.add('fill-preview-top');
            if (ri === newTargetRows.length - 1) el.classList.add('fill-preview-bottom');
            if (fi === 0) el.classList.add('fill-preview-left');
            if (fi === sourceFields.length - 1) el.classList.add('fill-preview-right');

            nextDecorated.add(el);
          }
        }

        for (const el of decoratedEls) {
          if (!nextDecorated.has(el)) {
            el.classList.remove(
              'fill-preview', 'fill-preview-top', 'fill-preview-bottom',
              'fill-preview-left', 'fill-preview-right',
            );
          }
        }
        decoratedEls = nextDecorated;

      } else {
        // ── Horizontal fill: extend columns, keep source rows ──
        if (targetField === null) {
          currentTargetRowIds = [];
          currentTargetFields = [];
          clearPreviewClasses();
          return;
        }

        const targetColIdx = visibleCols.findIndex((c) => c.field === targetField);
        if (targetColIdx < 0) return;

        const newTargetFields: string[] = [];
        if (targetColIdx > sourceColEnd) {
          for (let i = sourceColEnd + 1; i <= targetColIdx; i++) {
            const col = visibleCols[i];
            if (col.editable) newTargetFields.push(col.field);
          }
        } else if (targetColIdx < sourceColStart) {
          for (let i = targetColIdx; i < sourceColStart; i++) {
            const col = visibleCols[i];
            if (col.editable) newTargetFields.push(col.field);
          }
        }

        currentTargetRowIds = sourceRowIds;
        currentTargetFields = newTargetFields;

        // Apply preview decoration
        const nextDecorated = new Set<HTMLElement>();
        for (let ri = 0; ri < sourceRowIds.length; ri++) {
          for (let fi = 0; fi < newTargetFields.length; fi++) {
            const el = getCellEl(sourceRowIds[ri], newTargetFields[fi]);
            if (!el) continue;

            el.classList.add('fill-preview');
            if (ri === 0) el.classList.add('fill-preview-top');
            if (ri === sourceRowIds.length - 1) el.classList.add('fill-preview-bottom');
            if (fi === 0) el.classList.add('fill-preview-left');
            if (fi === newTargetFields.length - 1) el.classList.add('fill-preview-right');

            nextDecorated.add(el);
          }
        }

        for (const el of decoratedEls) {
          if (!nextDecorated.has(el)) {
            el.classList.remove(
              'fill-preview', 'fill-preview-top', 'fill-preview-bottom',
              'fill-preview-left', 'fill-preview-right',
            );
          }
        }
        decoratedEls = nextDecorated;
      }
    }

    // ── 4. Mouseup — apply the fill and extend the selection ────────

    function onMouseUp(): void {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      cancelAnimationFrame(rafId);

      if (isDragging && sourceValues.length > 0) {
        const updates: FillUpdate[] = [];

        if (dragAxis === 'vertical' && currentTargetRowIds.length > 0) {
          // Fill each target row with source values cycling per column
          for (let ri = 0; ri < currentTargetRowIds.length; ri++) {
            const id = currentTargetRowIds[ri];
            const patch: FillUpdate = { id };
            for (let ci = 0; ci < sourceFields.length; ci++) {
              const colValues = sourceValues[ci];
              patch[sourceFields[ci]] = colValues[ri % colValues.length];
            }
            updates.push(patch);
          }
        } else if (dragAxis === 'horizontal' && currentTargetFields.length > 0) {
          // Fill each source row across target columns
          for (const id of sourceRowIds) {
            const rowIdx = sourceRowIds.indexOf(id);
            const patch: FillUpdate = { id };
            for (let ci = 0; ci < currentTargetFields.length; ci++) {
              // Cycle through source columns' values for this row
              const srcColIdx = ci % sourceValues.length;
              patch[currentTargetFields[ci]] = sourceValues[srcColIdx][rowIdx];
            }
            updates.push(patch);
          }
        }

        if (updates.length > 0) {
          api.updateRows(updates);
          onFillRef.current?.(updates);

          // Extend cell selection to include filled cells
          const model = { ...api.getCellSelectionModel() };

          if (dragAxis === 'vertical') {
            for (const id of currentTargetRowIds) {
              if (!model[id]) model[id] = {};
              for (const field of sourceFields) {
                model[id][field] = true;
              }
            }
          } else if (dragAxis === 'horizontal') {
            for (const id of sourceRowIds) {
              if (!model[id]) model[id] = {};
              for (const field of currentTargetFields) {
                model[id][field] = true;
              }
            }
          }

          api.setCellSelectionModel(model);
        }
      }

      // Reset
      isDragging = false;
      dragAxis = 'none';
      sourceRowStart = -1;
      sourceRowEnd = -1;
      sourceColStart = -1;
      sourceColEnd = -1;
      sourceFields = [];
      sourceRowIds = [];
      sourceValues = [];
      currentTargetRowIds = [];
      currentTargetFields = [];
      clearPreviewClasses();
    }

    // ── Cleanup on unmount ──────────────────────────────────────────

    return () => {
      unsubSelection();
      unsubMouseDown();
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      cancelAnimationFrame(rafId);
      clearPreviewClasses();
    };
  }, [apiRef]);
}
