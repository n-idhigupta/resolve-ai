import { Link, useNavigate } from 'react-router';
import { AgGridReact } from 'ag-grid-react';
import {
  themeQuartz,
  type ColDef,
  type ICellRendererParams,
} from 'ag-grid-community';
export type MerchantCaseRow = {
  id: string;
  title: string;
  status: string;
  reason: string;
  orderId: string;
  createdAt: string;
  aiReview?: { status: string; stale: boolean; revoked: boolean } | null;
};
const words = (v: string) => v.replaceAll('_', ' ').toLowerCase();
export function CaseStatusCell({
  value,
}: ICellRendererParams<MerchantCaseRow, string>) {
  const state = value ?? 'UNKNOWN';
  const color =
    state === 'RESOLVED'
      ? 'bg-emerald-100 text-emerald-900'
      : state === 'ESCALATED'
        ? 'bg-red-100 text-red-900'
        : state === 'CLOSED_WITHOUT_AGREEMENT'
          ? 'bg-slate-100 text-slate-800'
          : 'bg-blue-100 text-blue-900';
  return (
    <span className={'rounded-full px-2 py-1 text-xs font-medium ' + color}>
      {words(state)}
    </span>
  );
}
export function AIRiskCell({ data }: ICellRendererParams<MerchantCaseRow>) {
  const ai = data?.aiReview;
  const warning =
    ai?.stale ||
    ai?.revoked ||
    ['NEEDS_REVIEW', 'FAILED', 'STALE'].includes(ai?.status ?? '');
  const text = !ai
    ? 'No analysis'
    : ai.revoked
      ? 'Consent revoked'
      : ai.stale || ai.status === 'STALE'
        ? 'Stale - reanalyse'
        : ai.status === 'NEEDS_REVIEW'
          ? 'Human review required'
          : ai.status === 'FAILED'
            ? 'Analysis failed'
            : ['QUEUED', 'RUNNING'].includes(ai.status)
              ? 'Analysis processing'
              : 'Analysis ready';
  return (
    <span
      title="Recorded analysis state, not a model risk score or financial authorization"
      className={
        'rounded-full px-2 py-1 text-xs font-medium ' +
        (warning
          ? 'bg-amber-100 text-amber-950'
          : 'bg-slate-100 text-slate-700')
      }
    >
      {text}
    </span>
  );
}
export function MerchantCasesGrid({
  rows,
  loading,
  merchantId,
}: {
  rows: MerchantCaseRow[];
  loading: boolean;
  merchantId: string;
}) {
  const navigate = useNavigate(),
    path = (id: string) => `/merchant/${merchantId}/cases/${id}`;
  const columns: ColDef<MerchantCaseRow>[] = [
    {
      field: 'title',
      headerName: 'Complaint',
      minWidth: 260,
      flex: 2,
      cellRenderer: ({ data }: ICellRendererParams<MerchantCaseRow>) =>
        data ? (
          <Link
            className="font-medium text-teal-800 underline"
            to={path(data.id)}
          >
            {data.title}
          </Link>
        ) : null,
    },
    {
      field: 'status',
      headerName: 'Status',
      minWidth: 180,
      cellRenderer: CaseStatusCell,
    },
    {
      colId: 'aiReview',
      headerName: 'AI review / risk',
      minWidth: 200,
      valueGetter: ({ data }) =>
        !data?.aiReview
          ? 'No analysis'
          : data.aiReview.revoked
            ? 'Consent revoked'
            : data.aiReview.stale
              ? 'Stale'
              : words(data.aiReview.status),
      cellRenderer: AIRiskCell,
    },
    {
      field: 'reason',
      headerName: 'Category',
      minWidth: 180,
      valueFormatter: (p) => words(p.value ?? ''),
    },
    { field: 'orderId', headerName: 'Order', minWidth: 290 },
    {
      field: 'createdAt',
      headerName: 'Opened',
      minWidth: 190,
      valueFormatter: (p) => new Date(p.value).toLocaleString(),
    },
  ];
  return (
    <section
      aria-label="Merchant complaints grid"
      className="min-w-0"
      data-testid="merchant-case-grid"
    >
      <p className="my-3 text-sm text-slate-600">
        AG Grid Community. Sort and filter this loaded server page below; use
        the filters above to search across cases. AI indicators require human
        review and never authorize money.
      </p>
      <div className="h-[560px] min-w-0 w-full">
        <AgGridReact<MerchantCaseRow>
          theme={themeQuartz}
          rowData={rows}
          loading={loading}
          columnDefs={columns}
          defaultColDef={{
            sortable: true,
            filter: 'agTextColumnFilter',
            floatingFilter: true,
            resizable: true,
            flex: 1,
          }}
          pagination
          paginationPageSize={10}
          paginationPageSizeSelector={[10, 25]}
          getRowId={(p) => p.data.id}
          rowHeight={48}
          headerHeight={44}
          enableCellTextSelection
          noRowsOverlayComponent={() => (
            <span>No matching complaints in this server page.</span>
          )}
          loadingOverlayComponent={() => (
            <span role="status">Loading merchant complaints...</span>
          )}
          onFilterChanged={(e) => {
            if (e.api.getDisplayedRowCount() === 0) e.api.showNoRowsOverlay();
            else e.api.hideOverlay();
          }}
          onRowClicked={(e) => {
            if (
              e.data &&
              !(
                e.event?.target instanceof Element &&
                e.event.target.closest('a,button')
              )
            )
              void navigate(path(e.data.id));
          }}
          onCellKeyDown={(e) => {
            if (
              e.event instanceof KeyboardEvent &&
              e.event.key === 'Enter' &&
              e.data &&
              !(
                e.event.target instanceof Element &&
                e.event.target.closest('a,button')
              )
            )
              void navigate(path(e.data.id));
          }}
        />
      </div>
    </section>
  );
}
