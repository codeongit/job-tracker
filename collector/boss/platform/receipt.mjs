// Only independent, rendered list receipt labels qualify. Never scan message
// prose for these words, and never infer "unread" from a missing receipt.
export function parseReceipt(candidates) {
  const unknown = { status: 'unknown', label: null, source: null };
  if (!Array.isArray(candidates) || candidates.length !== 1) return unknown;
  const candidate = candidates[0];
  if (!candidate || candidate.visible !== true || !Array.isArray(candidate.classes)) return unknown;
  const knownClasses = candidate.classes.filter((value) =>
    ['status-read', 'status-delivery'].includes(value),
  );
  if (knownClasses.length !== 1) return unknown;
  const matches = [
    { label: '[已读]', css: 'status-read', status: 'read' },
    { label: '[送达]', css: 'status-delivery', status: 'delivered' },
  ];
  const found = matches.find(
    (value) => value.label === candidate.label && value.css === knownClasses[0],
  );
  return found
    ? { status: found.status, label: found.label, source: 'list_receipt_label' }
    : unknown;
}

export function receiptCounts(records) {
  const counts = { read: 0, delivered: 0, unread: 0, unknown: 0 };
  for (const row of records) {
    const status = row.outgoingReceipt?.status ?? 'unknown';
    if (!Object.hasOwn(counts, status)) throw new Error('RECEIPT_STATUS_INVALID');
    counts[status] += 1;
  }
  return counts;
}
