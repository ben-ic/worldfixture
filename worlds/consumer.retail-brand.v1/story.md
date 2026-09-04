# Marlow & Pine, the week before a drop

Marlow & Pine is a fourteen-person homeware brand that sells direct to people:
stoneware from a pottery in Asheville, washed linen, a few pantry staples, and a
monthly subscription box called the Pantry Club. It has been trading for nine
years. It is not in trouble and it is not scaling. It is a week away from a
launch with four things half-finished, which is the ordinary condition of a
company this size.

Fieldstone, a four-piece stoneware collection, opens on 25 March. Three of the
four pieces are ready. The serving bowl is not: two kiln runs produced ninety-
three sellable bowls against roughly a hundred and forty units of demand at the
last two drops, because the second glaze dip goes on heavy at the rim and crawls.
Mira wants to open the bowl as a preorder rather than list stock that does not
exist. Nobody is arguing for holding the collection. The storefront still shows
the bowl as in stock on the collection grid, which is a cache reading the wrong
availability flag, and that has to ship before the 25th.

The Harbour mug, the first stoneware piece the company ever sold, crazes. About
forty mugs from that run develop fine cracks in the glaze after repeated
dishwasher cycles. It is a glaze fit fault, not a safety fault. Three two-star
reviews describe it, and Marlow & Pine published a note naming the run, the
cause, and the fact that it is theirs — before the reviews forced it. Every
affected mug is being replaced with no return and no receipt. Thirty-four of
forty are sent; six have shipping addresses more than a year old and Otto is
confirming those first.

Two Pantry Club members were charged twice in March. A renewal charge succeeded
at the provider, the response timed out locally, and the retry ran without an
idempotency key. Rosa found it in the March reconciliation rather than from a
complaint, told both members, and then published it. One credit note is out; the
second is waiting on a reconciliation line. A credit note does not yet reference
the invoice it corrects, so the invoice number has to be stated in the message.

Eleven orders say shipped and have not moved. Swiftline scanned a pallet outbound
on 12 March with no tracking numbers, the carrier refused the load over a
manifest mismatch, and the order service accepted the scan and told eleven people
their parcel was on its way. Otto has the eleven names and is refusing to send a
holding message until Callum can tell each of them something true. Eight parcels
are in bay 3. Three are not on the pallet.

Verified-buyer badges went live on product pages nine days ago. They match a
review to an order by account id, so a genuine buyer who checked out as a guest
shows unbadged. The team shipped the gap rather than badging everyone.

Around these five are ordinary things: sixty-two orders across twenty-four
shoppers, a hundred and twelve subscription invoices over six months, twenty-six
reviews, a journal, a marketing send that is being held, and a photographer who
reshot the water jug because the old frame made an oatmeal glaze read grey.

## How this world is modelled

Two of the six organizations are consumer email providers, Everyday Mail and
Penny Post. The world profile asks every person for an organization, and a
shopper's organization is where their address lives, not who employs them. Each
one says so in its own summary. Inventing an employer for every shopper would
have been the dishonest alternative.

`finance.customers` is the Pantry Club: eighteen recurring subscriptions that
generate the monthly invoice, payment and ledger history. One-off purchases are
`commerce.orders`, which is a different relationship and a different record.

## Scale

Forty-one people and about a hundred and fifty messages, on purpose. The mail
service creates a mailbox for every person and delivers every message over LMTP
at start, which is what makes the larger business world take about two minutes.
This world is sized to be the fast one.
