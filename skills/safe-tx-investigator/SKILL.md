---
name: safe-tx-investigator
description: Trace and review a Safe transaction from a Safe hash, execution hash, Safe address, URL, or transaction JSON, distinguishing queued proposals from verified onchain execution.
---

# Safe transaction investigation

Use this skill when the user asks what a Safe transaction does, where it is queued or executed, or whether a displayed analysis is supported by evidence. Follow the user's language.

1. Start with the supplied input. If Safe Tx Lens is available, run `safe-tx-lens inspect '<input>' --network auto --json` (or its MCP `inspect` tool). For a Safe address, use `--scope pending`, `history`, or `both` as requested. Do not require a Safe address when a hash is supplied.
2. Record how the network, Safe address, transaction fields, and execution status were obtained. A 32-byte Safe hash alone contains no readable network, address, or calldata. Search configured offchain proposal sources for pending transactions and indexed `ExecutionSuccess`/`ExecutionFailure` events plus the execution transaction for historical ones. A matching index entry is a lead; verify the hash and calldata against the chain.
3. Decode outer and nested calls from the actual transaction bytes. Check the Safe hash calculation against the selected chain and Safe when all fields are available. Distinguish calldata intent, a simulation result, emitted events, and measured storage or balance differences. Do not claim a state change was measured from a function name or successful receipt alone.
4. Report source coverage and freshness. A missing proposal in a cached or imported snapshot does not mean the queue is empty. If the Safe service is rate limited, identify that source failure and continue with available independent sources. If a pending hash is absent from every accessible offchain index, say its payload cannot be recovered from the hash alone; request the Safe URL, transaction export, or access to a proposal source. Never invent an ABI, chain, Safe address, or risk finding to fill a gap.
5. Give the user a concise conclusion with the Safe hash, network, Safe address, nonce, status, decoded actions, evidence links or execution hash/block, and explicit verification limits. For security-sensitive changes, prefer exact bytes and independently checked effects over a one-word risk rating.

The local project is `safe-tx-lens`. Optional service credentials are read by the local server; do not print or copy keys into reports. Authentication to the Safe Transaction Service is useful for arbitrary queued proposals. API plans have quotas; avoid repeated broad polling.
