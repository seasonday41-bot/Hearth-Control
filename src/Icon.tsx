import type { ReactNode } from 'react';

export type IconName = 'grid' | 'folder' | 'lock' | 'terminal' | 'moon' | 'sun' | 'chevron' | 'activity' | 'copy' | 'server' | 'console' | 'radio' | 'flag' | 'check' | 'plus';

export default ({ name }: { name: IconName }) => {
  const paths: Record<IconName, ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
    folder: <path d="M3.5 6.5h6l2-2h9a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-17a2 2 0 0 1-2-2v-10a2 2 0 0 1 2-2Z"/>,
    lock: <><rect x="4" y="10" width="16" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
    terminal: <><path d="m5 8 4 4-4 4"/><path d="M12 17h6"/></>,
    moon: <path d="M20.5 15.6A8.6 8.6 0 0 1 8.4 3.5 8.7 8.7 0 1 0 20.5 15.6Z"/>,
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></>,
    chevron: <path d="m9 18 6-6-6-6"/>,
    activity: <path d="M3 12h4l2.2-7 4.3 14 2.3-7H21"/>,
    copy: <><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></>,
    server: <><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/></>,
    console: <><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></>,
    radio: <><path d="M4.93 19.07A10 10 0 0 1 2 12a10 10 0 0 1 2.93-7.07"/><path d="M19.07 4.93A10 10 0 0 1 22 12a10 10 0 0 1-2.93 7.07"/><path d="M7.76 16.24A6 6 0 0 1 6 12a6 6 0 0 1 1.76-4.24"/><path d="M16.24 7.76A6 6 0 0 1 18 12a6 6 0 0 1-1.76 4.24"/><circle cx="12" cy="12" r="2"/></>,
    flag: <><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></>,
    check: <polyline points="20 6 9 17 4 12"/>,
    plus: <><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
};
