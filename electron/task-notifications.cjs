const TERMINAL = new Set(['waiting', 'done', 'error']);
const sanitize = (value, fallback = 'No additional details.') => {
  const text = String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/(?:token|secret|password|authorization|session)\s*[:=]\s*\S+/gi, '[redacted]').replace(/\s+/g, ' ').trim();
  return (text || fallback).slice(0, 180);
};
const notificationFor = (task, status) => {
  const title = sanitize(task.title, 'Hearth task').slice(0, 96);
  // Never use lastAnswer here: it can contain an agent's raw response. Native
  // notifications receive only the trusted task title plus a bounded summary
  // or reason selected after Hearth has performed a state transition.
  const summary = status === 'waiting' ? task.completion?.interimReason || task.completion?.summary : status === 'error' ? task.error || task.completion?.error || task.completion?.summary : task.completion?.summary;
  const label = status === 'waiting' ? 'Hearth — Task waiting' : status === 'error' ? 'Hearth — Task failed' : 'Hearth — Task completed';
  return { title: label, body: `${title} — ${sanitize(summary)}` };
};
const createTaskNotifier = ({ Notification, app }) => {
  const seen = new Set();
  const notify = (task) => {
    const status = task?.status;
    if (!TERMINAL.has(status) || !task?.taskId) return false;
    const key = `${task.taskId}:${status}`;
    if (seen.has(key)) return false;
    seen.add(key);
    try { if (Notification?.isSupported?.()) new Notification(notificationFor(task, status)).show(); } catch { /* best effort */ }
    return true;
  };
  const setDockBadge = (status) => { try { app?.dock?.setBadge?.(status === 'running' || status === 'starting' ? '•' : status === 'waiting' || status === 'error' ? '!' : ''); } catch { /* optional */ } };
  return { notify, setDockBadge, notificationFor };
};
module.exports = { sanitize, notificationFor, createTaskNotifier };
