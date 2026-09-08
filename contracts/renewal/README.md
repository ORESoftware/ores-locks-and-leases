# Renewal contract authorities

`typespec/main.tsp` and `json-schema/contract.schema.json` are independently
authored peer authorities for the supervised-renewal state machine. Neither may
overwrite the other. TypeSpec-generated JSON Schema B is disposable comparison
evidence only.

The contract fixes the cross-runtime vocabulary, full-width fencing-token
identity, logical-clock domain, scheduling decisions, terminal loss reasons,
and observable snapshot shape. Runtime behavior is additionally checked against
`conformance/cases/renewal-decision.json`.

Run:

```sh
npx --yes \
  --package=https://github.com/ORESoftware/ores-contracts/archive/f79ea8d8d94d7a9e78c15f7e46ecae8e4b584d2e.tar.gz \
  ores-contracts check --config contracts/renewal/contracts.config.json
```
