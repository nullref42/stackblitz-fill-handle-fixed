/**
 * useFillHandle — Userland drag-fill handle for MUI X DataGrid Premium.
 *
 * Adds an Excel-style fill handle to the bottom-right corner of the cell
 * selection.  The user drags it vertically to extend rows or horizontally
 * to extend columns, filling target cells with source values in a cycling
 * pattern.
 *
 * Only PUBLIC DataGridPremium APIs are used — no internal imports.
 */

import { useCallback, useEffect, useState } from 'react';
import type {
  GridRowId,
  GridCellParams,
  GridColDef,
  GridApiPremium,
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
    model: Record<GridRowId, Record<string, boolean>>
  ) => void;
  getCellSelectionModel: () => Record<GridRowId, Record<string, boolean>>;
  getSortedRowIds: () => GridRowId[];
  getVisibleColumns: () => GridColDef[];
  updateRows: (updates: Array<Record<string, unknown>>) => void;
  subscribeEvent: (
    event: string,
    handler: (...args: unknown[]) => void
  ) => () => void;
}

type ApiRef = React.RefObject<GridApiPremium>;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useFillHandle(apiRef: ApiRef) {
  // Track which cell shows the fill-handle indicator.  Stored in React
  // state so that getCellClassName triggers a grid re-render — imperative
  // classList mutations are lost when memoized cells re-render.
  const [fillHandleCell, setFillHandleCell] = useState<{
    id: GridRowId;
    field: string;
  } | null>(null);

  // Provide getCellClassName for the consumer to pass to <DataGridPremium>.
  const getCellClassName = useCallback(
    (params: GridCellParams) => {
      if (
        fillHandleCell &&
        params.id === fillHandleCell.id &&
        params.field === fillHandleCell.field
      ) {
        return 'fill-handle-cell';
      }
      return '';
    },
    [fillHandleCell]
  );

  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;

    // ── Drag state (plain variables — safe inside a single effect) ───
    let isDragging = false;
    let sourceFields: string[] = [];
    let sourceStartRowIdx = -1;
    let sourceEndRowIdx = -1;
    let sourceStartColIdx = -1;
    let sourceEndColIdx = -1;
    let sourceValuesByField = new Map<string, unknown[]>();
    let fillDirection: 'vertical' | 'horizontal' | null = null;
    let currentTargetRowIds: GridRowId[] = [];
    let currentTargetFields: string[] = [];
    let decoratedEls = new Set<HTMLElement>();
    let rafId = 0;

    // ── Helpers ──────────────────────────────────────────────────────

    function getRootEl(): HTMLElement | null {
      return api.rootElementRef?.current ?? null;
    }

    /** Locate a cell's DOM element via data-attributes. */
    function getCellEl(rowId: GridRowId, field: string): HTMLElement | null {
      const root = getRootEl();
      if (!root) return null;
      const escapedId = CSS.escape(String(rowId));
      const escapedField = CSS.escape(field);
      return root.querySelector<HTMLElement>(
        `[data-id="${escapedId}"] [data-field="${escapedField}"]`
      );
    }

    /** Strip all preview CSS classes from previously-decorated elements. */
    function clearPreviewClasses(): void {
      for (const el of decoratedEls) {
        el.classList.remove(
          'fill-preview',
          'fill-preview-top',
          'fill-preview-bottom',
          'fill-preview-left',
          'fill-preview-right'
        );
      }
      decoratedEls = new Set();
    }

    /**
     * Resolve a dataset.id string to the matching GridRowId (which may
     * be a number).  Checks sorted IDs for both the raw string and its
     * numeric conversion.
     */
    function resolveRowId(raw: string): GridRowId | null {
      const sortedIds = api.getSortedRowIds();
      if (sortedIds.includes(raw as GridRowId)) return raw;
      const asNum = Number(raw);
      if (!Number.isNaN(asNum) && sortedIds.includes(asNum)) return asNum;
      return null;
    }

    /**
     * Compute the bottom-right cell of the current selection.
     */
    function getBottomRightCell(): { id: GridRowId; field: string } | null {
      const selected = api.getSelectedCellsAsArray();
      if (selected.length === 0) return null;

      const sortedIds = api.getSortedRowIds();
      const visibleCols = api.getVisibleColumns();

      let bestRowIdx = -1;
      let bestColIdx = -1;
      let bestCell: { id: GridRowId; field: string } | null = null;

      for (const cell of selected) {
        const ri = sortedIds.indexOf(cell.id);
        const ci = visibleCols.findIndex((c) => c.field === cell.field);
        if (ri < 0 || ci < 0) continue;
        if (ri > bestRowIdx || (ri === bestRowIdx && ci > bestColIdx)) {
          bestRowIdx = ri;
          bestColIdx = ci;
          bestCell = cell;
        }
      }

      return bestCell;
    }

    // ── 1. Track which cell should show the fill handle ─────────────

    const unsubSelection = api.subscribeEvent('cellSelectionChange', () => {
      setFillHandleCell(getBottomRightCell());
    });

    // When a cell receives focus (first click), the selection model may
    // not be updated yet.  Set the handle on the focused cell — the next
    // cellSelectionChange will correct it for multi-cell selections.
    const unsubFocusIn = api.subscribeEvent(
      'cellFocusIn',
      (...args: unknown[]) => {
        const params = args[0] as GridCellParams;
        const selected = api.getSelectedCellsAsArray();
        if (selected.length === 0) {
          setFillHandleCell({ id: params.id, field: params.field });
        }
      }
    );

    // ── 2. Detect mousedown on the fill handle ──────────────────────

    const unsubMouseDown = api.subscribeEvent(
      'cellMouseDown',
      (...args: unknown[]) => {
        const params = args[0] as GridCellParams;
        const event = args[1] as React.MouseEvent<HTMLElement> & {
          defaultMuiPrevented?: boolean;
        };

        // Check if the clicked cell is the bottom-right of the selection.
        // On the first click the selection may be empty — fall back to
        // treating the clicked cell itself as the sole source.
        const bottomRight = getBottomRightCell();
        if (
          bottomRight &&
          (bottomRight.id !== params.id || bottomRight.field !== params.field)
        ) {
          return;
        }

        const cellEl = getCellEl(params.id, params.field);
        if (!cellEl) return;

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

        // Gather selected cells — if the selection model is empty (first
        // click race), treat the clicked cell as a single-cell selection.
        let selected = api.getSelectedCellsAsArray();
        if (selected.length === 0) {
          selected = [{ id: params.id, field: params.field }];
        }

        const sortedIds = api.getSortedRowIds();
        const visibleCols = api.getVisibleColumns();

        let minRowIdx = Infinity;
        let maxRowIdx = -1;
        let minColIdx = Infinity;
        let maxColIdx = -1;
        const fieldSet = new Set<string>();

        for (const cell of selected) {
          const ri = sortedIds.indexOf(cell.id);
          const ci = visibleCols.findIndex((c) => c.field === cell.field);
          if (ri < 0 || ci < 0) continue;
          if (ri < minRowIdx) minRowIdx = ri;
          if (ri > maxRowIdx) maxRowIdx = ri;
          if (ci < minColIdx) minColIdx = ci;
          if (ci > maxColIdx) maxColIdx = ci;
          fieldSet.add(cell.field);
        }

        if (maxRowIdx < 0) return;

        // Sort fields by visible column order
        const orderedFields = visibleCols
          .filter((c) => fieldSet.has(c.field))
          .map((c) => c.field);

        // Check at least one selected column is editable
        const hasEditable = orderedFields.some(
          (f) => api.getColumn(f).editable
        );
        if (!hasEditable) return;

        // Collect source values per field in row order
        const valuesByField = new Map<string, unknown[]>();
        for (const field of orderedFields) {
          const values: unknown[] = [];
          for (let i = minRowIdx; i <= maxRowIdx; i++) {
            const id = sortedIds[i];
            if (selected.some((c) => c.id === id && c.field === field)) {
              values.push(api.getCellParams(id, field).value);
            }
          }
          valuesByField.set(field, values);
        }

        isDragging = true;
        sourceFields = orderedFields;
        sourceStartRowIdx = minRowIdx;
        sourceEndRowIdx = maxRowIdx;
        sourceStartColIdx = minColIdx;
        sourceEndColIdx = maxColIdx;
        sourceValuesByField = valuesByField;
        fillDirection = null;
        currentTargetRowIds = [];
        currentTargetFields = [];

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      }
    );

    // ── 3. Mousemove — throttled via requestAnimationFrame ──────────

    function onMouseMove(e: MouseEvent): void {
      if (!isDragging) return;
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => handleMove(e.clientX, e.clientY));
    }

    function handleMove(clientX: number, clientY: number): void {
      // Walk the elements under the pointer to find target row and field
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

      if (targetRowId === null) {
        // Pointer left the grid — clear preview
        currentTargetRowIds = [];
        currentTargetFields = [];
        fillDirection = null;
        clearPreviewClasses();
        return;
      }

      const sortedIds = api.getSortedRowIds();
      const visibleCols = api.getVisibleColumns();
      const targetRowIdx = sortedIds.indexOf(targetRowId);
      const targetColIdx = targetField
        ? visibleCols.findIndex((c) => c.field === targetField)
        : -1;

      if (targetRowIdx < 0) return;

      const isOutsideRowRange =
        targetRowIdx > sourceEndRowIdx || targetRowIdx < sourceStartRowIdx;
      const isOutsideColRange =
        targetColIdx > sourceEndColIdx || targetColIdx < sourceStartColIdx;

      // Lock axis on first movement outside the source range (like Excel).
      // Once locked, ignore movement on the other axis to prevent diagonal fill.
      if (fillDirection === null) {
        if (isOutsideRowRange) {
          fillDirection = 'vertical';
        } else if (isOutsideColRange) {
          fillDirection = 'horizontal';
        }
      }

      const newTargetRowIds: GridRowId[] = [];
      let newTargetFields: string[] = [];

      if (fillDirection === 'vertical') {
        // Vertical fill: extend rows, keep all source columns
        newTargetFields = [...sourceFields];

        if (targetRowIdx > sourceEndRowIdx) {
          for (let i = sourceEndRowIdx + 1; i <= targetRowIdx; i++) {
            newTargetRowIds.push(sortedIds[i]);
          }
        } else if (targetRowIdx < sourceStartRowIdx) {
          for (let i = targetRowIdx; i < sourceStartRowIdx; i++) {
            newTargetRowIds.push(sortedIds[i]);
          }
        }
        // If pointer is back within source row range, newTargetRowIds stays empty
      } else if (fillDirection === 'horizontal') {
        // Horizontal fill: extend columns, keep source rows
        for (let i = sourceStartRowIdx; i <= sourceEndRowIdx; i++) {
          newTargetRowIds.push(sortedIds[i]);
        }

        if (targetColIdx > sourceEndColIdx) {
          for (let i = sourceEndColIdx + 1; i <= targetColIdx; i++) {
            newTargetFields.push(visibleCols[i].field);
          }
        } else if (targetColIdx < sourceStartColIdx) {
          for (let i = targetColIdx; i < sourceStartColIdx; i++) {
            newTargetFields.push(visibleCols[i].field);
          }
        }
        // If pointer is back within source col range, newTargetFields stays empty
      }

      currentTargetRowIds = newTargetRowIds;
      currentTargetFields = newTargetFields;

      // Apply preview decoration (rows × fields)
      const nextDecorated = new Set<HTMLElement>();

      for (let rowIdx = 0; rowIdx < newTargetRowIds.length; rowIdx++) {
        for (let colIdx = 0; colIdx < newTargetFields.length; colIdx++) {
          const el = getCellEl(
            newTargetRowIds[rowIdx],
            newTargetFields[colIdx]
          );
          if (!el) continue;

          el.classList.add('fill-preview');
          if (rowIdx === 0) el.classList.add('fill-preview-top');
          if (rowIdx === newTargetRowIds.length - 1)
            el.classList.add('fill-preview-bottom');
          if (colIdx === 0) el.classList.add('fill-preview-left');
          if (colIdx === newTargetFields.length - 1)
            el.classList.add('fill-preview-right');

          nextDecorated.add(el);
        }
      }

      // Remove classes from cells that left the target set
      for (const el of decoratedEls) {
        if (!nextDecorated.has(el)) {
          el.classList.remove(
            'fill-preview',
            'fill-preview-top',
            'fill-preview-bottom',
            'fill-preview-left',
            'fill-preview-right'
          );
        }
      }

      decoratedEls = nextDecorated;
    }

    // ── 4. Mouseup — apply the fill and extend the selection ────────

    function onMouseUp(): void {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      cancelAnimationFrame(rafId);

      if (
        isDragging &&
        currentTargetRowIds.length > 0 &&
        currentTargetFields.length > 0 &&
        fillDirection
      ) {
        const updates: Array<{ id: GridRowId; [field: string]: unknown }> = [];

        if (fillDirection === 'vertical') {
          // Each source field fills its own target rows independently
          for (const field of currentTargetFields) {
            if (!api.getColumn(field).editable) continue;
            const values = sourceValuesByField.get(field) ?? [];
            if (values.length === 0) continue;
            for (let i = 0; i < currentTargetRowIds.length; i++) {
              const id = currentTargetRowIds[i];
              const existing = updates.find((u) => u.id === id);
              if (existing) {
                existing[field] = values[i % values.length];
              } else {
                updates.push({ id, [field]: values[i % values.length] });
              }
            }
          }
        } else if (fillDirection === 'horizontal') {
          // Map source columns to target columns by position offset
          for (
            let colOffset = 0;
            colOffset < currentTargetFields.length;
            colOffset++
          ) {
            const targetField = currentTargetFields[colOffset];
            if (!api.getColumn(targetField).editable) continue;
            const sourceField = sourceFields[colOffset % sourceFields.length];
            const values = sourceValuesByField.get(sourceField) ?? [];
            if (values.length === 0) continue;
            for (
              let rowIdx = 0;
              rowIdx < currentTargetRowIds.length;
              rowIdx++
            ) {
              const id = currentTargetRowIds[rowIdx];
              const existing = updates.find((u) => u.id === id);
              if (existing) {
                existing[targetField] = values[rowIdx % values.length];
              } else {
                updates.push({
                  id,
                  [targetField]: values[rowIdx % values.length],
                });
              }
            }
          }
        }

        if (updates.length > 0) {
          api.updateRows(updates);
        }

        // Extend cell selection to include filled cells
        const model = { ...api.getCellSelectionModel() };
        for (const id of currentTargetRowIds) {
          if (!model[id]) model[id] = {};
          for (const field of currentTargetFields) {
            model[id][field] = true;
          }
        }
        api.setCellSelectionModel(model);
      }

      // Reset
      isDragging = false;
      sourceFields = [];
      sourceStartRowIdx = -1;
      sourceEndRowIdx = -1;
      sourceStartColIdx = -1;
      sourceEndColIdx = -1;
      sourceValuesByField = new Map();
      fillDirection = null;
      currentTargetRowIds = [];
      currentTargetFields = [];
      clearPreviewClasses();
    }

    // ── Cleanup on unmount ──────────────────────────────────────────

    return () => {
      unsubSelection();
      unsubFocusIn();
      unsubMouseDown();
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      cancelAnimationFrame(rafId);
      clearPreviewClasses();
    };
  }, [apiRef]);

  return { getCellClassName };
}

