# dabdub_contracts

Soroban smart contracts powering the dabdub payment platform.

## Contract Interaction Diagrams

> **Maintenance note:** These diagrams are part of the contract documentation. Whenever a new cross-contract call is added (a new `#[contractclient]` interface, a new `env.invoke_contract` / client invocation, or a new contract-to-contract data dependency), update the relevant diagram below in the same PR. Reviewers should treat a stale diagram as a documentation bug.

### Contract Call Graph

Shows which contracts invoke which other contracts. Arrows point from caller to callee.

```mermaid
flowchart TD
    subgraph Core["Core Payment Flow"]
        PE[payment_escrow]
        SL[settlement_ledger]
        MR[merchant_registry]
        RF[refund_manager]
    end

    subgraph Support["Supporting Contracts"]
        FE[fee_manager]
        TR[treasury]
        OR[oracle_router]
        DS[dispute_resolver]
        NT[notification_hub]
        AC[access_control]
        UP[upgrade_governor]
        AN[analytics]
        KY[kyc_registry]
        MT[multisig_treasury]
    end

    PE -->|is_approved| MR
    PE -->|record_settlement| SL
    PE -->|transfer| TR
    PE -->|compute_fee| FE
    PE -->|resolve| DS
    PE -->|emit| NT
    PE -->|check_role| AC

    SL -->|compute_fee| FE
    SL -->|transfer| TR
    SL -->|emit| NT
    SL -->|record| AN

    RF -->|transfer| TR
    RF -->|emit| NT
    RF -->|check_role| AC

    DS -->|check_role| AC
    DS -->|transfer| TR
    DS -->|emit| NT

    OR -->|get_price| AN
    OR -->|check_role| AC

    FE -->|check_role| AC
    TR -->|check_role| AC
    TR -->|check_role| MT

    NT -->|check_role| AC
    AN -->|check_role| AC
    KY -->|check_role| AC
    MT -->|check_role| AC

    UP -->|check_role| AC
    UP -->|update_wasm| PE
    UP -->|update_wasm| SL
    UP -->|update_wasm| RF
```

### Payment Escrow Deposit → Settlement Ledger Record (Data Flow)

Shows the data flow when a customer deposits into `payment_escrow` and the escrow later records the settlement in `settlement_ledger`.

```mermaid
sequenceDiagram
    autonumber
    actor Customer
    participant PE as payment_escrow
    participant MR as merchant_registry
    participant TK as Token (XLM/USDC)
    participant SL as settlement_ledger
    participant FE as fee_manager
    participant TR as treasury

    Customer->>PE: deposit(payment_id, merchant, amount, expiry)
    PE->>MR: is_approved(merchant)
    MR-->>PE: true
    PE->>TK: transfer(customer, escrow, amount)
    TK-->>PE: ok
    PE->>PE: store Payment{status: Pending}
    PE-->>Customer: DepositEvent

    Note over Customer,PE: ... payment released or dispute resolved ...

    PE->>SL: record_settlement(payment_id, merchant, amount)
    SL->>FE: compute_fee(amount)
    FE-->>SL: fee
    SL->>TR: transfer(fee)
    SL->>TR: transfer(amount - fee)
    SL->>SL: store SettlementRecord{payment_id, merchant, amount, fee}
    SL-->>PE: SettlementRecordedEvent
    PE->>PE: Payment{status: Released}
```
