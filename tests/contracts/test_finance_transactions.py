import copy
import io
import json
import runpy
import shutil
import tempfile
import unittest
from collections import Counter, defaultdict
from contextlib import redirect_stdout
from datetime import date, datetime
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
from worldfixture_compiler.compiler import (
    PACK_SOURCES,
    WorldError,
    build_world,
    compile_world,
    load_world,
    prune_world,
    rebase_world,
    validate_world,
)
from worldfixture_compiler.sections import schema_validator

ROOT = Path(__file__).resolve().parents[2]
REPO = ROOT


def source(name='business.saas-company.v2'):
    return load_world(ROOT / 'worlds' / name / 'world.json')[0]


def compile(name='business.saas-company.v2'):
    return compile_world(source(name))


class FinanceTransactionsTest(unittest.TestCase):
    def test_absent_billing_mode_matches_explicit_legacy_policy(self):
        world = source()
        expected = compile_world(world)['packs']['finance']
        for customer in world['finance']['customers']:
            customer['billing_mode'] = 'recurring_monthly'
            customer['revenue_account'] = 'subscription-revenue'
        actual = compile_world(world)['packs']['finance']
        for collection in ('invoices', 'payments', 'bills', 'refunds', 'ledger_entries'):
            self.assertEqual(actual[collection], expected[collection])

    def test_generator_preserves_authored_finance_and_base_totals(self):
        retail = ROOT / 'worlds/consumer.retail-brand.v1'
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'retail'
            shutil.copytree(retail, target)
            preserved = {name: (target / name).read_bytes() for name in (
                'world.json', 'packs/google-mailboxes.json', 'packs/finance-settlements.json')}
            generator = runpy.run_path(str(target / 'generate.py'))
            with redirect_stdout(io.StringIO()):
                generator['main']()
            for name, content in preserved.items():
                self.assertEqual((target / name).read_bytes(), content)
            world = load_world(target / 'world.json')[0]
            self.assertEqual(len(world['commerce']['orders']), 64)
            self.assertEqual(len(world['finance']['customers']), 19)
            self.assertEqual(len(compile_world(world)['packs']['finance']['payments']), 109)

    def test_each_resolved_invoice_and_payment_projects_once(self):
        for name, expected in [('business.saas-company.v2', (49, 48)),
            ('business.saas-company.v3', (648, 621)), ('consumer.retail-brand.v1', (113, 109))]:
            result = compile(name)
            finance, stripe = result['packs']['finance'], result['projections']['stripe']
            self.assertEqual((len(stripe['invoices']), len(stripe['transactions']['payments'])), expected)
            self.assertEqual({r['id'] for r in finance['invoices']}, {r['metadata']['worldfixture_invoice_id'] for r in stripe['invoices']})
            self.assertEqual({r['id'] for r in finance['payments']}, {r['metadata']['worldfixture_payment_id'] for r in stripe['transactions']['payments']})
            self.assertEqual(stripe['transactions'], result['projections']['emulator-overlay']['stripe']['transactions'])

    def test_one_time_purchase_not_counted_again_as_invoice_and_cancelled_order_has_no_payment(self):
        result = compile('consumer.retail-brand.v1')
        finance, stripe = result['packs']['finance'], result['projections']['stripe']
        self.assertEqual(len(stripe['subscriptions']), 18)
        self.assertEqual(len(stripe['customers']), 19)
        payments = [r for r in finance['payments'] if r.get('order_id') == 'order-finance-example-paid']
        self.assertEqual(len(payments), 1)
        self.assertEqual(payments[0]['amount_cents'], 5995)
        self.assertFalse(any(r.get('order_id') == 'order-finance-example-cancelled' for r in finance['payments']))
        self.assertEqual(finance['refunds'][0]['amount_cents'], 2600)
        revenue = [r for r in finance['ledger_entries'] if r['account'] == 'retail-sales']
        self.assertEqual(sum(r['credit_cents'] - r['debit_cents'] for r in revenue), 3395)
        balance = defaultdict(int)
        for row in finance['ledger_entries']:
            balance[(row['record_id'], row['currency'])] += row['debit_cents'] - row['credit_cents']
        self.assertEqual(set(balance.values()), {0})
        self.assertEqual(len(result['world']['commerce']['orders']), 64)
        self.assertEqual(len([c for c in result['world']['finance']['customers'] if c.get('billing_mode', 'recurring_monthly') == 'recurring_monthly']), 18)

    def test_authored_override_replaces_one_generated_payment_and_empty_list_adds_nothing(self):
        world = source()
        baseline = compile_world(world)['packs']['finance']
        payment = copy.deepcopy(baseline['payments'][0])
        payment.update(id='pay-authored-override', status='succeeded')
        world['finance']['payments'].append(payment)
        actual = compile_world(world)['packs']['finance']['payments']
        self.assertEqual(len(actual), len(baseline['payments']))
        self.assertEqual([r['id'] for r in actual if r['invoice_id'] == payment['invoice_id']], ['pay-authored-override'])
        for customer in world['finance']['customers']:
            customer['due_day'] = 1
        world['finance'].pop('payments')
        default = compile_world(world)['packs']['finance']['payments']
        world['finance']['payments'] = []
        self.assertEqual(compile_world(world)['packs']['finance']['payments'], default)

    def test_world_and_record_currency_propagate_without_usd_fallback(self):
        world = source()
        world['finance']['currency'] = 'EUR'
        world['finance']['anchor_invoices'][0]['currency'] = 'EUR'
        world['finance']['customers'][0]['currency'] = 'GBP'
        for payment in world['finance']['payments']:
            payment['currency'] = 'GBP' if payment['customer_id'] == world['finance']['customers'][0]['id'] else 'EUR'
        result = compile_world(world)
        currencies = {r['currency'] for r in result['projections']['stripe']['prices']}
        self.assertEqual(currencies, {'eur', 'gbp'})
        self.assertEqual({r['currency'] for r in result['packs']['finance']['ledger_entries']}, {'EUR', 'GBP'})
        for payment in result['packs']['finance']['payments']:
            invoice = next(r for r in result['packs']['finance']['invoices'] if r['id'] == payment['invoice_id'])
            self.assertEqual(payment['currency'], invoice['currency'])
        retail = source('consumer.retail-brand.v1')
        retail['finance']['currency'] = 'EUR'
        for customer in retail['finance']['customers']:
            customer['currency'] = 'USD'
        for product in retail['commerce']['products']:
            product.pop('currency', None)
        catalog = compile_world(retail)['projections']['stripe']['prices'][18:]
        self.assertTrue(all(row['currency'] == 'eur' for row in catalog))

    def test_unresolved_paid_anchor_dates_fail_honestly_and_authored_mix_is_bounded(self):
        world = source('business.saas-company.v3')
        invoices = {row['id']: row for row in world['finance']['anchor_invoices']}
        unresolved = copy.deepcopy(world)
        unresolved['finance']['payments'] = [row for row in world['finance']['payments'] if row['invoice_id'] not in invoices]
        with self.assertRaisesRegex(WorldError, 'needs explicit authored settlements with paid_on'):
            compile_world(unresolved)
        distribution = Counter()
        for payment in world['finance']['payments']:
            if payment['invoice_id'] not in invoices:
                continue
            invoice = invoices[payment['invoice_id']]
            self.assertEqual(invoice['status'], 'paid')
            self.assertGreaterEqual(payment['paid_on'], invoice['issued_on'])
            self.assertLessEqual(payment['paid_on'], world['clock']['anchor'][:10])
            days = (date.fromisoformat(payment['paid_on']) - date.fromisoformat(invoice['due_on'])).days
            distribution[days] += 1
        self.assertEqual(distribution, {-3: 15, 0: 15, 4: 15})
        self.assertEqual(sum(row['status'] == 'overdue' for row in invoices.values()), 3)
        self.assertEqual(sum(row['status'] == 'open' for row in invoices.values()), 24)

    def test_invalid_references_dates_statuses_and_amounts_fail(self):
        changes = [
            lambda w: w['finance']['customers'][-1].update(billing_mode=None),
            lambda w: w['finance']['customers'][-1].update(billing_mode=[]),
            lambda w: w['finance']['customers'][-1].update(revenue_account=None),
            lambda w: w['finance']['payments'][0].update(paid_on=None),
            lambda w: w['finance']['payments'][0].update(paid_on='2027-01-01'),
            lambda w: w['finance']['payments'][0].update(paid_on='2030-01-01'),
            lambda w: w['finance']['payments'][0].update(paid_on='20270310'),
            lambda w: w['finance']['payments'][0].update(currency='EUR'),
            lambda w: w['finance']['payments'][0].update(customer_id='unknown'),
            lambda w: w['finance']['payments'][0].update(order_id='unknown'),
            lambda w: w['finance']['payments'][0].update(status='cancelled'),
            lambda w: w['finance']['payments'][0].update(amount_cents=True),
            lambda w: w['finance']['payments'][0].update(amount_cents=6000),
            lambda w: w['finance']['payments'].append(copy.deepcopy(w['finance']['payments'][0])),
            lambda w: w['finance']['refunds'][0].update(payment_id='unknown'),
            lambda w: w['finance']['refunds'][0].update(amount_cents=5996),
            lambda w: w['finance']['refunds'][0].update(currency='GBP'),
            lambda w: w['finance']['refunds'][0].update(refunded_on='2027-01-01'),
            lambda w: w['finance']['refunds'][0].update(refunded_on='2030-01-01'),
            lambda w: w['commerce']['orders'][-2].update(payment_status='unpaid'),
            lambda w: w['commerce']['orders'][-2].update(status='cancelled'),
            lambda w: w['finance']['payments'][0].pop('invoice_id'),
            lambda w: w['finance']['anchor_invoices'][-1].pop('order_id'),
            lambda w: w['finance'].update(refunds=[]),
        ]
        for change in changes:
            world = source('consumer.retail-brand.v1')
            change(world)
            with self.assertRaises(WorldError):
                validate_world(world)

    def test_malformed_transaction_reference_fields_raise_world_error(self):
        for collection, fields in [('payments', ['id', 'customer_id', 'invoice_id', 'order_id']),
                                   ('refunds', ['id', 'payment_id'])]:
            for field in fields:
                for value in (None, [], {}, 42):
                    world = source('consumer.retail-brand.v1')
                    world['finance'][collection][0][field] = value
                    with self.assertRaises(WorldError):
                        validate_world(world)

    def test_prune_preserves_invoice_payment_refund_and_clears_optional_order_links(self):
        world = source('consumer.retail-brand.v1')
        without_orders = prune_world(world, set(PACK_SOURCES) - {'commerce'})
        result = compile_world(without_orders)['packs']['finance']
        invoice = next(row for row in result['invoices'] if row['id'] == 'inv-finance-example-paid')
        payment = next(row for row in result['payments'] if row['id'] == 'pay-finance-example-paid')
        self.assertNotIn('order_id', invoice)
        self.assertNotIn('order_id', payment)
        self.assertEqual(payment['invoice_id'], invoice['id'])
        self.assertEqual(result['refunds'][0]['payment_id'], payment['id'])
        self.assertEqual(len(result['payments']), 109)
        without_finance = prune_world(world, set(PACK_SOURCES) - {'finance'})
        self.assertEqual(len(without_finance['commerce']['orders']), 64)
        self.assertTrue(all('payment_status' not in row for row in without_finance['commerce']['orders']))

    def test_prune_drops_order_only_payment_and_its_refund(self):
        world = source('consumer.retail-brand.v1')
        payment = world['finance']['payments'][0]
        invoice_id = payment.pop('invoice_id')
        world['finance']['anchor_invoices'] = [row for row in world['finance']['anchor_invoices'] if row['id'] != invoice_id]
        validate_world(world)
        pruned = prune_world(world, set(PACK_SOURCES) - {'commerce'})
        self.assertFalse(any(row['id'] == payment['id'] for row in pruned['finance']['payments']))
        self.assertEqual(pruned['finance']['refunds'], [])

    def test_provider_id_collision_is_refused(self):
        world = source('consumer.retail-brand.v1')
        customer = copy.deepcopy(world['finance']['customers'][-1])
        customer['id'] = 'shop.wes.agyeman'
        world['finance']['customers'].append(customer)
        with self.assertRaisesRegex(WorldError, 'Stripe ID collision'):
            compile_world(world)

    def test_finance_linked_refunded_order_requires_its_payment_even_without_payment_status(self):
        world = source('consumer.retail-brand.v1')
        order = next(row for row in world['commerce']['orders'] if row['id'] == 'order-finance-example-paid')
        order['status'] = 'refunded'
        order.pop('payment_status')
        world['finance']['anchor_invoices'][-1]['status'] = 'open'
        world['finance']['payments'] = [row for row in world['finance']['payments'] if row['id'] != 'pay-finance-example-paid']
        world['finance']['refunds'] = []
        with self.assertRaisesRegex(WorldError, 'finance-linked refunded order .* needs its original payment'):
            compile_world(world)

    def test_generated_dates_reserved_accounts_and_malformed_transaction_rows_fail(self):
        world = source()
        world['finance'].pop('payments')
        with self.assertRaisesRegex(WorldError, 'after the world anchor'):
            compile_world(world)
        for collection in ('payments', 'refunds'):
            for value in (None, 'not a record', 12, []):
                world = source('consumer.retail-brand.v1')
                world['finance'][collection] = [value]
                with self.assertRaisesRegex(WorldError, 'entries must be objects'):
                    validate_world(world)
        world = source('consumer.retail-brand.v1')
        world['finance']['customers'][-1]['revenue_account'] = 'operating-expense'
        with self.assertRaisesRegex(WorldError, 'reserved balance/expense'):
            compile_world(world)

    def test_rebase_moves_authored_dates_together_without_changing_payment_offsets(self):
        world = source('consumer.retail-brand.v1')
        rebased = rebase_world(world, datetime.fromisoformat('2028-03-18T09:00:00+00:00'))
        payment = rebased['finance']['payments'][0]
        refund = rebased['finance']['refunds'][0]
        self.assertEqual((date.fromisoformat(refund['refunded_on']) - date.fromisoformat(payment['paid_on'])).days, 2)
        delta = date.fromisoformat(rebased['clock']['anchor'][:10]) - date.fromisoformat(world['clock']['anchor'][:10])
        self.assertEqual(date.fromisoformat(payment['paid_on']), date.fromisoformat(world['finance']['payments'][0]['paid_on']) + delta)

    def test_every_finance_date_and_id_survives_rebase_and_rebase_of_rebase(self):
        for name in ('business.saas-company.v2', 'business.saas-company.v3', 'consumer.retail-brand.v1'):
            original = source(name)
            reference = compile_world(original)['packs']['finance']
            once = rebase_world(original, datetime.fromisoformat('2028-01-01T09:00:00+00:00'))
            twice = rebase_world(once, datetime.fromisoformat('2025-11-03T09:00:00+00:00'))
            for shifted in (once, twice):
                context = shifted['clock']['rebase']['finance_history']
                self.assertEqual(context['origin_anchor'], original['clock']['anchor'])
                delta = date.fromisoformat(shifted['clock']['anchor'][:10]) - date.fromisoformat(original['clock']['anchor'][:10])
                self.assertEqual(context['day_shift'], delta.days)
                finance = compile_world(shifted)['packs']['finance']
                for collection in ('invoices', 'payments', 'bills', 'refunds', 'ledger_entries'):
                    old_rows = {row['id']: row for row in reference[collection]}
                    rows = {row['id']: row for row in finance[collection]}
                    self.assertEqual(set(rows), set(old_rows))
                    for identity, old in old_rows.items():
                        expected = copy.deepcopy(old)
                        for field in ('issued_on', 'due_on', 'paid_on', 'refunded_on', 'date'):
                            if field in expected:
                                expected[field] = (date.fromisoformat(expected[field]) + delta).isoformat()
                        # Authored prose dates keep the existing text-rebase rule.
                        actual = {key: value for key, value in rows[identity].items() if key != 'description'}
                        expected.pop('description', None)
                        self.assertEqual(actual, expected)
                schema_validator("world-definition.v1.schema.json", format_checker=FormatChecker()).validate(shifted)

    def test_invalid_finance_rebase_context_is_rejected(self):
        for context in (None, {}, {'origin_anchor': 'invalid', 'day_shift': 0},
            {'origin_anchor': '2026-08-21T09:00:00', 'day_shift': 0},
            {'origin_anchor': '2026-08-21T09:00:00Z', 'day_shift': True},
            {'origin_anchor': '2026-08-21T09:00:00Z', 'day_shift': 10}):
            world = source()
            world['clock']['rebase']['finance_history'] = context
            with self.assertRaises(WorldError):
                validate_world(world)

    def test_deterministic_double_builds_and_published_schemas(self):
        manifest_schema = json.loads((REPO / 'schemas/world-artifact.v1.schema.json').read_text())
        for name, label in [('business.saas-company.v2', 'v2'), ('business.saas-company.v3', 'v3'), ('consumer.retail-brand.v1', 'retail')]:
            directory = tempfile.TemporaryDirectory()
            self.addCleanup(directory.cleanup)
            first, second = Path(directory.name) / f'{label}-first', Path(directory.name) / f'{label}-second'
            build_world(ROOT / 'worlds' / name / 'world.json', first)
            build_world(ROOT / 'worlds' / name / 'world.json', second)
            def files(path):
                return {p.relative_to(path).as_posix(): p.read_bytes() for p in path.rglob('*') if p.is_file()}
            self.assertEqual(files(first), files(second))
            schema_validator("world-definition.v1.schema.json", format_checker=FormatChecker()).validate(json.loads((first / 'world.json').read_text()))
            Draft202012Validator(manifest_schema).validate(json.loads((first / 'manifest.json').read_text()))


if __name__ == '__main__':
    unittest.main()
