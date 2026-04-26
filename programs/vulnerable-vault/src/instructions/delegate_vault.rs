use anchor_lang::prelude::*;
use anchor_spl::token::Mint;
use ephemeral_rollups_sdk::anchor::delegate;
use ephemeral_rollups_sdk::cpi::DelegateConfig;

use crate::state::VAULT_SEED;

/// Delegate the vault PDA into a MagicBlock Ephemeral Rollup so the fuzz
/// loop's transactions route to a private validator instead of mainnet.
///
/// The agent calls this once per fuzz session against the vault it
/// snapshotted. After this lands, every subsequent tx touching the vault
/// (opening positions, deposit, withdraw — including the BUG #2 exploit)
/// is routed by the Magic Router to the chosen validator and is invisible
/// to the public mempool until the matching `undelegate_for_fuzz` commits
/// the state back to the base layer.
#[delegate]
#[derive(Accounts)]
pub struct DelegateVault<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: program-owned PDA being delegated; validated by seeds.
    /// During delegate the delegation program reassigns ownership, so we
    /// can't use the typed `Account<'info, Vault>` wrapper here.
    #[account(mut, del, seeds = [VAULT_SEED, mint.key().as_ref()], bump)]
    pub vault: AccountInfo<'info>,

    pub mint: Account<'info, Mint>,

    /// CHECK: optional validator pubkey to pin the rollup to. When unset
    /// the Magic Router picks the closest one.
    pub validator: Option<AccountInfo<'info>>,
}

pub fn handler(ctx: Context<DelegateVault>) -> Result<()> {
    let validator = ctx.accounts.validator.as_ref();
    let mint_key = ctx.accounts.mint.key();
    ctx.accounts.delegate_vault(
        &ctx.accounts.payer,
        &[VAULT_SEED, mint_key.as_ref()],
        DelegateConfig {
            validator: validator.map(|v| v.key()),
            ..Default::default()
        },
    )?;
    Ok(())
}
