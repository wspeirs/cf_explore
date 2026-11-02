import type { D1Database, TableInfo, TreeNode, IconName, QueryOutcome } from './types';
import { quoteIdent } from './state';

export interface GridColumn {
  prop: string;
  name: string;
  size: number;
  minSize: number;
  sortable: boolean;
  cellProperties: (args: { model?: Record<string, unknown> | null; prop: string | number }) => {
    class?: { 'cell-null': boolean };
  };
}

export function buildD1TreeRows(
  databases: D1Database[],
  schemas: Map<string, TableInfo[]>,
  expanded: Set<string>,
  loading: Set<string>
): TreeNode[] {
  const rows: TreeNode[] = [];

  const isRootExpanded = expanded.has('root');
  rows.push({
    id: 'root',
    label: 'D1 Databases',
    icon: 'database',
    depth: 0,
    expandable: true,
    expanded: isRootExpanded,
    loading: loading.has('root'),
  });

  if (!isRootExpanded) {
    return rows;
  }

  for (const db of databases) {
    const dbNodeId = 'db:' + db.uuid;
    const isDbExpanded = expanded.has(dbNodeId);
    rows.push({
      id: dbNodeId,
      label: db.name,
      icon: 'database',
      depth: 1,
      expandable: true,
      expanded: isDbExpanded,
      loading: loading.has(dbNodeId),
      data: { dbId: db.uuid },
    });

    if (isDbExpanded && schemas.has(db.uuid)) {
      const tables = schemas.get(db.uuid) || [];
      for (const t of tables) {
        const tblNodeId = 'tbl:' + db.uuid + ':' + t.name;
        const isTblExpanded = expanded.has(tblNodeId);
        const hasCols = Boolean(t.columns && t.columns.length > 0);
        rows.push({
          id: tblNodeId,
          label: t.name,
          icon: (t.kind === 'view' ? 'view' : 'table') as IconName,
          depth: 2,
          expandable: hasCols,
          expanded: isTblExpanded,
          loading: false,
          data: { dbId: db.uuid, table: t.name },
        });

        if (isTblExpanded && hasCols) {
          for (const col of t.columns) {
            const colNodeId = 'col:' + db.uuid + ':' + t.name + ':' + col.name;
            rows.push({
              id: colNodeId,
              label: `${col.name} ${col.col_type}${col.pk ? ' (PK)' : ''}`,
              icon: 'column',
              depth: 3,
              expandable: false,
              expanded: false,
              loading: false,
              data: { dbId: db.uuid },
            });
          }
        }
      }
    }
  }

  return rows;
}

export function formatQueryStatus(o: QueryOutcome): string {
  let msg = '';
  if (o.statement_count > 1 && o.result_statement) {
    msg += `Showing result of statement ${o.result_statement} of ${o.statement_count} · `;
  }
  if (o.columns.length > 0) {
    msg += `${o.rows.length} row(s)${o.limit_applied ? ' (auto LIMIT 1000)' : ''} · read ${o.rows_read} · written ${o.rows_written} · ${o.duration_ms.toFixed(1)} ms`;
  } else {
    msg += `Executed ${o.statement_count} statement(s) · ${o.changes} row(s) changed · read ${o.rows_read} · written ${o.rows_written} · ${o.duration_ms.toFixed(1)} ms`;
  }
  return msg;
}

export function selectTableSql(table: string): string {
  return `SELECT * FROM ${quoteIdent(table)} LIMIT 100;`;
}

export function pickRunText(value: string, selStart: number, selEnd: number): string {
  if (selStart !== selEnd) {
    return value.slice(selStart, selEnd);
  }
  return value;
}

export function refreshTargetDbId(selectedId: string): string | null {
  if (!selectedId || selectedId === 'root') {
    return null;
  }
  const parts = selectedId.split(':');
  if (parts.length >= 2 && (parts[0] === 'db' || parts[0] === 'tbl' || parts[0] === 'col')) {
    return parts[1];
  }
  return null;
}

export function toGridColumns(cols: string[]): GridColumn[] {
  return (cols || []).map((name, i) => ({
    prop: 'c' + i,
    name,
    size: 150,
    minSize: 50,
    sortable: true,
    cellProperties: ({ model, prop }: { model?: Record<string, unknown> | null; prop: string | number }) =>
      model && model[prop] === null ? { class: { 'cell-null': true } } : {},
  }));
}

export function toGridSource(rows: unknown[][]): Record<string, unknown>[] {
  return (rows || []).map((r) =>
    Object.fromEntries(r.map((v, i) => ['c' + i, v]))
  );
}
