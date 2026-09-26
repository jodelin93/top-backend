# Load test: checkout

`checkout.js` is a [k6](https://k6.io) script that simulates cashiers at the POS.
Each virtual user repeatedly:

1. searches the catalog (`GET /pos/catalog`)
2. prices a cart of 1–3 random items (`POST /sales/quote`)
3. completes the sale paying cash (`POST /sales`, unique idempotency key per iteration)

It logs in once in `setup()` and reuses the token for all virtual users.

> **Warning — it creates real sales.** Every iteration writes a sale, payments,
> stock movements and increases sale numbers. Run it **only against a staging
> environment with a dedicated test store**. Never run it against production or
> against a database that holds real store data.

## Prerequisites

- k6 installed (`brew install k6`, or see https://grafana.com/docs/k6/latest/set-up/install-k6/).
- A staging API with a **test store** that has:
  - a user without MFA (owner, admin, manager or cashier role) for the test,
  - an active register with a stock location, and a cash payment method
    (`POST /settings/initialize` sets these up),
  - some active products whose stock is at least 1000 at that location, or
    that allow backorder — otherwise sales start failing once stock runs out.
- Rate limiting relaxed on staging for the duration of the test. All virtual
  users come from one IP, and the API allows 300 requests/minute per IP by
  default. Set `THROTTLE_ENABLED=false` (or raise `THROTTLE_LIMIT`) on the
  staging API.

## Running

```bash
k6 run \
  -e BASE_URL=https://staging-api.example.com/api/v1 \
  -e EMAIL=loadtest@example.com \
  -e PASSWORD='...' \
  -e CONFIRM=yes \
  test/load/checkout.js
```

The script refuses to start without `CONFIRM=yes`.

| Variable       | Default                        | Meaning                                            |
| -------------- | ------------------------------ | -------------------------------------------------- |
| `BASE_URL`     | `http://localhost:3000/api/v1` | API base URL including the prefix                  |
| `EMAIL`        | —                              | Test user email (required)                         |
| `PASSWORD`     | —                              | Test user password (required)                      |
| `REGISTER_ID`  | first active register          | Register to sell from                              |
| `SEARCH_TERMS` | `a,e,o,1`                      | Comma-separated catalog search terms               |
| `VUS`          | `10`                           | Concurrent cashiers at steady state                |
| `DURATION`     | `2m`                           | Steady-state duration (plus 30s ramp-up, 15s down) |
| `THINK_TIME`   | `1`                            | Seconds a cashier pauses between steps             |
| `CONFIRM`      | —                              | Must be `yes`; acknowledges that sales are created |

## Thresholds

The run fails (non-zero exit code) if any of these is missed:

- catalog search p95 < 500 ms
- quote p95 < 500 ms
- sale creation p95 < 1 s
- HTTP error rate < 1% (`http_req_failed`)
- business errors (quote/sale not accepted, or sale total ≠ quote total) < 1%

## Cleaning up

Test sales are ordinary sales with the note `k6 load test`. The simplest way
to clean up is to use a throwaway store (tenant) for load testing and delete
it afterwards, or to restore the staging database from a snapshot.
