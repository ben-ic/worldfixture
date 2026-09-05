// `worldfixture events` and `worldfixture events --follow`.
//
// THE LEDGER IS THE SOURCE. The events table is an observation ledger of
// completed facts and their provider evidence, and deliberately not a copy of
// provider state. So follow reads that table and never
// asks Slack, Cyrus or SeaweedFS for anything. Polling a provider store would
// also be wrong for a second reason: a provider write that the runtime did not
// originate has no ledger row, and inventing one from a store read would be the
// runtime asserting a fact nothing observed.
//
// WHY IT POLLS THE LEDGER, WHICH IS NOT THE SAME THING. SQLite has no
// cross-process change notification: an update hook fires only on the connection
// that made the write, and every mutation here arrives from a DIFFERENT process
// — `worldfixture slack send` runs as its own process inside the container, and
// so does the Workbench's write path. `fs.watch` on the WAL was the other
// candidate and is not dependable on a Docker Desktop bind mount. So this reads
// the local ledger file on a short interval. It is a file read in the same
// container, it costs one indexed `seq >` query, and it touches no service.
//
// ORDER IS THE CURSOR. Rows come back `ORDER BY seq` and the cursor only ever
// moves forward to the last seq printed, so a batch that arrives between two
// polls is printed in the order it was committed and nothing is printed twice.
//
// STOPPING. Two ways in, because there are two ways this process dies. SIGINT
// and SIGTERM are the user pressing Ctrl-C. Stdin reaching EOF is the host's
// `docker exec` client having gone away: `docker exec` does not forward signals
// to the process inside, so without this the container would keep a follower
// running after the terminal that started it was gone — the orphan this runtime
// promises never to leave.

import { eventsAfter } from "./state.mjs";

const PAGE = 200;

function formatEvent(row, { verbose = false } = {}) {
  const lines = [
    `${String(row.seq).padStart(4)}  ${row.occurred_at}  ${row.type}`,
    `      ${row.actor_id ?? "—"} via ${row.source}${row.caused_by ? `, caused by ${row.caused_by}` : ""}`,
  ];
  if (verbose && row.provider_evidence) {
    lines.push(`      ${typeof row.provider_evidence === "string" ? row.provider_evidence : JSON.stringify(row.provider_evidence)}`);
  }
  return lines;
}

// Every row after `cursor`, in seq order, however many there are. `eventsAfter`
// takes a limit, so a burst larger than one page is drained here rather than
// silently truncated.
export function drain(db, cursor, { page = PAGE } = {}) {
  const rows = [];
  let at = cursor;

  for (;;) {
    const batch = eventsAfter(db, at, page);
    if (batch.length === 0) break;
    rows.push(...batch);
    at = batch.at(-1).seq;
    if (batch.length < page) break;
  }

  return { rows, cursor: at };
}

export function printExisting(db, { write, verbose = false } = {}) {
  const { rows, cursor } = drain(db, 0);

  if (rows.length === 0) {
    write("No events yet. The runtime records facts it originated, so act through the CLI to produce one.\n");
    return { cursor, printed: 0 };
  }

  for (const row of rows) write(`${formatEvent(row, { verbose }).join("\n")}\n`);
  return { cursor, printed: rows.length };
}

// Print what is there, then keep printing what arrives, until something stops us.
//
// `signal` is the only exit. The caller decides what aborts it — SIGINT, SIGTERM
// or stdin EOF in the CLI, an `AbortController` in a test — so this function has
// no opinion about process lifetime and can be run to completion in-process.
export async function follow(db, { write, verbose = false, signal, intervalMs = 250, from } = {}) {
  let cursor = from;

  if (cursor === undefined) {
    cursor = printExisting(db, { write, verbose }).cursor;
    write("\nFollowing. Press Ctrl-C to stop.\n");
  }

  if (signal?.aborted) return { cursor, followed: 0 };

  let followed = 0;

  await new Promise((resolve) => {
    let timer;

    const stop = () => {
      clearInterval(timer);
      signal?.removeEventListener("abort", stop);
      resolve();
    };

    timer = setInterval(() => {
      let batch;
      try {
        batch = drain(db, cursor);
      } catch (error) {
        // The database went away under us -- the container stopped, or reset
        // replaced the file. Say which, and stop, rather than spinning.
        write(`\nThe event ledger stopped answering: ${String(error.message).trim().split("\n")[0]}\n`);
        stop();
        return;
      }

      // Reset clears the ledger and restarts `seq` at 1, so a cursor ahead of
      // the table is a reset rather than a gap. Rewinding is the honest answer:
      // the run this follower was watching no longer exists.
      if (batch.rows.length === 0) {
        const highest = eventsAfter(db, 0, 1);
        if (cursor > 0 && highest.length === 0) {
          write("\nThe ledger was reset; following the restored world from the start.\n");
          cursor = 0;
        }
        return;
      }

      for (const row of batch.rows) write(`${formatEvent(row, { verbose }).join("\n")}\n`);
      followed += batch.rows.length;
      cursor = batch.cursor;
    }, intervalMs);

    if (signal) signal.addEventListener("abort", stop, { once: true });
  });

  return { cursor, followed };
}
