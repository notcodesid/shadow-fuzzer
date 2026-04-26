use anchor_lang::prelude::*;
use anchor_spl::token::Mint;
use ephemeral_rollups_sdk::anchor::commit;
// `FoldableIntentBuilder` carries the default `build_and_invoke` impl that
// every intent-sub-builder (CommitAndUndelegate, Commit, etc.) inherits;
// we need it in scope to terminate the chain in 0.11.x of the SDK.
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};

use crate::state::{Vault, VAULT_SEED};

/// Commit the vault's ER-side state back to the base layer and release
/// the delegation. The agent calls this when the fuzz session ends —
/// either successfully (so the report's findings can reference durable
/// state) or on cleanup. After this lands, the vault behaves like a
/// normal mainnet account again and any state mutations made inside the
/// rollup are persisted on the base layer.
///
/// Position PDAs that were created/mutated inside the ER and that need
/// to survive the run should be added to the same intent bundle so the
/// commit happens atomically. Out of scope for this minimal step — the
/// agent currently runs per-vault, and the position-lifecycle helper
/// lands with step 5 (SendAI brain).
#[commit]
#[derive(Accounts)]
pub struct UndelegateForFuzz<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut, seeds = [VAULT_SEED, mint.key().as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,

    pub mint: Account<'info, Mint>,
}

pub fn handler(ctx: Context<UndelegateForFuzz>) -> Result<()> {
    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[ctx.accounts.vault.to_account_info()])
    .build_and_invoke()?;
    Ok(())
}
