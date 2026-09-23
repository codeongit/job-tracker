import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReceipt, receiptCounts } from './receipt.mjs';
const candidate = (label, css, visible = true) => ({
  label,
  classes: ['message-status', css],
  visible,
});

test('observed label and class agree on read versus delivered', () => {
  assert.deepEqual(parseReceipt([candidate('[已读]', 'status-read')]), {
    status: 'read',
    label: '[已读]',
    source: 'list_receipt_label',
  });
  assert.equal(parseReceipt([candidate('[送达]', 'status-delivery')]).status, 'delivered');
});
test('missing, hidden, conflicting, ambiguous, or unfamiliar receipts stay unknown', () => {
  const cases = [
    [],
    [candidate('[已读]', 'status-read', false)],
    [candidate('[已读]', 'status-delivery')],
    [candidate('对方已经已读', 'status-read')],
    [candidate('[未读]', 'status-unread')],
    [candidate('[已读]', 'status-read'), candidate('[送达]', 'status-delivery')],
    [{ label: '[已读]', classes: ['status-read', 'status-delivery'], visible: true }],
  ];
  for (const value of cases)
    assert.deepEqual(parseReceipt(value), { status: 'unknown', label: null, source: null });
});
test('summary counts current receipts and treats legacy records as unknown', () => {
  assert.deepEqual(
    receiptCounts([
      { outgoingReceipt: { status: 'read' } },
      { outgoingReceipt: { status: 'delivered' } },
      {},
    ]),
    { read: 1, delivered: 1, unread: 0, unknown: 1 },
  );
});
