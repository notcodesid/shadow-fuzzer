use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::error::VaultError;
use crate::state::{UserPosition, Vault, POSITION_SEED, VAULT_AUTHORITY_SEED};

#[derive(Accounts)]
pub struct Withdraw<'info> {
    // ─── BUG #2: no signer / has_one constraint on `owner` ───────────────
    // `owner` is read-only and unchecked. The instruction doesn't enforce
    // that the transaction is signed by `owner`, nor that `owner.key()`
    // matches `position.owner`. An attacker passes a victim's `position`
    // PDA, the victim's pubkey as `owner`, and their own `recipient_token_
    // account` — and walks away with the funds. A correct implementation
    // would either mark `owner: Signer<'info>` or add `has_one = owner`
    // plus a manual `position.owner == owner.key()` check.
    /// CHECK: deliberately unchecked — see comment block above.
    pub owner: UncheckedAccount<'info>,
    // ─────────────────────────────────────────────────────────────────────

    #[account(mut)]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [POSITION_SEED, vault.key().as_ref(), owner.key().as_ref()],
        bump = position.bump,
    )]
    pub position: Account<'info, UserPosition>,

    #[account(mut, address = vault.vault_token_account)]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// CHECK: PDA, validated by seeds.
    #[account(
        seeds = [VAULT_AUTHORITY_SEED, vault.key().as_ref()],
        bump = vault.vault_authority_bump,
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut, token::mint = vault.mint)]
    pub recipient_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    require!(amount > 0, VaultError::ZeroAmount);
    require!(
        ctx.accounts.position.balance >= amount,
        VaultError::InsufficientBalance
    );

    let vault_key = ctx.accounts.vault.key();
    let bump = ctx.accounts.vault.vault_authority_bump;
    let signer_seeds: &[&[&[u8]]] = &[&[VAULT_AUTHORITY_SEED, vault_key.as_ref(), &[bump]]];

    let cpi_accounts = Transfer {
        from: ctx.accounts.vault_token_account.to_account_info(),
        to: ctx.accounts.recipient_token_account.to_account_info(),
        authority: ctx.accounts.vault_authority.to_account_info(),
    };
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        ),
        amount,
    )?;

    let position = &mut ctx.accounts.position;
    position.balance = position.balance.saturating_sub(amount);

    let vault = &mut ctx.accounts.vault;
    vault.total_deposits = vault.total_deposits.saturating_sub(amount);

    Ok(())
}
