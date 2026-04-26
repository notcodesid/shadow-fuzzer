// vulnerable-vault — DELIBERATELY BROKEN. Demo target for Shadow Fuzzer.
//
// Two planted bugs the fuzzing agent should rediscover from a black-box state
// snapshot. Both are realistic patterns we've seen in audited mainnet code,
// not toy mistakes:
//
//   BUG #1 — instructions/deposit.rs::deposit
//            unchecked `+=` on `vault.total_deposits` and `position.balance`.
//            A large deposit wraps u64; subsequent withdraws drain the vault.
//
//   BUG #2 — instructions/withdraw.rs::withdraw
//            no `has_one = owner` constraint and no manual signer check on
//            `UserPosition.owner`. Anyone can withdraw any position to a token
//            account they control by passing a forged `owner` account.
//
// Invariants the fuzzer asserts (see packages/agent/src/invariants.ts):
//   INV-1  vault.total_deposits == Σ user_position.balance
//   INV-2  spl_balance(vault_token_account) == vault.total_deposits
//   INV-3  successful withdraw ⇒ tx signed by user_position.owner
#![allow(clippy::result_large_err)]

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;

declare_id!("CbdZT6zkBvgfaWCPUooeTkCZDuRz8Rfwmnhw2Nu6ZooC");

pub mod error;
pub mod instructions;
pub mod state;

use instructions::*;

// `#[ephemeral]` opts the program into the MagicBlock ephemeral-rollups
// runtime. It teaches anchor how to handle accounts whose owner has been
// reassigned to the delegation program (the state during a fuzz session)
// and unlocks the `#[delegate]` / `#[commit]` macros used by the
// delegate_vault and undelegate_for_fuzz instructions.
#[ephemeral]
#[program]
pub mod vulnerable_vault {
    use super::*;

    pub fn initialize_vault(ctx: Context<InitializeVault>) -> Result<()> {
        instructions::initialize_vault::handler(ctx)
    }

    pub fn open_position(ctx: Context<OpenPosition>) -> Result<()> {
        instructions::open_position::handler(ctx)
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::deposit::handler(ctx, amount)
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        instructions::withdraw::handler(ctx, amount)
    }

    /// Delegate the vault PDA into a MagicBlock ER. The agent calls this
    /// before the fuzz loop starts.
    pub fn delegate_vault(ctx: Context<DelegateVault>) -> Result<()> {
        instructions::delegate_vault::handler(ctx)
    }

    /// Commit ER-side state back to the base layer and release the
    /// delegation. The agent calls this when the fuzz session ends.
    pub fn undelegate_for_fuzz(ctx: Context<UndelegateForFuzz>) -> Result<()> {
        instructions::undelegate_for_fuzz::handler(ctx)
    }
}
