import type { ReactNode } from 'react';

/** A keyboard-accessible table header whose state mirrors server-side sorting. */
export default function SortableHeader({ label, active, direction, onSort }: { label: ReactNode; active: boolean; direction: 'asc' | 'desc'; onSort: () => void }) {
  return <th aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
    <button className="table-sort-button" type="button" onClick={onSort}>{label}<span aria-hidden="true">{active ? (direction === 'asc' ? ' ▲' : ' ▼') : ''}</span></button>
  </th>;
}
