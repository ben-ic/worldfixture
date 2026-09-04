# Python protocol application

This example uses only Python's standard protocol clients. It reads every
address and credential from `worldfixture env --json`. It does not assume a
host port.

Start WorldFixture. Then run one command here:

```sh
python3 app.py
```

The scenario reads the seeded HTTP website, submits mail through SMTP, verifies
it through IMAP, writes and reads one object through the SeaweedFS S3 endpoint,
and receives a local HTTP callback after those actions succeed.

For repeatable verification:

```sh
node ../../runtime/bin/worldfixture.mjs reset
python3 app.py
```

The first command restores the accepted snapshot. The next run uses a new
marker and proves that all four protocols work again.
