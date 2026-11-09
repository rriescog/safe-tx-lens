# Review model and evidence boundaries

Safe Tx Lens helps a human reviewer compare a Safe transaction across independent evidence sources. It does not sign, submit, or approve transactions, and it does not classify a transaction as safe.

## What each check establishes

| Check | What a pass establishes | What it cannot establish |
| --- | --- | --- |
| Local EIP-712 calculation | The supplied Safe fields produce the displayed Safe transaction hash | That the fields came from an independent source, or that a signer approved them |
| Safe contract hash via RPC | The selected Safe contract returns the same hash for those fields at the queried state | That the target code is benign or that the RPC is trustworthy |
| Calldata decoding | A supported ABI or signature parses the call and arguments | That the called bytecode implements the expected behavior |
| Runtime bytecode comparison | Bytecode from the selected chain and block matches a verified-source record | That the verified source is free of bugs, or that an unchecked proxy/module path is harmless |
| Simulation | A provider reported effects for one chain state and execution path | Future execution, all possible paths, or valid real-world signer approval |
| Onchain Safe event | The execution transaction emitted a Safe success or failure event | That an outer successful EVM receipt means the Safe's inner call succeeded |

The report names the origin of the transaction fields. If the fields and their embedded hash both came from Safe Transaction Service, a matching local hash proves internal consistency. Importing JSON from that same service does not create another independent source. Compare the resulting hash with the signing device and, for critical actions, a separately trusted implementation or data source.

## Call and code evidence

The tool recursively decodes recognized MultiSend, governance, timelock, proxy, and other nested calldata. It uses built-in ABIs, matched verified-source ABIs, explorer ABIs, and tentative signature candidates in that order of evidence. An ABI can name a function even when its relationship to the target bytecode is unproved; the UI labels that distinction. Unknown selectors remain visible with raw calldata.

For code verification, the tool compares runtime bytecode returned by an RPC with verified runtime bytecode from a supported source at the inspected block when possible. If historical state is unavailable, a current-only match is labeled as such: a prior upgrade may have changed the implementation. It follows recognized proxy storage and forwarding patterns, but other proxy layouts, dynamically chosen modules, delegatecall effects, and code changes inside a transaction can require a trace or manual review. It does **not** decompile arbitrary EVM bytecode. Provider-specific routes and limitations are in [ABI sources](ABI-SOURCES.md).

## Status, priority, and confidence

Execution status is separate from review priority. A queued proposal is reported from an offchain source; an obsolete nonce is not an executable pending proposal. An onchain Safe `ExecutionSuccess` or `ExecutionFailure` event identifies the Safe's inner result. An imported file without onchain evidence does not establish execution.

Review priority reflects the potential impact of decoded actions or observed effects. It is not an accusation of malicious intent. The 0–10 evidence confidence number measures completed checks, not the probability that a transaction is safe. Pending checks state what evidence is missing and whether the tool can attempt it. Unavailable or failed checks must remain visible.

## Simulation boundaries

Tenderly simulation runs only when explicitly requested and configured. It may return storage, native balance, and token effects; absent or incomplete provider fields are not treated as zero changes. A queued transaction with insufficient signatures may be conditionally previewed by changing Safe state within the simulation. Such a preview does not reproduce actual approvals and must not be presented as a faithful execution. An executed transaction may require historical sender, block, and signature context; the tool must not invent them.

## Threat model

A compromised Safe service can supply false or incomplete transaction fields; a compromised RPC can lie about contract state or code; an explorer can serve the wrong ABI; a simulator can omit effects; and a browser or signing device can mislead the reviewer. Local EIP-712 recomputation, RPC checks, bytecode comparison, and a second implementation reduce reliance on a single interface only when their data origins are genuinely independent. Self-hosting gives operators control of application code and provider selection but does not make external data inherently trustworthy.
