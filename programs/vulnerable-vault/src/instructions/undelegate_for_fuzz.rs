use anchor_lang::prelude::*;
use anchor_spl::token::Mint;
use ephemeral_rollups_sdk::access_control::instructions::CommitAndUndelegatePermissionCpiBuilder;
use ephemeral_rollups_sdk::access_control::structs::PERMISSION_SEED;
use ephemeral_rollups_sdk::anchor::commit;
use ephemeral_rollups_sdk::consts::PERMISSION_PROGRAM_ID;
// `FoldableIntentBuilder` carries the default `build_and_invoke` impl that
// every intent-sub-builder (CommitAndUndelegate, Commit, etc.) inherits;
// we need it in scope to terminate the chain in 0.11.x of the SDK.
use ephemeral_rollups_sdk::ephem::{FoldableIntentBuilder, MagicIntentBundleBuilder};

use crate::state::{Vault, VAULT_SEED};

/// Commit the vault's ER-side state back to the base layer and release
/// the delegation. This is the cleanup half of the Private-ER lifecycle:
/// the delegate_vault ix moved both the vault state AND the permission
/// PDA into the rollup, so we have to release both — atomically, in one
/// ER transaction — when the fuzz session ends.
///
/// Step 1 commits + undelegates the permission via the Permission Program.
/// Step 2 commits + undelegates the vault state via the standard
/// MagicBlock intent-bundle path. The delegation program seals both back
/// to the base layer in the same finalization, so observers at the base
/// layer see a single consistent snapshot of post-fuzz state.
#[commit]
#[derive(Accounts)]
pub struct UndelegateForFuzz<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(mut, seeds = [VAULT_SEED, mint.key().as_ref()], bump = vault.bump)]
    pub vault: Account<'info, Vault>,

    pub mint: Account<'info, Mint>,

    /// CHECK: Permission PDA in the Permission Program. Validated by seeds.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, vault.key().as_ref()],
        bump,
        seeds::program = permission_program.key(),
    )]
    pub permission: AccountInfo<'info>,

    /// CHECK: pinned to the SDK's Permission Program ID.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<UndelegateForFuzz>) -> Result<()> {
    let mint_key = ctx.accounts.mint.key();
    let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, mint_key.as_ref(), &[ctx.accounts.vault.bump]]];

    // 1. Release the permission PDA via the Permission Program.
    CommitAndUndelegatePermissionCpiBuilder::new(
        &ctx.accounts.permission_program.to_account_info(),
    )
    .authority(&ctx.accounts.payer.to_account_info(), true)
    .permissioned_account(&ctx.accounts.vault.to_account_info(), true)
    .permission(&ctx.accounts.permission.to_account_info())
    .magic_context(&ctx.accounts.magic_context.to_account_info())
    .magic_program(&ctx.accounts.magic_program.to_account_info())
    .invoke_signed(signer_seeds)?;

    // 2. Commit + undelegate the vault state itself.
    MagicIntentBundleBuilder::new(
        ctx.accounts.payer.to_account_info(),
        ctx.accounts.magic_context.to_account_info(),
        ctx.accounts.magic_program.to_account_info(),
    )
    .commit_and_undelegate(&[ctx.accounts.vault.to_account_info()])
    .build_and_invoke()?;

    Ok(())
}
