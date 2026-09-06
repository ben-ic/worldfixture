"""Source checks and exact field reversal for the reviewed finance migration.

This module never calls the compiler's finance or provider transforms. The
record names exact edits, not replacement artifact files. All other bytes must
still reproduce the previous mail, operator, calendar, and original baselines.
"""
from __future__ import annotations

import calendar
import copy
import json
import re
from datetime import UTC, date, datetime
from pathlib import Path

from worldfixture_compiler.compiler import canonical_json, sha256

ROOT = Path(__file__).resolve().parents[2]
FINANCE_MIGRATION = json.loads((Path(__file__).parent / 'coupling-finance-migration.json').read_text())
ALLOWED_ROOTS = {
    'world.json': {'finance', 'commerce', 'communication', 'clock', 'timeline'},
    'packs/finance.json': {'customers', 'invoices', 'payments', 'refunds', 'ledger_entries'},
    'packs/commerce.json': {'orders'}, 'packs/communication.json': {'mail', 'mailboxes', 'resolved_mail'},
    'projections/stripe.json': {'customers', 'invoices', 'transactions'},
    'projections/emulator-overlay.json': {'stripe', 'google', 'resend'},
    'projections/google.json': {'messages', 'labels'}, 'projections/mail.json': {'messages'},
    'projections/model.json': {'facts'}, 'projections/http-targets.json': {'metrics'},
    'projections/resend.json': {'contacts'}, 'projections/agent.json': {'timeline'},
    'timeline.json': None,
}


def digest(data: bytes) -> dict:
    return {'sha256': sha256(data), 'size': len(data)}


def finance_record(world_id: str, version: str) -> dict:
    matches = [row for row in FINANCE_MIGRATION['worlds'] if (row['id'], row['version']) == (world_id, version)]
    assert len(matches) == 1, 'Each identity needs one reviewed finance migration'
    return matches[0]


def source_bytes(record: dict, source_root: Path = ROOT) -> dict[str, bytes]:
    from tests.parity.p4_migration import historical_source_bytes
    return historical_source_bytes(record['id'], record['version'], source_root)


def reverse_source_edits(record: dict, current: dict[str, bytes]) -> dict[str, bytes]:
    """Undo only exact source insertions/replacements; callers prove full hashes."""
    before = dict(current)
    for name in record['added_source_files']:
        assert digest(before.pop(name)) == record['source_files']['to'][name]
    for name, edits in record['source_edits'].items():
        data = before[name]
        for edit in reversed(edits):
            offset, added = edit['after_offset'], edit['after'].encode()
            assert data[offset:offset + len(added)] == added, f'Exact source edit absent: {name}'
            data = data[:offset] + edit['before'].encode() + data[offset + len(added):]
        before[name] = data
    return before


def finance_source_evidence(record: dict, source_root: Path = ROOT) -> dict:
    current = source_bytes(record, source_root)
    assert {name: digest(data) for name, data in current.items()} == record['source_files']['to'], 'Current finance source bytes changed'
    before = reverse_source_edits(record, current)
    assert {name: digest(data) for name, data in before.items()} == record['source_files']['from'], 'Original source bytes not reproduced'
    for label, files in [('from', before), ('to', current)]:
        document = json.loads(files[Path(record['source']).name])
        assert set(files) == {Path(record['source']).name, *document['fragments']}
        assert len(document['fragments']) == len(set(document['fragments']))
        assert (document['world']['id'], document['world']['version']) == (record['id'], record['version'])
        assert sha256(canonical_json({name: digest(data) for name, data in files.items()})) == record[f'{label}_source_sha256']
    return {'before_bytes': before, 'after_bytes': current}


def write_pre_finance_sources(record: dict, source_root: Path) -> None:
    evidence = finance_source_evidence(record, source_root)
    directory = source_root / Path(record['source']).parent
    for name, data in evidence['before_bytes'].items():
        (directory / name).write_bytes(data)
    for name in record['added_source_files']:
        (directory / name).unlink()


def merge_source(files: dict[str, bytes], name: str = 'world.json') -> dict:
    """Read the manifest/fragment contract without compiler validation/transforms."""
    def merge(left, right):
        if isinstance(left, dict) and isinstance(right, dict):
            return {key: merge(left[key], right[key]) if key in left and key in right
                    else copy.deepcopy(left[key] if key in left else right[key]) for key in left.keys() | right.keys()}
        if isinstance(left, list) and isinstance(right, list):
            return copy.deepcopy(left + right)
        assert left == right, 'Conflicting source declarations'
        return copy.deepcopy(left)
    manifest = json.loads(files[name])
    world = {**manifest['world'], 'api_version': 'worldfixture.world-source/v1'}
    for relative in manifest['fragments']:
        fragment = json.loads(files[relative])
        assert fragment['api_version'] == 'worldfixture.world-fragment/v1'
        world = merge(world, fragment['contributes'])
    world['timeline'] = sorted(world.get('timeline', []), key=lambda row: (row.get('after_seconds', -1), row.get('id', '')))
    return world


def _key(container, selector):
    if not isinstance(selector, dict):
        return selector
    matches = [index for index, row in enumerate(container) if all(row.get(key) == value for key, value in selector.items())]
    assert len(matches) == 1, f'Changed record missing or duplicated: {selector}'
    return matches[0]


def _at(document, path):
    for selector in path:
        document = document[_key(document, selector)]
    return document


def expanded_edits(edits):
    for edit in edits:
        if edit['kind'] != 'group':
            yield edit
            continue
        for values in edit['values']:
            yield {**edit['edit'], 'path': [*edit['prefix'], dict(zip(edit['keys'], values, strict=True)), *edit['suffix']]}


def reverse_json_edits(document, edits):
    edits = list(expanded_edits(edits))
    restored = copy.deepcopy(document)
    for edit in edits:
        if edit['kind'] == 'order':
            current = [[row[key] for key in edit['keys']] for row in _at(restored, edit['path'])]
            assert digest(canonical_json(current)) == edit['after'], 'Changed list order drifted'
    for edit in edits:
        path, kind = edit['path'], edit['kind']
        if kind == 'order':
            rows = _at(restored, path)
            keys = edit['keys']
            lookup = {tuple(row[key] for key in keys): row for row in rows}
            assert len(lookup) == len(rows)
            assert set(lookup) == {tuple(values) for values in edit['before']}
            rows[:] = [lookup[tuple(values)] for values in edit['before']]
            continue
        parent = _at(restored, path[:-1])
        if kind == 'removed':
            if isinstance(parent, list):
                assert not any(all(row.get(key) == value for key, value in path[-1].items()) for row in parent)
                parent.append(copy.deepcopy(edit['before']))
                continue
            assert path[-1] not in parent
            parent[path[-1]] = copy.deepcopy(edit['before'])
            continue
        key = _key(parent, path[-1])
        assert digest(canonical_json(parent[key])) == edit['after'], f'Changed value drifted: {path}'
        if kind == 'added':
            if isinstance(parent, list):
                parent.pop(key)
            else:
                del parent[key]
        else:
            assert kind == 'changed'
            parent[key] = copy.deepcopy(edit['before'])
    return restored


def reverse_finance_projection_changes(files: dict[str, bytes]) -> dict[str, bytes]:
    world = json.loads(files['world.json'])
    record = finance_record(world['id'], world['version'])
    restored = dict(files)
    for name, edits in record['json_edits'].items():
        assert name in ALLOWED_ROOTS
        for edit in expanded_edits(edits):
            assert edit['path'], 'Whole artifact replacements are forbidden'
            assert ALLOWED_ROOTS[name] is None or edit['path'][0] in ALLOWED_ROOTS[name], f'Unrelated migration path: {name} {edit["path"]}'
        restored[name] = canonical_json(reverse_json_edits(json.loads(files[name]), edits))
    return restored


def reverse_finance_migration(files: dict[str, bytes], source_root: Path = ROOT) -> dict[str, bytes]:
    world = json.loads(files['world.json'])
    record = finance_record(world['id'], world['version'])
    evidence = finance_source_evidence(record, source_root)
    restored = reverse_finance_projection_changes(files)
    manifest = json.loads(files['manifest.json'])
    manifest['source_files'] = {name: digest(data) for name, data in evidence['before_bytes'].items()}
    manifest['source_sha256'] = sha256(canonical_json(manifest['source_files']))
    manifest['files'] = {name: digest(data) for name, data in restored.items() if name != 'manifest.json'}
    manifest['artifact_sha256'] = sha256(canonical_json(manifest['files']))
    restored['manifest.json'] = canonical_json(manifest)
    return restored


def expected_finance(source: dict) -> dict:
    """Derive history, authored overrides, and each ledger pair from source."""
    finance = source['finance']
    customers = {row['id']: row for row in finance['customers']}
    anchor = date.fromisoformat(source['clock']['anchor'][:10])
    invoices = copy.deepcopy(finance['anchor_invoices'])
    bills, payments = [], []
    overridden = {row.get('invoice_id') for row in finance.get('payments', [])}
    for offset in range(finance['history_months'], 0, -1):
        absolute = anchor.year * 12 + anchor.month - 1 - offset
        year, month = absolute // 12, absolute % 12 + 1
        next_year, next_month = (absolute + 1) // 12, (absolute + 1) % 12 + 1
        def day(y, m, value):
            return date(y, m, min(value, calendar.monthrange(y, m)[1])).isoformat()
        for customer in customers.values():
            if customer.get('billing_mode', 'recurring_monthly') == 'one_time':
                continue
            invoice_id = f'inv-{year:04}{month:02}-{customer["id"]}'
            if any(row['id'] == invoice_id for row in finance['anchor_invoices']):
                continue
            invoice = {'id': invoice_id, 'number': f'{year % 100:02}{month:02}-{customer["number_suffix"]}',
                       'customer_id': customer['id'], 'issued_on': day(year, month, customer.get('invoice_day', 5)),
                       'due_on': day(next_year, next_month, customer.get('due_day', 5)), 'amount_cents': customer['monthly_amount_cents'],
                       'currency': customer.get('currency', finance['currency']).upper(), 'status': 'paid', 'description': customer['service']}
            invoices.append(invoice)
            if invoice_id not in overridden:
                payments.append({'id': f'pay-{invoice_id}', 'invoice_id': invoice_id, 'customer_id': customer['id'],
                                 'paid_on': invoice['due_on'], 'amount_cents': invoice['amount_cents'], 'currency': invoice['currency']})
        for supplier in finance['suppliers']:
            bills.append({'id': f'bill-{year:04}{month:02}-{supplier["id"]}', 'supplier_id': supplier['id'],
                          'issued_on': day(year, month, supplier.get('bill_day', 12)), 'amount_cents': supplier['monthly_amount_cents'],
                          'currency': supplier.get('currency', finance['currency']).upper(), 'status': 'paid', 'description': supplier['service']})
    for invoice in invoices:
        invoice['currency'] = invoice.get('currency', customers[invoice['customer_id']].get('currency', finance['currency'])).upper()
    invoice_map = {row['id']: row for row in invoices}
    for original in finance.get('payments', []):
        payment = copy.deepcopy(original)
        invoice = invoice_map.get(payment.get('invoice_id'))
        payment['currency'] = payment.get('currency', invoice['currency'] if invoice else customers[payment['customer_id']].get('currency', finance['currency'])).upper()
        if invoice and 'order_id' in invoice:
            payment.setdefault('order_id', invoice['order_id'])
        payments.append(payment)
    payment_map = {row['id']: row for row in payments}
    refunds = copy.deepcopy(finance.get('refunds', []))
    for refund in refunds:
        refund['currency'] = refund.get('currency', payment_map[refund['payment_id']]['currency']).upper()
    entries = []
    def revenue(record):
        return record.get('revenue_account', customers[record['customer_id']].get('revenue_account', 'subscription-revenue'))
    def pair(record, day, debit, credit):
        suffixes = {'accounts-receivable': 'receivable', 'operating-cash': 'cash', 'operating-expense': 'expense'}
        for account, side in [(debit, 'debit'), (credit, 'credit')]:
            entries.append({'id': f'entry-{record["id"]}-{suffixes.get(account, "revenue")}', 'record_id': record['id'],
                            'date': day, 'account': account, 'currency': record['currency'],
                            'debit_cents': record['amount_cents'] if side == 'debit' else 0,
                            'credit_cents': record['amount_cents'] if side == 'credit' else 0})
    for invoice in invoices:
        if invoice['status'] not in {'draft', 'void', 'cancelled'}:
            pair(invoice, invoice['issued_on'], 'accounts-receivable', revenue(invoice))
    for payment in payments:
        pair(payment, payment['paid_on'], 'operating-cash', 'accounts-receivable' if payment.get('invoice_id') else revenue(payment))
    for bill in bills:
        pair(bill, bill['issued_on'], 'operating-expense', 'operating-cash')
    for refund in refunds:
        payment = payment_map[refund['payment_id']]
        pair(refund, refund['refunded_on'], revenue(invoice_map[payment['invoice_id']] if payment.get('invoice_id') else payment), 'operating-cash')
    return {key: sorted(rows, key=lambda row: (row[day_key], row['id'])) for key, rows, day_key in [
        ('invoices', invoices, 'issued_on'), ('bills', bills, 'issued_on'), ('payments', payments, 'paid_on'),
        ('refunds', refunds, 'refunded_on'), ('ledger_entries', entries, 'date')]}


def expected_stripe(source: dict, resolved: dict) -> dict:
    def identity(prefix, value):
        return prefix + '_' + re.sub('[^a-zA-Z0-9]', '_', value)
    def seconds(day):
        return int(datetime.fromisoformat(day).replace(tzinfo=UTC).timestamp())
    invoices, payments, refunds = [], [], []
    for invoice in resolved['invoices']:
        metadata = {'worldfixture_invoice_id': invoice['id'], 'worldfixture_status': invoice['status']}
        if 'order_id' in invoice:
            metadata['worldfixture_order_id'] = invoice['order_id']
        invoices.append({'id': identity('in', invoice['id']), 'number': invoice['number'], 'customer': identity('cus', invoice['customer_id']),
                         'description': invoice['description'], 'currency': invoice['currency'].lower(),
                         'status': 'open' if invoice['status'] == 'overdue' else invoice['status'], 'created': seconds(invoice['issued_on']),
                         'due_date': seconds(invoice['due_on']), 'amount_due': invoice['amount_cents'], 'metadata': metadata})
    for payment in resolved['payments']:
        metadata = {f'worldfixture_{key}': payment[key] for key in ('customer_id', 'invoice_id', 'order_id') if key in payment}
        metadata['worldfixture_payment_id'] = payment['id']
        row = {'id': identity('pi', payment['id']), 'charge': identity('ch', payment['id']), 'customer': identity('cus', payment['customer_id']),
               'amount': payment['amount_cents'], 'currency': payment['currency'].lower(), 'created': seconds(payment['paid_on']), 'metadata': metadata}
        if 'invoice_id' in payment:
            row.update(invoice=identity('in', payment['invoice_id']), invoice_payment=identity('inpay', payment['id']))
        payments.append(row)
    for refund in resolved['refunds']:
        refunds.append({'id': identity('re', refund['id']), 'payment_intent': identity('pi', refund['payment_id']),
                        'amount': refund['amount_cents'], 'currency': refund['currency'].lower(), 'created': seconds(refund['refunded_on']),
                        'metadata': {'worldfixture_refund_id': refund['id'], 'worldfixture_payment_id': refund['payment_id']}})
    return {'invoices': invoices, 'transactions': {'payments': payments, 'refunds': refunds}}


def assert_finance_semantics(case, files: dict[str, bytes], source_root: Path = ROOT) -> None:
    world = json.loads(files['world.json'])
    record = finance_record(world['id'], world['version'])
    evidence = finance_source_evidence(record, source_root)
    source = merge_source(evidence['after_bytes'])
    actual_source = copy.deepcopy(world)
    actual_source['finance'].pop('resolved')
    actual_source['communication'].pop('resolved_mail')
    case.assertEqual(source, actual_source, 'Compiled source must retain each declaration')
    expected = expected_finance(source)
    case.assertEqual(expected, world['finance']['resolved'], 'Finance expectations come from source, including every override and refund')
    pack = json.loads(files['packs/finance.json'])
    for key, rows in expected.items():
        case.assertEqual(rows, pack[key], f'Finance pack {key}')
    stripe = json.loads(files['projections/stripe.json'])
    for key, value in expected_stripe(source, expected).items():
        case.assertEqual(value, stripe[key], f'Stripe {key}')
    overlay = json.loads(files['projections/emulator-overlay.json'])['stripe']
    expected_overlay = copy.deepcopy(stripe)
    for collection in ('products', 'prices'):
        for row in expected_overlay[collection]:
            row.pop('worldfixture_product_id', None)
    case.assertEqual(expected_overlay, overlay, 'The normal seed receives every Stripe transaction')
    recurring = {row['id'] for row in source['finance']['customers'] if row.get('billing_mode', 'recurring_monthly') == 'recurring_monthly'}
    case.assertEqual(recurring, {row['worldfixture_customer_id'] for row in stripe['prices'] if 'worldfixture_customer_id' in row})
    case.assertEqual(recurring, {row['metadata']['worldfixture_customer_id'] for row in stripe['subscriptions']})
    for payment in expected['payments']:
        case.assertLessEqual(payment['paid_on'], source['clock']['anchor'][:10], payment['id'])
        origin = next((row for row in expected['invoices'] if row['id'] == payment.get('invoice_id')), None)
        if origin:
            case.assertEqual(origin['customer_id'], payment['customer_id'])
            case.assertEqual(origin['currency'], payment['currency'])
            case.assertGreaterEqual(payment['paid_on'], origin['issued_on'])
    for invoice in expected['invoices']:
        paid = sum(row['amount_cents'] for row in expected['payments'] if row.get('invoice_id') == invoice['id'])
        if invoice['status'] == 'paid':
            case.assertEqual(invoice['amount_cents'], paid, invoice['id'])
        else:
            case.assertLess(paid, invoice['amount_cents'], invoice['id'])
    for payment in expected['payments']:
        refunds = [row for row in expected['refunds'] if row['payment_id'] == payment['id']]
        case.assertLessEqual(sum(row['amount_cents'] for row in refunds), payment['amount_cents'])
        for refund in refunds:
            case.assertEqual(payment['currency'], refund['currency'])
            case.assertGreaterEqual(refund['refunded_on'], payment['paid_on'])
            case.assertLessEqual(refund['refunded_on'], source['clock']['anchor'][:10])
    for order in source.get('commerce', {}).get('orders', []):
        if 'payment_status' not in order:
            continue
        payments = [row for row in expected['payments'] if row.get('order_id') == order['id']]
        total = sum(row['amount_cents'] for row in payments)
        refunds = sum(row['amount_cents'] for row in expected['refunds'] if row['payment_id'] in {payment['id'] for payment in payments})
        if order['payment_status'] in {'unpaid', 'cancelled'}:
            case.assertEqual(0, total)
        else:
            case.assertEqual(order['total_cents'], total)
            if order['payment_status'] == 'partially_refunded':
                case.assertTrue(0 < refunds < total)
            else:
                case.assertEqual(total if order['payment_status'] == 'refunded' else 0, refunds)
    for currency in {row['currency'] for row in expected['ledger_entries']}:
        rows = [row for row in expected['ledger_entries'] if row['currency'] == currency]
        case.assertEqual(sum(row['debit_cents'] for row in rows), sum(row['credit_cents'] for row in rows))
    manifest = json.loads(files['manifest.json'])
    case.assertEqual(record['source_files']['to'], manifest['source_files'])
    case.assertEqual(record['to_source_sha256'], manifest['source_sha256'])
    table = {name: digest(data) for name, data in files.items() if name != 'manifest.json'}
    case.assertEqual(table, manifest['files'])
    case.assertEqual(sha256(canonical_json(table)), manifest['artifact_sha256'])
    case.assertEqual(record['to_artifact_sha256'], manifest['artifact_sha256'])
