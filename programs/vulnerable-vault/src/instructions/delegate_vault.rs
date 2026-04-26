use anchor_lang::prelude::*;
use anchor_spl::token::Mint;
use ephemeral_rollups_sdk::access_control::instructions::{
    CreatePermissionCpiBuilder, DelegatePermissionCpiBuilder, UpdatePermissionCpiBuilder,
};
use ephemeral_rollups_sdk::access_control::structs::{Member, MembersArgs, PERMISSION_SEED};
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::consts::PERMISSION_PROGRAM_ID;
use ephemeral_rollups_sdk::cpi::DelegateConfig;

use crate::state::VAULT_SEED;

/// Delegate the vault PDA into a **Private** MagicBlock Ephemeral Rollup.
/// "Private" means the validator gates writes by signature: only members
/// listed in the Permission account can interact with the delegated state.
/// Without this layer the rollup is reachable by anyone with the validator
/// URL — fine for testing, not fine for a security-research demo where
/// the entire point is hiding the in-flight exploit from MEV bots.
///
/// The flow this ix runs is:
///   1. Create or update the Permission PDA (records the allowed members).
///   2. Register the Permission PDA itself with the Delegation Program so
///      the gating PDA travels with the rollup.
///   3. Delegate the vault PDA (the actual state we're fuzzing).
///
/// Each step is idempotent — a second call from the same agent re-uses
/// the existing permission and just refreshes the member set.
#[delegate]
#[derive(Accounts)]
pub struct DelegateVault<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: program-owned PDA being delegated; validated by seeds.
    #[account(mut, del, seeds = [VAULT_SEED, mint.key().as_ref()], bump)]
    pub vault: AccountInfo<'info>,

    pub mint: Account<'info, Mint>,

    /// CHECK: Permission PDA in the Permission Program. Tracks the
    /// member set that's allowed to act on the delegated vault.
    #[account(
        mut,
        seeds = [PERMISSION_SEED, vault.key().as_ref()],
        bump,
        seeds::program = permission_program.key(),
    )]
    pub permission: AccountInfo<'info>,

    /// CHECK: Delegation buffer for the permission PDA.
    #[account(
        mut,
        seeds = [ephemeral_rollups_sdk::pda::DELEGATE_BUFFER_TAG, permission.key().as_ref()],
        bump,
        seeds::program = PERMISSION_PROGRAM_ID,
    )]
    pub buffer_permission: AccountInfo<'info>,

    /// CHECK: Delegation record for the permission PDA.
    #[account(
        mut,
        seeds = [ephemeral_rollups_sdk::pda::DELEGATION_RECORD_TAG, permission.key().as_ref()],
        bump,
        seeds::program = ephemeral_rollups_sdk::id(),
    )]
    pub delegation_record_permission: AccountInfo<'info>,

    /// CHECK: Delegation metadata for the permission PDA.
    #[account(
        mut,
        seeds = [ephemeral_rollups_sdk::pda::DELEGATION_METADATA_TAG, permission.key().as_ref()],
        bump,
        seeds::program = ephemeral_rollups_sdk::id(),
    )]
    pub delegation_metadata_permission: AccountInfo<'info>,

    /// CHECK: pinned to the SDK's Permission Program ID.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: AccountInfo<'info>,

    pub system_program: Program<'info, System>,

    /// CHECK: optional validator pubkey to pin the rollup to. When unset
    /// the Magic Router picks the closest one.
    pub validator: Option<AccountInfo<'info>>,
}

pub fn handler(ctx: Context<DelegateVault>, members: Option<Vec<Member>>) -> Result<()> {
    let validator = ctx.accounts.validator.as_ref();
    let mint_key = ctx.accounts.mint.key();
    let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, mint_key.as_ref(), &[ctx.bumps.vault]]];

    // 1. Create or update the permission PDA.
    if ctx.accounts.permission.data_is_empty() {
        CreatePermissionCpiBuilder::new(&ctx.accounts.permission_program)
            .permissioned_account(&ctx.accounts.vault.to_account_info())
            .permission(&ctx.accounts.permission.to_account_info())
            .payer(&ctx.accounts.payer.to_account_info())
            .system_program(&ctx.accounts.system_program.to_account_info())
            .args(MembersArgs {
                members: members.clone(),
            })
            .invoke_signed(signer_seeds)?;
    } else {
        UpdatePermissionCpiBuilder::new(&ctx.accounts.permission_program.to_account_info())
            .authority(&ctx.accounts.payer.to_account_info(), true)
            .permissioned_account(&ctx.accounts.vault.to_account_info(), true)
            .permission(&ctx.accounts.permission.to_account_info())
            .args(MembersArgs {
                members: members.clone(),
            })
            .invoke_signed(signer_seeds)?;
    }

    // 2. Register the permission PDA's own delegation if it hasn't been
    //    handed off to the delegation program yet. Without this the
    //    permission gating PDA stays on the base layer and the rollup
    //    can't enforce membership at the validator level.
    if ctx.accounts.permission.owner != &ephemeral_rollups_sdk::id() {
        DelegatePermissionCpiBuilder::new(&ctx.accounts.permission_program.to_account_info())
            .permissioned_account(&ctx.accounts.vault.to_account_info(), true)
            .permission(&ctx.accounts.permission.to_account_info())
            .payer(&ctx.accounts.payer.to_account_info())
            .authority(&ctx.accounts.vault.to_account_info(), false)
            .system_program(&ctx.accounts.system_program.to_account_info())
            .owner_program(&ctx.accounts.permission_program.to_account_info())
            .delegation_buffer(&ctx.accounts.buffer_permission.to_account_info())
            .delegation_metadata(&ctx.accounts.delegation_metadata_permission.to_account_info())
            .delegation_record(&ctx.accounts.delegation_record_permission.to_account_info())
            .delegation_program(&ctx.accounts.permission_program.to_account_info())
            .validator(validator)
            .invoke_signed(signer_seeds)?;
    }

    // 3. Delegate the vault PDA itself (skip if already delegated — the
    //    delegation program reassigns ownership, so this is the gate).
    if ctx.accounts.vault.owner != &ephemeral_rollups_sdk::id() {
        ctx.accounts.delegate_vault(
            &ctx.accounts.payer,
            &[VAULT_SEED, mint_key.as_ref()],
            DelegateConfig {
                validator: validator.map(|v| v.key()),
                ..Default::default()
            },
        )?;
    }

    Ok(())
}
