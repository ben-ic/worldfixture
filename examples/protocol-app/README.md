# Python protocol application

This example uses only Python's standard protocol clients. It reads every
address and credential from `worldfixture env --json`. It does not assume a
host port.

Run these commands from the repository root:

```sh
npx worldfixture up
python3 examples/protocol-app/app.py
```

The application reads the active run. It does not assume a host port.

The scenario reads the seeded HTTP website, submits mail through SMTP, verifies
it through IMAP, writes and reads one object through the local S3 endpoint,
and receives a local HTTP callback after those actions succeed.

For repeatable verification:

```sh
npx worldfixture reset
python3 examples/protocol-app/app.py
```

The first command restores the accepted snapshot. The next run uses a new
marker and proves that all four protocols work again.
