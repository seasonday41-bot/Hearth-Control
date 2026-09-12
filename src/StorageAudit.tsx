import { useEffect, useMemo, useState } from 'react';
import './storage-audit.css';

type Classification = 'SAFE_ISH' | 'REVIEW' | 'KEEP' | 'PROTECTED_OR_UNKNOWN';
type AuditItem = {
  id: string; path: string; displayPath: string; name: string; kind: string;
  sizeBytes: number; fileCount: number; modifiedAt: string | null; incomplete: boolean;
  classification: Classification; riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
  recreatable: 'YES' | 'NO' | 'UNKNOWN'; activeUsage: 'YES' | 'NO' | 'UNKNOWN';
  reason: string; evidence: string[]; protected: boolean; revealable: boolean;
  whatIsThis: string; ifRemoved: string;
};
type AuditResult = { ok: boolean; error?: string; scannedAt?: string; disk?: { usedBytes: number | null; totalBytes: number | null }; items?: AuditItem[]; potentiallyReclaimableBytes?: number };

const labels: Record<Classification, string> = {
  SAFE_ISH: 'Safe-ish', REVIEW: 'Review', KEEP: 'Keep', PROTECTED_OR_UNKNOWN: 'Protected / Unknown',
};
const categories: Classification[] = ['SAFE_ISH', 'REVIEW', 'KEEP', 'PROTECTED_OR_UNKNOWN'];
const formatSize = (bytes: number | null | undefined) => {
  if (bytes === null || bytes === undefined) return 'Unavailable';
  if (bytes < 1024) return `${bytes} B`;
  const unit = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / (1024 ** unit)).toFixed(1)} ${['B', 'KB', 'MB', 'GB', 'TB', 'PB'][unit] || 'PB'}`;
};
const dateLabel = (date: string | null | undefined) => date ? new Date(date).toLocaleString() : 'Unknown';
const itemSizeLabel = (item: AuditItem) => item.incomplete ? 'Size unavailable' : formatSize(item.sizeBytes);

export default function StorageAudit() {
  const [result, setResult] = useState<AuditResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState('');
  const [filter, setFilter] = useState<Classification | 'ALL'>('ALL');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [revealError, setRevealError] = useState('');

  useEffect(() => window.controlApp.onStorageAuditProgress((event) => setProgress(`Scanning ${event.path}…`)), []);

  const items = result?.items || [];
  const visible = useMemo(() => items.filter((item) => filter === 'ALL' || item.classification === filter), [items, filter]);
  const selected = items.find((item) => item.id === selectedId) || null;
  const totals = useMemo(() => Object.fromEntries(categories.map((category) => [category, {
    bytes: items.filter((item) => item.classification === category && !item.incomplete).reduce((sum, item) => sum + item.sizeBytes, 0),
    partial: items.filter((item) => item.classification === category && item.incomplete).length,
  }])) as Record<Classification, { bytes: number; partial: number }>, [items]);
  const disk = result?.disk;
  const usageRatio = disk?.usedBytes != null && disk.totalBytes ? Math.min(100, Math.max(0, disk.usedBytes / disk.totalBytes * 100)) : 0;

  const scan = async () => {
    if (scanning) return;
    setScanning(true);
    setProgress('Preparing scan…');
    setSelectedId(null);
    try { setResult(await window.controlApp.storageAuditScan()); }
    catch (error: any) { setResult({ ok: false, error: error?.message || 'Storage scan failed.' }); }
    finally { setScanning(false); setProgress(''); }
  };

  const reveal = async () => {
    if (!selected) return;
    setRevealError('');
    const response = await window.controlApp.storageAuditReveal(selected.id);
    if (!response.ok) setRevealError(response.error || 'Could not reveal this item.');
  };

  return <div className="storage-audit-view">
    <header className="page-header">
      <div><p className="kicker">READ-ONLY MAC STORAGE</p><h1>Storage Audit.</h1><p className="intro">Understand known storage areas before deciding what to keep or review.</p></div>
      <button type="button" className="storage-scan-button" onClick={() => void scan()} disabled={scanning}>{scanning ? 'Scanning…' : 'Scan Storage'}</button>
    </header>

    <section className="storage-overview" aria-label="Mac storage overview">
      <div className="storage-overview-top"><div><span className="storage-eyebrow">MAC STORAGE</span><strong>{formatSize(disk?.usedBytes)} <span>/ {formatSize(disk?.totalBytes)}</span></strong></div><div><span className="storage-eyebrow">POTENTIALLY RECLAIMABLE</span><strong>{formatSize(result?.potentiallyReclaimableBytes)}</strong><small>Complete Safe-ish measurements only</small></div></div>
      <div className="storage-usage-track" role="progressbar" aria-valuenow={Math.round(usageRatio)} aria-valuemin={0} aria-valuemax={100} aria-label="Mac storage used"><span style={{ width: `${usageRatio}%` }} /></div>
      <div className="storage-category-summary">{categories.map((category) => <div key={category}><span>{labels[category]}</span><strong>{formatSize(totals[category].bytes)} measured</strong>{totals[category].partial > 0 && <small>+ {totals[category].partial} partial {totals[category].partial === 1 ? 'area' : 'areas'}</small>}</div>)}</div>
      <div className="storage-scan-meta"><span>Last scan: {dateLabel(result?.scannedAt)}</span><span>{scanning ? progress : 'No files are changed by this audit.'}</span></div>
    </section>

    {result?.error && <p className="storage-audit-error" role="alert">{result.error}</p>}
    <section className="storage-results" aria-label="Storage scan results">
      <div className="storage-filter-row"><span>KNOWN AREAS <strong>{items.length}</strong></span><div role="group" aria-label="Filter storage items"><button type="button" className={filter === 'ALL' ? 'selected' : ''} onClick={() => setFilter('ALL')}>All</button>{categories.map((category) => <button key={category} type="button" className={filter === category ? 'selected' : ''} onClick={() => setFilter(category)}>{labels[category]}</button>)}</div></div>
      {visible.length === 0 ? <div className="storage-empty">{scanning ? 'Scanning known locations…' : result?.ok ? 'No items in this category.' : 'Run a scan to inspect known storage areas.'}</div> :
        <div className="storage-list">{visible.map((item) => <button type="button" className="storage-item" key={item.id} onClick={() => { setSelectedId(item.id); setRevealError(''); }}><span className="storage-item-main"><strong>{item.name}</strong><small title={item.path}>{item.displayPath}</small></span><span className="storage-item-size">{itemSizeLabel(item)}{item.incomplete && <small>Partial measurement</small>}</span><span className={`storage-classification ${item.classification.toLowerCase()}`}>{labels[item.classification]}</span><span className="storage-item-date">{dateLabel(item.modifiedAt)}</span><span className="storage-item-reason">{item.reason}</span></button>)}</div>}
    </section>

    {selected && <div className="storage-drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedId(null); }}><aside className="storage-drawer" role="dialog" aria-modal="true" aria-label={`Storage details for ${selected.name}`}>
      <header><div><span>STORAGE DETAIL</span><h2>{selected.name}</h2></div><button type="button" onClick={() => setSelectedId(null)}>Close</button></header>
      <dl><div><dt>Path</dt><dd className="storage-detail-path">{selected.displayPath}</dd></div><div><dt>Measured size</dt><dd>{itemSizeLabel(selected)}{selected.incomplete ? ' · Partial measurement' : ''}</dd></div><div><dt>Classification</dt><dd>{labels[selected.classification]}</dd></div><div><dt>Risk to user data</dt><dd>{selected.riskLevel}</dd></div><div><dt>Re-creatable</dt><dd>{selected.recreatable}</dd></div><div><dt>Active usage</dt><dd>{selected.activeUsage}</dd></div><div><dt>Last modified</dt><dd>{dateLabel(selected.modifiedAt)}</dd></div></dl>
      <section><h3>What is this?</h3><p>{selected.whatIsThis}</p></section>
      <section><h3>Why is it large?</h3><p>{selected.fileCount.toLocaleString()} metadata entries measured{selected.incomplete ? '; measurement is incomplete due to access or scan limits.' : '.'}</p></section>
      <section><h3>If removed</h3><p>{selected.ifRemoved}</p></section>
      <section><h3>Evidence</h3><ul>{selected.evidence.map((entry) => <li key={entry}>{entry}</li>)}</ul></section>
      {revealError && <p className="storage-audit-error" role="alert">{revealError}</p>}
      <footer><button type="button" onClick={() => void reveal()} disabled={!selected.revealable}>Reveal in Finder</button><span>Read-only audit · no cleanup action</span></footer>
    </aside></div>}
  </div>;
}
