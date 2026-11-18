# companion-module-grassvalley-ampp

See [HELP.md](./companion/HELP.md) and [LICENSE](./LICENSE)

## Getting started

Executing a `yarn` command should perform all necessary steps to develop the module, if it does not then follow the steps below.

The module can be built once with `yarn build`. This should be enough to get the module to be loadable by companion.

While developing the module, by using `yarn dev` the compiler will be run in watch mode to recompile the files on change.

## Testing

`yarn test` runs the unit tests.

`yarn test:e2e` runs the real module against a live AMPP system, set in a gitignored `.env`:

```
URL=https://<region>.gvampp.com
API_KEY=<an AMPP Control API key>

# Optional: targets the suite may change, putting each back afterwards
AMPP_E2E_DESTINATION=<destination to route, lock and rename>
AMPP_E2E_SOURCE=<source on the destination's fabric>
AMPP_E2E_APP=<app to stop, start and restart>
```

With only `URL` and `API_KEY` it just reads. Targets can be given by id, name or alias.
